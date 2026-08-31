# Forge Architecture

This is the canonical architecture document for Forge. It separates the implemented system from an immediate, completed harness correction and the longer-term product direction. [FORGE.md](FORGE.md) defines the thesis and non-goals; [EVALS.md](EVALS.md) defines what the system may claim; [ROADMAP.md](ROADMAP.md) records demonstrated evidence and next work.

## Status legend

- **Implemented** means the boundary exists in the current repository.
- **Demonstrated** means a local test or creator-run Studio canary established the stated evidence; it does not imply a broader claim.
- **Goal** means an intended architecture component that is not implemented or authorized as current behavior.

## Current implementation

The current build path begins with scoped authority, gives the builder only sanitized facts and bounded capabilities, then independently verifies and seals a candidate. Runtime evaluation is a separate, evaluator-controlled path: Studio observes facts, and backend code grades them.

```mermaid
flowchart TB
    creator[Creator request] --> requirements[RequirementSet]
    requirements --> view[Builder-visible RequirementView]
    project[Observed project and declared source roots] --> orientation[AgentOrientation v2]
    view --> orientation
    registration[ExperimentRegistration v1] --> preflight[Orchestrator-only registration preflight]

    subgraph builder[Builder-visible bounded build]
        orientation --> runtime[ForgeNativeAgentRuntime]
        preflight -. expected hashes checked before provider .-> runtime[ForgeNativeAgentRuntime]
        runtime --> transport[ModelClient.complete: one turn]
        transport <--> provider[OpenRouter through AI SDK Core]
        runtime --> tools[Eight Forge-owned tools]
        tools <--> workspace[Isolated CandidateWorkspace]
        workspace --> plan[Agent-owned BuildPlan]
        workspace --> delta[Frozen WorkspaceDelta]
        delta --> verifier[Independent local verifier]
        verifier --> candidate[WorkspaceCandidateArtifact]
    end

    subgraph evaluation[Evaluator-controlled runtime evaluation]
        private[Evaluator-only criteria] --> definition[RuntimeEvalDefinition]
        registration -. evaluator artifacts stay outside builder .-> definition
        definition --> execution[Redacted StudioExecutionPlan]
        candidate --> execution
        execution --> bridge[Studio bridge and protocol v12]
        bridge --> plugin[Forge Studio plugin 8.0.0]
        plugin --> observations[Factual runtime observations]
        observations --> grader[Backend-only grading]
        grader --> proof[RuntimeProofBundle]
    end

    runtime --> trace[AgentRun and BuildTrace]
    verifier --> trace
    grader --> trace
    private -. never exposed to builder .-> runtime
    registration -. never exposed to builder or model .-> transport
    private -. assertions never enter Studio .-> plugin
```

The builder receives the canonical, sorted `orientation.content.sourceRoots` facts before its first turn. It may use them only as candidate-relative prefixes for `workspace.write`; the workspace still enforces traversal, symlink, extension, stale-hash, absent-file, and budget protections.

### Current implementation inventory

| Boundary | Implementation | Entry point or evidence object | Status |
| --- | --- | --- | --- |
| Requirement authority | `semantic-authority`, `semantic-map`, `context-compiler` | `RequirementSet`, `RequirementView`, `AgentOrientation` | Implemented |
| Bounded build loop | `agent-runtime` | `forge agent build`, `HarnessConfiguration`, `AgentRun`, `BuildPlan`, `WorkspaceDelta` | Implemented |
| Registered experimental treatment | `experiments` | `forge experiment register`, `ExperimentRegistration`, `forge experiment build` | Implemented; the frozen Vertical Shuttle registration yielded one locally eligible candidate and one exact registered runtime verdict |
| One-turn model transport | `model-client` | `ModelClient.complete`, isolated OpenRouter AI SDK Core adapter | Implemented |
| Local eligibility | `verifier`, `luau-toolchain` | `forge verify`, `VerificationReport` | Implemented |
| Sealed candidate | `agent-runtime` | `WorkspaceCandidateArtifact` | Implemented |
| Runtime observation | `studio-protocol`, `studio-bridge`, `studio-capabilities`, `studio-runtime`, plugin | `forge studio bridge`, protocol v12, plugin 8.0.0 | Implemented; bounded capability canary and one exact Vertical Shuttle evaluation demonstrated factual observations |
| Runtime grading and proof | `studio-capabilities`, `studio-runtime`, `proofs`, `flight-recorder` | `forge experiment evaluate`, `RuntimeProofBundle`, `BuildTrace` | Implemented; one exact Vertical Shuttle verdict is `runtime_verified`; no MovingPlatform candidate runtime verdict exists |

## Harness correction from the consumed trial

The sole MovingPlatform model trial is preserved as `incomplete / agent_failure`; it is not retried or reinterpreted. The regression below demonstrates the correction with a fake provider and a dedicated empty-root fixture, not with a model or Studio run.

```mermaid
sequenceDiagram
    participant Forge as Forge runtime
    participant Workspace as Candidate workspace
    participant Model as Builder model
    participant Tools as Bounded tools
    participant Verify as Local verifier

    Forge->>Workspace: Copy seed and read canonical source roots
    Forge->>Model: Initial orientation with sourceRoots: [src/server]
    Note over Model: No host paths, evaluator bodies, or fixture internals
    Model->>Tools: plan.update
    Model->>Tools: workspace.write src/server/Bootstrap.server.luau
    Tools->>Workspace: Enforce candidate-relative root and absent precondition
    Model->>Tools: forge.verify
    Tools->>Verify: Verify isolated candidate
    Verify-->>Tools: locally_eligible feedback
    Forge->>Workspace: Freeze delta and run independent final verification
    Forge-->>Model: Candidate sealed as WorkspaceCandidateArtifact
    Note over Forge,Model: Historical pre-fix trial lacked sourceRoots in orientation and ended incomplete, no retry occurs.
```

The deterministic regression records these identities for the corrected empty-root treatment:

- orientation content hash: `292532c19fd966796c62c6af4ef0e4d6ebd298c9e3bd645ad197064424d1ffbd`;
- ordered tool-description hash: `b84ebc2580666fb7c8711d9d81ad08525b72b9b1ad2b29641d92ef9df0a72d8b`;
- harness configuration: `harness_configuration_9c8fa37507f13c2a7f8aa837` / `9c8fa37507f13c2a7f8aa837167bf668ba5f48a9608a8229480de75028731f98`.

## Long-term product goal

The goal is a longer-horizon Forge harness, not a return to a mechanic compiler. The components below are architectural targets only; none grants a present capability, changes the semantic-authority boundary, or authorizes new model or Studio runs.

```mermaid
flowchart TB
    creator[Creator intent] --> agent[Planner and builder agent]
    agent --> buildplan[Outcome-oriented BuildPlan]

    subgraph harness[Goal: long-horizon Forge harness]
        projecttools[Project and source tools]
        studioptools[Generic Studio tools]
        assettools[Asset tools]
        checkpoints[Checkpoints and bounded recovery]
        budgets[Budgets and stop conditions]
    end

    buildplan --> harness
    harness --> candidate[Incremental candidate state]
    candidate --> bus[Verification bus]

    subgraph verification[Goal: evidence by claim type]
        static[Syntax, types, structural integrity, authority]
        runtime[Runtime observations and backend assertions]
        adversarial[Adversarial and security checks]
        qualitative[Visual or gameplay evaluator]
        human[Creator or human product signal]
    end

    bus --> static
    bus --> runtime
    bus --> adversarial
    bus --> qualitative
    bus --> human
    static --> feedback[Pass or bounded feedback]
    runtime --> feedback
    adversarial --> feedback
    qualitative --> feedback
    human --> feedback
    feedback --> repair[Agent repair or checkpoint]
    repair --> candidate

    feedback --> recorder[Flight recorder]
    recorder --> miner[Failure mining]
    miner --> review[Reviewed regression]
    review --> experiments[Model and harness evaluation]
```

The verification bus preserves the existing authority model: deterministic checks establish only modeled properties, runtime systems return observations rather than verdicts, qualitative assessment remains distinct from deterministic grading, and creator satisfaction remains a product signal rather than an engine fact.

## Horizon comparison

| Concern | Current implementation | Immediate correction | Goal |
| --- | --- | --- | --- |
| Builder context | Sanitized requirements, project facts, and canonical source roots | Demonstrated with an empty source root | Richer bounded project, Studio, asset, and checkpoint capabilities |
| Agent loop | Native Forge-owned multi-turn runtime with one-turn transport | Same runtime identity with corrected capability disclosure | Longer-horizon, outcome-oriented iterative work |
| Verification | Local verifier plus three generic runtime observation capabilities | Local candidate sealing is regression-tested | Verification bus spanning deterministic, runtime, adversarial, qualitative, and human signals |
| Runtime authority | Plugin returns bounded facts; backend grades | No Studio run performed | Same separation retained as capabilities broaden |
| Learning loop | Build traces, preserved failures, and hash-locked registrations | Vertical Shuttle is prepared as a new registered treatment | Failure mining and reviewed regression-driven model/harness experiments |

## Architectural invariants

- The evaluated unit is model plus harness plus tools plus environment plus evaluator configuration.
- Forge owns turn control, tool dispatch, workspace access, budgets, stopping, final local verification, and evidence; providers remain one-turn transports.
- A registered experiment binds its task, seed, source roots, implementation snapshot, model transport, budgets, evaluator configuration, orientation, tool descriptions, and harness configuration before its first provider envelope. Its private evaluator artifacts never enter builder context.
- Builder-visible inputs never include evaluator bodies, benchmark oracles, hidden thresholds, runner source, secrets, or private runtime observations.
- Studio executes canonical data plans through fixed trusted code and returns factual observations only; no arbitrary Luau, callbacks, expressions, or property access enter the plugin boundary.
- `eligible`, `locally_eligible`, `rejected`, `incomplete`, and `runtime_verified` retain the meanings defined in [EVALS.md](EVALS.md).
- Obsolete mechanic compilers, PatchSets, provider-owned loops, mechanic-specific Studio harnesses, and deleted packages are not part of this architecture.
