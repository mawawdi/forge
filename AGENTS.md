# Forge engineering rules

- Keep one current schema format. Breaking shape changes replace the old format; do not add compatibility readers or migration branches.
- A Flight Recorder trace stores hashes, references, normalized diagnostics, and explicitly approved metadata—not raw project source or creator-identifying data by default.
- Instrumentation must not alter a verification decision. A telemetry persistence failure is reported separately and must not turn a valid verification into a false rejection.
- Treat `BuildTrace`, `ProofBundle`, and CoreLoopBench as distinct objects: execution history, compact decision evidence, and a reproducible regression fixture.
- Never weaken or delete a promoted regression merely to restore a passing result. Invalidate it only with a documented reason and retain the invalidation record.
- Do not claim exact replay when a model, Studio runtime, or other nondeterministic dependency is not pinned and available.
