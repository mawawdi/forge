# Forge engineering rules

- Keep one current schema format. Breaking shape changes replace the old format; do not add compatibility readers or migration branches.
- A Flight Recorder trace stores hashes, references, normalized diagnostics, and explicitly approved metadata—not raw project source or creator-identifying data by default.
- Instrumentation must not alter a verification decision. A telemetry persistence failure is reported separately and must not turn a valid verification into a false rejection.
- Treat `BuildTrace`, `ProofBundle`, and CoreLoopBench as distinct objects: execution history, compact decision evidence, and a reproducible regression fixture.
- Never weaken or delete a promoted regression merely to restore a passing result. Invalidate it only with a documented reason and retain the invalidation record.
- Do not claim exact replay when a model, Studio runtime, or other nondeterministic dependency is not pinned and available.
- Roblox project state is more than Luau files. Keep filesystem, semantic-map, and live-Studio representations behind adapter boundaries.
- Prefer deterministic compilation for known transformations; use replaceable models only for unresolved ambiguity.
- Every model context item needs provenance and an inclusion reason; correctness takes priority over clever caching.
- Reusable mechanic knowledge must remain tied to verification evidence, and capsule adaptation must re-run verification.
- Environment/tool interfaces are more durable than individual agent implementations; preserve provider-specific telemetry behind generic interfaces.
- Only real Roblox Studio execution can establish engine-dependent runtime truth.
- Studio connectivity is infrastructure; the Forge Studio Plugin is the product-specific trusted runtime bridge, not the reasoning agent.
- PatchSets remain typed and inspectable across the Studio boundary; backend messages are untrusted until validated.
- Runtime assertions must include observed evidence, and security-sensitive mechanics require adversarial assertions.
- A verified transaction is tied to exact contract, project, patch, verifier, plugin, and Studio runtime versions.
- Failed StudioProof runs remain preservable as future CoreLoopBench regressions.
