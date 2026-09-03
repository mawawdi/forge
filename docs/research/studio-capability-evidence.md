# Studio Capability Evidence

Status: historical evidence ledger. An earlier connector completed a bounded capability canary and one exact Vertical Shuttle evaluation before the current clean-break contracts. The records below remain predecessor evidence, not current readiness.

This ledger records actual Studio observations, not local-test claims. It preserves the failure progression that justified the current position-integrity canary while making no current runtime verdict.

## Predecessor characterization

| Run  | Result                                             | Evidence and interpretation                                                                                                                                                                                                                                                                                           |
| ---- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0   | Completed transport; invalid observation substrate | `studio_capability_canary_6cc7b6a13534442a8a991cd4`, execution plan `studio_execution_plan_203a57180b4299bdd66058be`. Correlated execution returned `(0,0,0)` for both endpoints despite nonzero serialized locations, so it was never valid grading evidence.                                                        |
| P0.1 | Incomplete infrastructure result                   | `studio_capability_canary_b4a90f7cd7cbf4e623272366`, execution plan `studio_execution_plan_c3b2b9d70bf3caf7923a8103`. The plan armed and Play Solo started, but no correlated runtime envelope returned; the run remained a timeout/connector failure, not candidate behavior.                                        |
| P0.2 | Successful earlier capability characterization     | `studio_capability_canary_7e4602dae1fc51b6023c987a`, execution plan `studio_execution_plan_7be78fcad2a0c9eab607f347`. EndpointA was observed at `(-12,4,0)`, EndpointB at `(12,4,0)`, and the stationary seed platform returned four bounded samples at `(-12,4,0)` over 1499 ms through correlated direct `EndTest`. |

P0.2 artifact SHA-256 is `36716e671a64ba15393ec7647e6ac0b750ab2a50d2b8026a2ddb03fd63293ee8`. Its preserved record and place are in the external canonicalization snapshot under `p0.2-canary/`.

None of these runs created a model candidate, `RuntimeEvalDefinition`, `RuntimeProofBundle`, benchmark pass, or runtime verdict. P0 and P0.1 remain failures; P0.2 does not replace them.

## Current relationship

The clean-break predecessor removed its earlier message union and mechanic-specific paths. Its canary established bounded transport and observation facts; separately, the exact registered Vertical Shuttle candidate produced `runtime_verified` as `runtime_evaluation_run_35b4ef7f3f9c482d82d498bc`. Both are now historical predecessor evidence. Neither establishes current authoring readiness, retroactively changes earlier records, or creates a general capability or MovingPlatform claim.
