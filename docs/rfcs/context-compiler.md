# RFC: Context Compiler Boundary

Status: implemented as a deterministic foundation; optimization deferred  
Date: 2026-08-29

## Decision

Forge exposes a model-neutral `ContextCompiler` that turns a `ProjectSemanticMap`, `MechanicContract`, current issues, and optional `PatchSet` into ordered, inspectable `ContextItem` values. Each item records its source, type, priority, reason, token estimate, content hash, relevant entity, and whether it is required or evictable.

The initial deterministic policy is intentionally small:

- P0 required: mechanic contract, current verification issues, requested change, and bounded patch metadata;
- P1 required: scripts directly changed or connected to the target M2 remote flow, plus the relevant remote/dependency neighborhood;
- P2 evictable: canonical project structure/state metadata;
- P3/P4 retrieval, project memory, and historical conversation are reserved and not selected.

There is no vector database, provider-specific prompt format, tokenizer optimizer, or ranking model. `candidateTokenEstimate` and `evictedTokenEstimate` are recorded now; the initial compiler selects all bounded items and evicts none.

The compiled representation is model-ready but remains useful without a model. Its deterministic `compositionHash` can be attached to a `BuildTrace` through context summary metadata without persisting raw context into telemetry.

## Boundary

```ts
interface ContextCompiler {
  compile(input: ContextCompilationRequest): Promise<CompiledContext>;
}
```

Provider/runtime adapters may consume `modelReadyContent` later. They must not redefine selection policy or make the model a semantic authority. Every selected item must have a reason; every omitted item is simply unavailable or deferred, not silently retrieved from an unspecified store.

## Future work

M3 needs only enough context to operate Studio assertions against a mapped contract. Budget-aware priority eviction, retrieval, context effectiveness metrics, and full Flight Recorder composition telemetry belong after the authoritative loop exists.
