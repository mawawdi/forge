# CoreLoopBench and Verification Evals

Status: M1, M1.5, M2, M2.5, M3, and M3.25 complete; M3.5 next
Purpose: executable evidence for verified Roblox mechanic generation

## M3.25 acceptance addition

The initial prompt-to-proof case starts from a clean CollectFruit seed and
records strict intent/proposal validation, policy rejection, static/M2 result,
and PatchSet hash before using the existing seven M3 runtime assertions. Test
doubles can exercise compilation, but acceptance requires an OpenRouter-produced
candidate to pass the real Studio gate twice from fresh seeds without manual
source edits. That condition is met by two authoritative `collect-fruit-v7`
runs of PatchSet `patch_generated_f3213dc3e71fe0050d4e19a2`; the final run is
captured by ProofBundle `proof_932e3d0abd04b04894b38e73` and BuildTrace
`trace_596ab00b-5087-449b-8e33-a0ae0f5aee2e`.

The exact first Luna candidate is also a permanent diagnosis regression. The
fixture must retain byte-identical model-authored source and the historical run,
attempt, response, PatchSet, and trace references. Its corrected local result is:

- official Luau syntax: pass;
- Roblox-aware type analysis: pass;
- remote path and positional ABI: pass;
- applicable validation/authority checks: pass;
- exact implementation constant: fail (`max_interaction_distance` observed
  `12`, required `20`).

This case proves both sides of the gate: verifier/tooling false positives must
be removed, while a genuine model-authored interface divergence must remain a
blocking rejection. It is not eligible for StudioProof and must not be repaired
by substituting a deterministic complete CollectFruit implementation.

The repair-only regression requires exactly one provider request whose purpose
is `repair`; zero intent or initial-patch requests are allowed. Tests require
the immutable source hashes to survive both a successful repair and a repair
that retains the defect. The repaired output must be outside the seed and
regression, and a failed repair must remain rejected before Studio.

## 1. Evaluation philosophy

CoreLoopBench measures whether a proposed mechanic satisfies its contract in the target environment. It does not primarily measure code style, token count, or an LLM judge’s opinion.

The evaluation hierarchy is:

1. schema and contract invariants;
2. official Luau parse/type/lint;
3. Forge semantic replication/security analysis;
4. deterministic pure Luau/Lute/Lune preflight;
5. Roblox Studio execution for authoritative runtime facts;
6. optional human creator acceptance as product feedback.

M1 and M2 execute the first three layers locally. M2 records a static/semantic ProofBundle and deterministic repair but still leaves preflight and Studio `not_run`. M3 is the first milestone that can claim Studio-backed runtime proof.

M3 accepts Studio evidence only from the Forge Studio Plugin's validated protocol and a real Studio test session. A mock bridge, MCP-only result, pure Luau runtime, or successful plugin HTTP response cannot satisfy an authoritative assertion.

## 1.1 Trace, proof, regression, and experiment relationship

`BuildTrace` records an execution and its objective outcome dimensions. `ProofBundle` compacts the evidence for a verification/commit decision. A CoreLoopBench case is a reusable fixture with expected assertions. `ExperimentResult` later records one candidate configuration's result against a fixed case/dataset. They must link by IDs/hashes instead of copying raw source or every historical event into each object.

A build trace is eligible for promotion only when it has sufficient retained references to reproduce the task: minimized intent/contract references, starting snapshot reference and hash, failure evidence, assertion/adversarial sequence, toolchain/environment versions, and seed when applicable. M1.5 records the trace foundation; M2 adds contract and patch references; M2.5 adds canonical semantic snapshot hashes and context composition metadata. None of these milestones claims a trace can yet be promoted or replayed exactly.

## 2. Fixture contract

Every benchmark case is a directory with a manifest like this:

```ts
interface CoreLoopBenchCase {
  id: string;
  title: string;
  category: "acquisition" | "conversion" | "progression" | "networking" | "persistence" | "ui_state" | "physics" | "repair";
  initialProject: string;
  creatorRequest: string;
  mechanicContract: string;
  allowedPatchOperations: string[];
  visibleAssertions: string[];
  hiddenAssertions: string[];
  adversarialInputs: string[];
  requiredTiers: Array<"static" | "preflight" | "studio">;
  maxRepairAttempts: number;
  maxWallClockMs: number;
  maxVariableCostUsd?: number;
}
```

The fixture also records expected observable behavior, performance budget, toolchain version, and an input hash. Hidden assertions must not be sent to the generation model. A case is verified only if every required assertion passes and no blocking issue remains.

## 3. Initial 10 cases

These are the smallest useful seed set, not the final 150-case benchmark described in the research.

| ID | Case | Contract under test | Adversarial/hidden focus | Required tier |
| --- | --- | --- | --- | --- |
| CLB-001 | Collect fruit | An interaction adds exactly one server-calculated fruit to the player inventory and removes/marks the fruit exactly once | spoofed fruit ID, repeat request, client-supplied amount, wrong player ownership | static, preflight, Studio |
| CLB-002 | Sell inventory | Inside a sell zone, server converts inventory to coins, clears sold inventory, and computes value from server-owned definitions | negative/huge amount, outside-zone request, duplicate sell, client price | static, preflight, Studio |
| CLB-003 | Buy basket upgrade | Server checks cost and balance, atomically deducts currency, and increases capacity once | negative cost, double click, insufficient balance, client-set level | static, preflight, Studio |
| CLB-004 | Remote contract wiring | Every state-changing client request has one reachable server handler with validated direction and typed input | missing handler, wrong RemoteEvent path, client-only mutation, duplicate listeners | static, Studio |
| CLB-005 | Persistent progression | Server-owned coins/upgrades save and load through a test-safe persistence boundary without client DataStore access | malformed loaded data, duplicate save, production-store configuration, reconnect | static, preflight, Studio |
| CLB-006 | Inventory UI binding | UI displays replicated authoritative inventory and updates after collect/sell without becoming a source of truth | local spoofed count, stale event, wrong player binding, missing update | static, Studio |
| CLB-007 | Moving platform | A platform moves on a bounded path without unbounded connections/loops and remains playable in Studio | client-created motion, physics ownership edge, runaway heartbeat, collision failure | static, Studio |
| CLB-008 | Punch cooldown | Server validates target, range, damage, and cooldown before applying damage; knockout is observable | fire 1,000 requests, out-of-range target, client damage value, two-client race | static, preflight, Studio |
| CLB-009 | Repair insecure mechanic | Given a known client-controlled reward defect, produce a bounded repair that preserves the contract and removes the trust violation | repair changes unrelated files, leaves alternate exploit path, fixes text but not data flow | static, preflight, Studio |
| CLB-010 | Core-loop composition | Collect -> sell -> upgrade preserves state transitions and makes the next node reachable without regressions | cross-mechanic currency forgery, reset/reconnect, stale UI, partial commit after failed verification | static, preflight, Studio |

## 4. M1 fixture requirements

M1 does not need to execute every case. It must define all ten manifests and include a runnable insecure fixture that exercises the core static/semantic machinery.

`examples/insecure-tycoon` should contain, at minimum:

- a client script that sends a state-changing request with an untrusted reward/amount field;
- a server handler that incorrectly uses that field in an inventory/currency mutation;
- a valid control path showing the intended server-owned calculation;
- at least one real Luau parse or type failure;
- enough explicit project structure for the semantic map to connect script, remote, handler, and mutation;
- a fixture manifest declaring that Studio and preflight were not run.

The fixture is intentionally insecure. It is test input, not a recommended Roblox implementation.

## 5. Assertions and scoring

The primary score for a case is binary: all required deterministic assertions pass or the case fails. Secondary metrics explain the result:

```text
verified success rate = fully verified cases / attempted cases
first-pass rate       = cases verified without repair / attempted cases
repair efficiency     = failed cases repaired within budget / failed cases
exploit rejection     = malicious inputs safely rejected / malicious inputs attempted
```

Also record:

- issue count by severity and rule ID;
- static/preflight/Studio latency;
- model/tool calls and repair attempts;
- cost per attempt and cost per verified case;
- changed files/lines and rollback frequency;
- Studio frame/network observations when the case requires them.

Do not collapse these into one leaderboard score until the weighting is justified. A model that is cheap but creates a security-critical defect must not beat a slower model merely because it generated fewer tokens.

## 6. Determinism and reproducibility

Each result must record:

- initial project hash;
- source, structure, contract, and aggregate semantic snapshot hashes when a ProjectSemanticMap is available;
- patch hash;
- dependency/toolchain hash;
- rule-set hash;
- benchmark case ID and manifest hash;
- model/provider/configuration, if a model was used;
- Studio version/session seed, when Studio runs;
- normalized issue list and assertion observations.

Static and preflight runs with the same inputs must be byte-stable after removing explicitly excluded timestamps. Studio results should be reproducible under a pinned place, seed, version, and isolated data configuration; if they are not, the result is marked nondeterministic and cannot be used as a hard verified gate without further investigation.

For a retained model repair, generation and Studio execution are separate
observations. The repair eval records exactly one model call and the immutable
candidate artifact. The Studio eval must consume that artifact with zero model
calls, reject any changed seed/output source or rejected local report, rerun the
current local gate, and preserve the exact PatchSet identity in StudioProof.

## 7. Fault injection

Faults are real fixture mutations, not fake UI states. Initial fault classes:

- client supplies reward amount;
- server omits distance check;
- remote handler is unreachable;
- client accesses persistence API;
- duplicate event connection;
- upgrade deducts currency after granting the benefit;
- UI writes authoritative state.

Each fault must have a corresponding expected issue or failed assertion. A repair is successful only if the original fault is removed and the contract’s positive assertions still pass.

## 8. Hidden tests and benchmark hygiene

Visible fixtures are for debugging. Hidden assertions are for measuring generalization. Production failures, once privacy-reviewed and anonymized, should become new regression cases rather than edits to expected answers.

Do not use an LLM judge as the primary arbiter. A judge may classify explanations or assess creator-facing wording, but it cannot override a failed authority invariant or a failed Studio assertion.

## 8.1 Promotion and experiment policy

`Promote to CoreLoopBench` is an additive workflow, not a way to alter a historical result. A promoted regression preserves its source trace/build keys, failure taxonomy, expected safe behavior, observed unsafe behavior, and an explicit fixture version. A later invalidation requires a documented reason and leaves the historical record intact.

Experiments hold the benchmark case/dataset constant while varying a candidate configuration: model/version, prompt/context strategy, agent version, tools, verifier version, or repair policy. Report objective dimensions independently: verified completion, first-pass verified rate, security regression rate, deterministic repair share, retry rate, cost per verified mechanic, assertion pass counts, and latency. Do not hardcode model winners or an arbitrary composite score.

CI must fail for critical security regressions, reintroduced promoted exploits, and required parse/type regressions. Outcome/cost/latency policies are configurable thresholds to be set with data rather than invented during the candidate build.

## 9. Initial benchmark execution plan

1. M1: validate manifests and run static/semantic checks on local fixtures.
2. M2: add deterministic repair and static/semantic ProofBundle evidence for CLB-001 and CLB-009; preflight remains an explicit follow-on layer.
3. M2.5: use canonical semantic maps, affected cones, and explainable context selection for CLB-001 and CLB-009 without narrowing correctness checks unsafely.
4. M3: prove the full authoritative Studio pipeline on CLB-001 only, including its real client-controlled-reward fault and deterministic repair.
5. M4: make all ten cases executable, add hidden assertions, and compare model adapters.

The first benchmark report should include failures and tool-health errors, not only a success percentage. “Could not run” is operationally different from “ran and failed.”

## 10. Open evaluation questions

- Which post-CLB-001 mechanics need more than one simulated client in their Studio test plan?
- How should nondeterministic physics assertions be bounded and repeated?
- Which hidden assertions can be safely public in a candidate repository?
- What is the minimal exploit corpus that distinguishes semantic verification from pattern matching?
- How should creator acceptance be sampled without turning subjective preference into a security gate?
- Which OpenGameEval fixtures and runner components are reusable under their terms?
