# M4.0 Semantic Authority Audit

Date: 2026-08-30  
Baseline: `1b86da7fbb0f8ae46ec4022548e6c850096fd51d`  
Scope: implementation and retained M1–M3.5 evidence; no model call or Studio run

## Conclusion

The current Forge runtime is a coherent compiler-style historical slice, not a
general agent harness. It deterministically selects CollectFruit or
SellInventory, compiles an exact `MechanicImplementationSpec`, exposes that
spec and exact source bounds as required context, rejects patches outside the
declared targets, checks exact ABI/state/constants/order, executes a registered
mechanic harness, and attaches all required assertion results to a
ProofBundle.

That behavior is valid evidence for M1–M3.5 and must remain unchanged. It is
not evidence that every exact constraint is a universal production rule. The
implementation had no common object answering why a constraint was allowed to
guide generation, reject a candidate, or grade a run.

M4.0 adds that missing provenance seam beside the historical path. It does not
retrofit or reinterpret old verdicts.

## Audit method and unit

The audit traced every place where the M3.5 Collect+Sell slice can constrain a
candidate: intent compilation, semantic-map/spec compilation, context
selection, proposal validation, PatchSet eligibility, verifier gates, Studio
plan/protocol validation, and ProofBundle assembly. Code, fixtures, retained
proofs/traces, and research notes were read from the baseline above.

Counts below use one generated historical `Requirement` as the unit. The M3.5
adapter projects twenty-seven requirements: nine visible/internal semantic
families, four exact historical constraint families, and fourteen
identifier-only assertion references. An assertion ID is counted once; its
hidden body is not copied. Zero is a valid count.

### Source counts

| Source | Count | Real example |
| --- | ---: | --- |
| creator | 1 | collect then sell outcome retained in GameIntent |
| project_observation | 4 | remote identities, SellPrompt/radius, state representation, prior Collect proof binding |
| platform_policy | 3 | one blocking server-authority rule and two advisory generalization hypotheses |
| agent_plan | 0 | no durable M3.5 artifact distinguishes a model design decision from compiled Forge constraints |
| evaluator | 1 | the registered M3.5 Studio outcome criterion |
| benchmark_oracle | 18 | four exact constraint families plus fourteen registered assertion references |

### Authority counts

| Authority | Count | Real example |
| --- | ---: | --- |
| fact | 4 | observed project/snapshot state |
| policy | 2 | creator outcome and reviewed server-authority policy |
| hypothesis | 2 | bounded-capability and broader economic interpretations |
| evaluation_only | 19 | registered Studio criterion, exact fixture constraints, and fourteen assertion references |

### Visibility and enforcement counts

| Axis | Value | Count |
| --- | --- | ---: |
| visibility | builder_visible | 5 |
| visibility | evaluator_only | 18 |
| visibility | internal | 4 |
| enforcement | informational | 4 |
| enforcement | advisory | 2 |
| enforcement | blocking | 21 |

The two hypotheses are real interpretations surfaced by this audit. They are
not claimed as reviewed universal policy. No agent-plan example was invented
to fill the zero count.

## Actual enforcement flow

| Stage | Current enforcement point | What is authoritative in M1–M3.5 | Provenance gap before M4.0 |
| --- | --- | --- | --- |
| intent | `compileIntent` / `compileCoreLoopExtension` in `packages/intent` | Forge selects CollectFruit/SellInventory and authors contract semantics | creator text, Forge policy, and Forge design choices share one compiled artifact |
| semantic state | `compileMechanicImplementationSpec` in `packages/semantic-map` | manifest remote, ordered ABI, state bindings, constants, interaction, source targets | observed project facts and benchmark-prescribed interface are not distinguished |
| context | `DeterministicContextCompiler.compile` in `packages/context-compiler` | contract and implementation spec are required P0; exact allowed source and policy are included | any exact field can influence generation without a source/visibility record |
| proposal | proposal schema and `proposalPatchSet` in `packages/generation` | operation paths are enumerated from the mechanic generation policy | exact fixture allowlist looks like general game-building authority |
| patch eligibility | `applyPatchSet` plus candidate artifact validation | project hash, before hashes, path set, file/line/source bounds, required targets | capability policy and exact six-file benchmark scope are conflated |
| local gate | `verifyProject` in `packages/verifier` | manifest declarations, exact ABI/constants/state/order, Luau and semantic rules gate | legitimate platform rules coexist with mechanic/name-specific fixture prescriptions |
| Studio gate | `collectSellTestPlan`, harness registry, protocol correlation | exact fourteen assertion bodies and exact harness hash/version | evaluator implementation and high-level acceptance outcome are one plan object |
| proof gate | `assembleStaticSemanticProof` and `attachStudioProof` | local pass plus complete authoritative assertion set determines verified/rejected/incomplete | ProofBundle records what passed, not why each requirement was allowed to gate |

The M4.0 package is not imported at any one of these points. The table is a
classification of historical behavior, not a runtime migration.

## Constraint classification

| Historical constraint | Literal classification | Evidence | Enforcement today | Broader interpretation | M4.0 treatment |
| --- | --- | --- | --- | --- | --- |
| creator wants collection and conversion | creator policy, desired after-state | GameIntent/request hash | intent, contract, Studio outcome | none required | builder-visible blocking outcome |
| `ReplicatedStorage/Remotes/*` identities | observed before-state and explicit historical integration fact | manifest + ProjectSnapshot | spec, context, verifier | existing public identity may need preservation | informational fact plus explicit IntegrationConstraint |
| `Workspace/SellZone/SellPrompt`, radius 12 | observed before-state and production interaction fact | manifest instance and snapshot | context, interaction verifier, Studio production path | explicit user action may be a reusable outcome | fact/integration constraint; do not promote ProximityPrompt as universal design |
| Inventory/Coins attributes and UnitPrice | observed before-state plus historical integration fact | manifest/state bindings/snapshot | spec, context, verifier | server-owned authoritative state is the general trust concern | fact/integration constraint; separate blocking platform authority policy |
| server owns reward/payout/currency mutation | general platform/trust policy | reviewed Forge/Roblox authority policy | semantic verifier and Studio adversarial cases | applies by dataflow, not mechanic name | internal blocking policy |
| exact zero-argument Sell ABI | literal historical benchmark/evaluation constraint | manifest/spec and registered fault fixture | proposal, verifier, Studio | client cannot control economic value | hidden evaluation constraint; broader trust rule is separately evidenced |
| exact 20-stud authorization threshold | literal historical benchmark constraint | implementation spec and plan | context, constant verifier, Studio | server validates applicable interaction context | hidden evaluation constraint; do not make 20 universal |
| exact six source files and numeric bounds | literal M3.5 generation scope | generation policy | schema, PatchSet and artifact eligibility | agent capabilities should be bounded to authorized workspace scope | hidden exact constraint plus advisory capability hypothesis |
| Inventory cleared before Coins credited, no yield | literal implementation/order constraint | implementation spec and verifier | economy verifier and Studio expected transitions | no duplicate value or partial invalid economic transition | hidden exact constraint plus advisory economic hypothesis |
| fixed assertion values/actions/adversarial inputs | benchmark oracle | registered StudioTestPlan and harness | Studio protocol and ProofBundle | outcome-level properties may generalize | retain in evaluator only; AcceptanceSpec references IDs |
| prior Collect proof/source hashes | observed regression linkage | manifest generation target and ProofBundle ID | context, plan regression binding, candidate artifact | verified history must not be rewritten | internal fact/integration constraint |

The exact constraint and any plausible broader invariant are separate records.
The broader interpretation does not inherit platform-policy authority merely
because it sounds sensible.

## Leakage boundary

The existing `StudioTestPlan` necessarily contains actions, expected values,
adversarial cases, and assertion bodies because it is an evaluator artifact.
The existing Studio harness contains the executable mechanics. Neither is safe
builder context.

The historical adapter therefore emits one evaluator-only Requirement per
assertion with a generic statement and a fixture hash, then records all
fourteen assertion IDs in `AcceptanceSpec`. It does not copy the assertion
name, action, observation, expected value, adversarial input, or harness source.
Builder selection omits the hidden Requirement statement and evidence. The
hidden requirement ID is also replaced with an opaque decision ID. The original
Studio artifacts remain the sole bodies/oracles.

## Conflict and temporal findings

Facts do not “win” a desired change. They describe current reality.

```text
observed_before: SellPrompt exists at the recorded snapshot
desired_after:   creator requests a UI button instead
```

Those statements can both be true. If verified callers depend on SellPrompt,
Forge must create an explicit integration constraint or migration task. It
must not erase the observation or silently reinterpret it as timeless policy.

Similarly, creator preference cannot override the reviewed server-authority
policy; agent design is subordinate to creator outcomes; evaluation-only
criteria gate only evaluation; benchmark oracles gate only their benchmark.
M4.0 documents these rules and tests scope selection, but does not parse
semantic contradictions or generate migrations.

## Failure stories supporting the pivot

### Host-less Luau false rejection

The first Luna candidate was valid Roblox Luau, but nine historical diagnostics
came from running `luau-analyze` without Roblox host declarations. The
unchanged candidate still had a real exact-interface mismatch (`12` versus
the fixture's `20`). Treating the low score as “model failure” would have
conflated environment/tooling failure with a separate model/interface defect.

### Name-based ABI correction

The old verifier inferred remote semantics from a local parameter name and a
flat validation-name list. The corrected system binds client and server roles
by position/dataflow, including Roblox's server-supplied Player. Local spelling
is not protocol identity. This is a verifier/harness correction preserved as a
regression, not a rewritten historical verdict.

### Sell production-path blind spot

A Sell client could use Heartbeat to repeatedly call the RemoteEvent while the
server remained secure. The old harness happy path bypassed the production
client initiation, so runtime assertions could miss the wrong interaction.
The fix added explicit observed interaction evidence and made happy-path Studio
execution call the production action module. This was a harness/eval defect,
not merely model behavior.

Together these cases require root-cause classification across model, context,
tool, harness, verifier, grader/eval, environment/infrastructure, and
task/specification. A gate is trustworthy only to the extent its provenance and
evidence boundary are explicit.

## M4.0 result and remaining gap

The implementation now provides runtime-validated contracts, deterministic
serialization/hashing, identity immutability checks, one visibility/enforcement
resolver, explicit integration references, and the isolated M3.5 projection.
Focused tests cover malformed shapes, evidence alignment, leakage, precedence,
two equally valid door plans, all fourteen assertion references, and immutable
harness registry/hash values.

Still deferred:

- BuildPlan and tool-using builder integration;
- semantic contradiction detection or temporal DSL;
- policy-promotion workflow;
- general Studio action/observation capabilities;
- hidden benchmark runner/process isolation;
- model experiments or unseen-game trials.
