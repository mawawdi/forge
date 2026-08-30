# RFC: Model Generation Boundary

Status: historical M3.25 decision, preserved for regression; not the post-M3.5 default
Date: 2026-08-30

## Decision

Forge uses one configured OpenRouter model per build. The default is
`openai/gpt-5.6-luna`; `google/gemini-3.7-flash` is an explicit alternative.
There is no routing, fallback chain, agent swarm, or model-owned verifier.

The model has two strictly schema-constrained jobs: summarize a creator request
into an `IntentDraft`, then author exactly two complete source replacements in a
payload response which Forge stamps into a `ModelPatchProposal`. Forge compiles
the selected contract and current semantic map into a non-evictable
`MechanicImplementationSpec`. It owns remote identity/path/class, positional
ABI, state bindings, exact constants, applicable validation categories,
authority invariants, source targets, IDs, Studio assertion IDs, PatchSet
preconditions, project hashes, bounds, and commit eligibility. The model owns
the substantive implementation logic but cannot redefine those interfaces.

## Pipeline

```text
creator prompt
  -> strict IntentDraft -> Forge GameIntent/CoreLoop/MechanicContract
  -> Forge MechanicImplementationSpec + bounded semantic/source context + generation policy
  -> strict payload-only patch response -> Forge-stamped ModelPatchProposal -> Forge PatchSet compiler
  -> atomic local candidate -> official Luau + M2
  -> existing StudioProof -> ProofBundle -> commit or rollback
```

The clean seed is `examples/collect-fruit/generated-seed`. It contains a
pre-provisioned world and RemoteEvent but placeholder server/client source.
Generation may replace exactly the CollectFruit server and client source files.
No operation may write Forge/harness objects, Studio services, identity
attributes, `loadstring`, or paths outside the allow-list. Source is bounded to
two files, 240 added lines, 20 removed lines, and 24 KiB per replacement.

## Context, privacy, and authority

Intent generation receives no repository source. Patch generation receives the
Forge-owned contract, implementation spec, policy, complete allowed clean-seed
source, and the exact semantic remote neighborhood. Repair receives the same
immutable interface plus complete candidate source, candidate PatchSet, and
normalized ranged diagnostics/evidence. M3 harnesses, assertion bodies,
ProofBundles, reference solutions, and unrelated repository files are excluded.

Forge does not compile a classified mechanic into a known-good complete Luau
solution. Deterministic scaffolding ends at interfaces and structural
boilerplate; the canonical M3.25 acceptance candidate must remain model-authored.

## Preserved-candidate repair

`forge candidate repair <regression>` is distinct from `forge build`. It first
hash-validates and reverifies the immutable model candidate, then makes exactly
one structured `repair` request. It performs no intent call and no fresh initial
proposal. Context contains the original complete candidate, original PatchSet,
current ranged diagnostics, contract, implementation spec, semantic
neighborhood, and policy. The returned complete replacements are compiled into
a new PatchSet against the clean seed and materialized outside both seed and
regression.

The private repair artifact retains source generation, attempt, trace,
model-response, and PatchSet identities alongside the explicit new repair
request and response hashes. It also seals the seed/output paths, complete
bounded output-source hashes, contract, implementation spec, PatchSet, and
local verification report under one artifact hash. The new trace links the
source regression and original response through its references and includes
the repair hashes in the model configuration hash without storing source or
response bodies.

Generation and execution are separate commands. `candidate repair` never
connects to Studio. `candidate studio <artifact>` performs no model call; it
checks artifact integrity, exact seed before-state, exact repaired source,
contract/interface/PatchSet linkage, and a fresh current verifier run before
calling `runStudioPatchVerification`. Rejected, stale, or edited artifacts are
ineligible for Studio.

BuildTrace records model identity/configuration hashes, usage when supplied,
and context summary hashes, never raw prompt, source, credentials, or response.
The private local sibling `.forge-generation-runs` record is mode `0600`; it
must remain outside the seed so a generated candidate can never be mistaken for
part of its input project.

Static and M2 gates run before Studio. A passing retained candidate enters
`runStudioPatchVerification`, which accepts the prevalidated typed PatchSet but
uses the unchanged M3 transaction, evidence correlation, ProofBundle, and
commit/rollback semantics. Only real Studio execution establishes runtime truth.
