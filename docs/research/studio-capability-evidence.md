# Studio Capability Evidence

Status: protocol v12/plugin 8.0.0 is the current implementation, but no protocol-v12 Studio canary has run. The records below are predecessor protocol-v11 characterization evidence only.

This ledger records actual Studio observations, not local-test claims. It preserves the failure progression that justified the current position-integrity canary while making no current runtime verdict.

## Predecessor characterization

| Run | Result | Evidence and interpretation |
| --- | --- | --- |
| P0 | Completed transport; invalid observation substrate | `studio_capability_canary_6cc7b6a13534442a8a991cd4`, plugin 7.0.0, execution plan `studio_execution_plan_203a57180b4299bdd66058be`. Correlated execution returned `(0,0,0)` for both endpoints despite nonzero serialized locations, so it was never valid grading evidence. |
| P0.1 | Incomplete infrastructure result | `studio_capability_canary_b4a90f7cd7cbf4e623272366`, plugin 7.0.1, execution plan `studio_execution_plan_c3b2b9d70bf3caf7923a8103`. The plan armed and Play Solo started, but no correlated runtime envelope returned; the run remained a timeout/protocol failure, not candidate behavior. |
| P0.2 | Successful protocol-v11 capability characterization | `studio_capability_canary_7e4602dae1fc51b6023c987a`, plugin 7.0.2, execution plan `studio_execution_plan_7be78fcad2a0c9eab607f347`. EndpointA was observed at `(-12,4,0)`, EndpointB at `(12,4,0)`, and the stationary seed platform returned four bounded samples at `(-12,4,0)` over 1499 ms through correlated direct `EndTest`. |

P0.2 artifact SHA-256 is `36716e671a64ba15393ec7647e6ac0b750ab2a50d2b8026a2ddb03fd63293ee8`. Its preserved record and place are in the external canonicalization snapshot under `p0.2-canary/`.

None of these runs created a model candidate, `RuntimeEvalDefinition`, `RuntimeProofBundle`, benchmark pass, or runtime verdict. P0 and P0.1 remain failures; P0.2 does not replace them.

## Current relationship

Protocol v12 removed the predecessor protocol union and mechanic-specific paths, changed the advertised surface, and introduced plugin 8.0.0 as a clean break. Consequently, P0.2 does not prove the current executor ready.

The next evidence-producing action is one user-run protocol-v12 capability canary against the current MovingPlatform seed. It must establish pairing, correlation, finite typed observations, edit-mode/Play-Solo endpoint integrity, direct nonce-correlated return, bounds, and cleanup. Until it succeeds, there is no canonical Studio readiness claim and no model run should occur.
