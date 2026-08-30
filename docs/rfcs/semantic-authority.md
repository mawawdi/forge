# RFC: Semantic Authority and Requirement Provenance

Status: Accepted for M4.0  
Date: 2026-08-30  
Implementation: `packages/semantic-authority`

## Decision

Forge will represent any requirement that may affect generation, rejection, or
grading with five independent axes and source-aligned evidence:

```text
Requirement
├── source       where the claim came from
├── authority    what kind of claim it is
├── visibility   who may see it
├── enforcement  how strongly it may gate
└── evidence     why the source attribution is credible
```

This is a harness primitive, not a game-mechanics ontology. It does not define
doors, rounds, fruit, economies, combat, or an implementation architecture.

M4.0 adds the primitive beside the M1–M3.5 compiler-style vertical slice. It
does not connect it to generation, the Context Compiler, verification,
StudioProof, or ProofBundle assembly.

## Context

M1–M3.5 proved a valuable trust boundary by compiling exact
`MechanicContract`, `MechanicImplementationSpec`, PatchSet, verifier, and
Studio assertion artifacts for CollectFruit and SellInventory. Those exact
objects remain historical regressions and existing-project integration tools.

They are not a scalable source of production semantics for arbitrary games.
Without explicit provenance, a benchmark constant, a discovered project fact,
a creator outcome, and a universal Roblox security rule can all look like the
same hard constraint. That makes it easy to reject a valid novel design or to
leak a hidden benchmark answer into builder context.

## Public contracts

The source, authority, visibility, enforcement, and verification axes are:

```ts
type RequirementSource =
  | "creator"
  | "project_observation"
  | "platform_policy"
  | "agent_plan"
  | "evaluator"
  | "benchmark_oracle";

type RequirementAuthority =
  | "fact"
  | "policy"
  | "hypothesis"
  | "evaluation_only";

type RequirementVisibility =
  | "builder_visible"
  | "evaluator_only"
  | "internal";

type RequirementEnforcement =
  | "informational"
  | "advisory"
  | "blocking";

type RequirementVerificationMode =
  | "schema"
  | "static"
  | "preflight"
  | "studio"
  | "evaluator"
  | "human";
```

`Requirement` also contains an immutable ID, a statement, one or more
verification modes, and one or more evidence references. Evidence is a
discriminated union aligned to the source: creator request, project
observation, policy reference, agent decision, evaluation specification, or
benchmark fixture. Evidence carries IDs, locators, and content hashes rather
than copying raw prompts, source, evaluator logic, or oracle values.

`RequirementSet` owns unique requirements in canonical ID order. Its ID and
hash are derived from canonical serialized content. Verification modes and
evidence references are also canonical and unique.

`AcceptanceSpec` is references-only. It contains requirement, assertion, and
artifact IDs. Its exact runtime shape cannot contain assertion bodies,
adversarial inputs, expected observations, grader source, or golden source.

`IntegrationConstraint` is created explicitly from one evidenced
`project_observation`/`fact` requirement and the matching project ID and
snapshot hash. Observing something does not create an integration constraint
automatically.

## Runtime invariants

M4.0 validates only high-confidence rules:

- evidence kind must match requirement source;
- benchmark oracles must be `evaluation_only` and `evaluator_only`;
- project observations must be facts with matching observation evidence;
- agent-plan requirements remain hypotheses and cannot block;
- hypotheses cannot block;
- platform-policy requirements are policies or advisory hypotheses;
- a blocking platform policy must cite an independent policy ID and document
  hash rather than citing the requirement itself;
- all cross-references and project/snapshot bindings must resolve;
- canonical IDs, ordering, serialization, and hashes must validate.

These rules deliberately do not infer whether two free-text statements
contradict each other.

## Visibility and enforcement policy

One API selects every consumer view:

```ts
resolveRequirementView(requirementSet, {
  phase: "build" | "evaluate",
  environment: "production" | "benchmark",
  audience: "builder" | "evaluator" | "internal",
});
```

It returns one deterministic decision per requirement. A visible decision
contains the Requirement and requirement ID. A withheld decision contains only
an opaque deterministic decision ID, decision flags, and policy reason
codes—not the requirement ID, statement, or evidence. Visibility and
enforcement are independent.

| Scope | Visible material | Enforceable material |
| --- | --- | --- |
| production build / builder | builder-visible non-oracle requirements | visible non-informational requirements plus blocking internal platform policy; evaluation-only criteria do not gate build |
| production evaluation / evaluator | builder-visible and evaluator-only non-oracle requirements | applicable non-informational requirements plus blocking internal platform policy |
| benchmark build / builder | same safe builder material as production build | same policy; benchmark oracles remain withheld and unenforceable |
| benchmark evaluation / evaluator | builder-visible, evaluator-only, and benchmark-oracle requirements | applicable non-informational requirements plus blocking internal platform policy |
| internal | all non-oracle material; oracle material only during benchmark evaluation | the same scope rules, with internal details available |

An evaluator-created outcome may therefore be builder-visible without exposing
a hidden assertion. An internal security policy may gate a builder candidate
without exposing verifier implementation. A benchmark oracle never becomes
visible or enforceable in a builder view.

`informational` records facts or context without a gate. `advisory` may inform
planning or evaluation but cannot claim a hard verdict. `blocking` can gate
only when the consumer scope is allowed to enforce the requirement.

## Conflict and precedence semantics

M4.0 records deterministic precedence rules but does not implement a semantic
conflict solver:

1. A validated universal platform policy cannot be overridden by a creator
   request, evaluator interpretation, or agent preference.
2. A creator requirement outranks an agent design preference.
3. An agent-plan hypothesis may be checked for coherence and outcome, but it
   is not universal truth and does not hard-gate another valid implementation.
4. An evaluation-only criterion gates only its evaluation scope.
5. A benchmark oracle has authority only inside its benchmark evaluator.
6. A project observation is a description of known state, not an automatic
   preservation instruction.

Because M4.0 has no contradiction parser, the resolver preserves all
independently applicable requirements. For example, a creator request for
client-controlled currency does not remove the blocking server-authority
policy. A later consumer may diagnose the conflict and ask for repair or
clarification; it may not silently discard the policy.

## Temporal semantics

Requirements need temporal interpretation even though M4.0 adds no temporal
DSL:

- `observed_before` — evidence about the project snapshot before mutation;
- `desired_after` — creator or accepted evaluator outcome requested after the
  change;
- `invariant_during` — a property that must hold through mutation or runtime;
- `evaluation_expected` — an outcome checked only by an evaluation scope.

These labels are conceptual in M4.0. A statement that `SellPrompt` exists in
the observed snapshot and a request to replace it with UI are not
contradictory. The former remains truthful evidence; the latter describes the
desired after-state. If existing behavior must be preserved, the harness must
create an explicit integration constraint instead of pretending the
observation itself was timeless.

## Identity and future promotion

Source and authority are immutable for a requirement ID. Revision comparison
fails if either changes in place.

M4.0 adds no agent-plan-to-platform-policy promotion API. Any future promotion
must create a distinct requirement with a new ID, independent reviewed policy
provenance, regression evidence, and an auditable link to the earlier
hypothesis. The review and promotion workflow is deferred until repeated
failures create a real consumer.

## Historical M3.5 projection

`packages/semantic-authority/src/m3.5.ts` is an explicitly historical adapter.
It accepts validated, already-loaded M3.5 manifest, intent, loop, contracts,
implementation specs, generation policies, snapshot, Studio plan, and policy
reference. It produces:

- a provenance-classified RequirementSet;
- four explicit project-backed integration constraints;
- a references-only AcceptanceSpec containing all fourteen assertion IDs;
- hashes and IDs linking the source artifacts.

The adapter classifies the exact zero-argument Sell ABI, 20-stud authorization
threshold, six-file source allowlist, clear-then-credit order, and registered
assertion conditions as historical benchmark/evaluation constraints. It keeps
the 12-stud SellPrompt, remote identities, state representation, and prior
Collect proof linkage as observed project facts. Server-owned authority is a
blocking platform policy. Bounded capabilities and non-duplicating/partial
economic transitions are advisory hypotheses, not promoted policies.

The adapter copies no Studio assertion bodies, action details, adversarial
values, expected observations, or harness source. It references their IDs and
the existing evaluator artifacts. It is not imported by the M1–M3.5 runtime.

## Consequences

Benefits:

- exact benchmark constraints cannot silently become production semantics;
- hidden evaluation material has an explicit leakage boundary;
- existing-project facts remain useful without becoming timeless design law;
- greenfield implementations are not rejected for differing from a Forge
  preference;
- provenance, selection, and hashing can be tested without a model or Studio.

Costs and limitations:

- free-text conflicts are documented but not detected;
- the layer does not yet drive context, tools, verification, or grading;
- no confidence score, temporal DSL, BuildPlan, migration plan, policy
  promotion workflow, or game ontology exists;
- the M3.5 projection is evidence about one historical slice, not a template
  for future mechanics.
