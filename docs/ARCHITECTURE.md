# Forge Architecture

## Architectural stance

Forge is an evidence harness around agents, not a game-mechanic compiler. It
preserves the M1–M3.5 compiler-style vertical slice as historical regression
coverage while adding a general agent-harness seam beside it.

```text
                         preserved historical path
creator -> exact contract/spec -> PatchSet -> verifier -> StudioProof

                         post-M3.5 path
creator + RequirementSet -> builder view -> bounded agent tools
  -> isolated candidate workspace -> independent local gate
  -> future Studio capabilities / evaluator -> evidence and regression
```

Neither path may turn missing evidence into a passing claim.

## Current component boundaries

| Component | Owns | Does not own |
| --- | --- | --- |
| `contracts` | Shared deterministic shapes, hashes, BuildTrace references | Game semantics for new mechanics |
| `semantic-authority` | Requirement provenance, visibility, enforcement, scoped views | Contradiction solving or policy promotion |
| `semantic-map` | Project observation and canonical snapshots | Timeless preservation policy |
| `context-compiler` | Historical deterministic context and M4.1 source-free orientation | A complete agent prompt or retrieval system |
| `verifier` | Luau/tooling and modeled static/semantic policy | Roblox engine truth |
| `studio-proof` and plugin | Correlated real-Studio historical execution | Arbitrary game testing |
| `agent-runtime` | Candidate isolation, capability policy, tools, AgentRun, budgets, final local gate | Provider SDKs, mechanic adapters, Studio harnesses |
| `agent-claude` | One locked-down Claude SDK adapter | Core runtime contracts or authority |

The runtime boundary is structural: generic agent packages cannot import
historical mechanic adapters, fixtures, benchmark implementations, repair
solutions, PatchSet machinery, or Studio harness registries.

## M4.1 builder boundary

An M4.1 build copies the seed into a candidate workspace. The seed is hashed
before and after the run. The agent can use only these Forge tools:

```text
project.list     project.search     project.read     project.inspect
plan.update      workspace.write    workspace.diff   forge.verify
```

Reads and writes are restricted to declared Luau roots. Fixture manifests,
Forge metadata, historical artifacts, credentials, hidden evaluator data, and
Studio harness sources are unavailable to the builder. Writes require a prior
BuildPlan and a current content hash.

The final verifier always runs after `WorkspaceDelta` freezes, whether or not
the agent used `forge.verify`. A local pass is `locally_eligible`, never
Studio-verified. M4.1 records `studio: not_run`.

## Authority and information flow

```text
RequirementSet --resolve(builder scope)--> visible requirements
ProjectSemanticMap -----------------------> source-free orientation
hidden evaluator/oracle ------------------> withheld

builder tools -> candidate workspace -> final local verifier
                                           -> BuildTrace + private AgentRun
```

`AcceptanceSpec` contains only references; it cannot carry hidden assertion
bodies, adversarial values, expected observations, grader source, or reference
solutions. See [semantic-authority.md](rfcs/semantic-authority.md).

## Identity, tracing, and privacy

`HarnessConfiguration` hashes the system prompt, versioned tool schemas and
descriptions, capability policy, orientation hash, requirement-view hash,
budgets, adapter version, and model configuration. This makes prompt or tool
description changes visible as harness changes.

The private mode-0600 `AgentRun` retains source-bearing tool results and the
full trajectory. `BuildTrace` retains only public references, hashes, and
normalized diagnostics. Historical traces and proof artifacts are never
rewritten when a later harness improves.

## Verification hierarchy

1. Schema validation proves data shape.
2. Official Luau and Roblox-aware analysis prove loaded language/host facts.
3. Forge static policy proves only explicitly modeled properties.
4. Pure-Luau preflight proves modeled execution, never Roblox behavior.
5. Real Roblox Studio proves engine/runtime behavior.
6. Evaluator or human signal addresses subjective product judgment only.

Unknown remains incomplete. An evaluator cannot override a failed deterministic
security or runtime invariant.

## Detailed records

- [M4.1 bounded builder RFC](rfcs/m4.1-bounded-builder.md)
- [Semantic authority RFC](rfcs/semantic-authority.md)
- [Studio plugin protocol RFC](rfcs/studio-plugin-protocol.md)
- [M3 real Studio evidence](research/m3-real-studio-runs.md)
- [M4.0 authority audit](research/m4-semantic-authority-audit.md)

The older RFCs document preserved implementation decisions. They are not a
second product specification.
