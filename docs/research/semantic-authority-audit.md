# Semantic Authority Audit

Status: current research rationale for the implemented requirement/provenance boundary.

## Conclusion

Forge must distinguish what is known from why it is allowed to influence building or grading. Historical failures showed that collapsing fixtures, project facts, verifier assumptions, model plans, and evaluator expectations into one semantic layer creates false rejection, implementation leakage, and misleading blame.

The resulting primitive records five orthogonal dimensions:

```text
Requirement
  source       where the claim came from
  authority    what kind of claim it is
  visibility   who may see it
  enforcement  how strongly it gates
  evidence     why it is credible
```

This is harness metadata, not a game-mechanic ontology.

## Findings retained in the current system

- A project observation describes the before-state. It is not automatically an invariant; preservation requires an explicit, snapshot-backed `IntegrationConstraint`.
- Creator outcomes outrank agent design preferences, but cannot override universal platform/security policy.
- Agent plans are hypotheses and cannot declare themselves platform policy.
- Evaluator criteria and benchmark oracles may gate only their declared evaluation scope.
- Benchmark or evaluator bodies must not enter builder-visible context, tools, candidate source, public traces, or public proof content.
- Literal benchmark constraints and broader possible invariants are separate. An inferred generalization remains advisory until independent evidence supports a reviewed policy.
- Source and authority are immutable for one requirement identity. Any future promotion creates a distinct reviewed requirement with independent provenance.

## Failure-class separation

The audit was motivated by three recurring patterns in earlier work:

1. a language/tooling limitation was initially attributed to candidate source;
2. an evaluator or repair assumption about a positional interface overrode observed project compatibility;
3. a narrow benchmark path passed while a production-path trust issue remained unmeasured.

These are not interchangeable failures. Forge therefore keeps model, context, tool, harness, verifier, grader/evaluator, provider, environment, and task/specification classifications distinct.

## Current policy behavior

`resolveRequirementView` takes phase, environment, and audience and returns deterministic visibility and enforceability decisions. Visibility and enforcement remain separate: an internal security policy may gate without exposing implementation, while an evaluator-authored outcome may be builder-visible when intentionally declared so.

Benchmark oracles and evaluator-only material never enter builder views. Blocking platform policy requires independent policy provenance. Factual project observations require observation evidence. Hypotheses cannot block. Acceptance specifications contain references only and never embed hidden assertion bodies or expected values.

Conflict detection, temporal DSLs, confidence scoring, policy-promotion workflows, and a general semantic solver remain deliberately absent. Those abstractions require a concrete consumer and new evidence before they belong in Forge.
