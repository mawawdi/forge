# RFC: Context Compiler Boundary

Status: implemented as a deterministic foundation; optimization deferred  
Date: 2026-08-29

## Decision

Forge exposes a model-neutral `ContextCompiler` that turns a `ProjectSemanticMap`, `MechanicContract`, Forge-owned `MechanicImplementationSpec`, current issues, and optional `PatchSet` into ordered, inspectable `ContextItem` values. Each item records its source, type, priority, reason, token estimate, content hash, relevant entity, and whether it is required or evictable.

The initial deterministic policy is intentionally small:

- P0 required: mechanic contract, non-evictable implementation spec, current verification issues, requested change, generation policy, and bounded patch metadata;
- P1 required: complete source for scripts directly changed or connected to the target M2 remote flow, plus the exact remote/dependency neighborhood;
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

## M3.25 generation isolation

Generation adds a non-evictable `mechanic_implementation_spec`, a non-evictable
`generation_policy`, and an explicit `allowedSourcePaths` allow-list. The intent
call receives no source at all. The patch call receives the complete clean-seed
source on that allow-list and its semantic remote neighborhood; it cannot
receive repaired source, Studio harnesses, assertion implementations,
ProofBundles, historical runs, or arbitrary repository context. A trace stores
only summary/composition hashes, never `modelReadyContent`.

Repair context uses the same immutable implementation spec and additionally
includes complete candidate source, the candidate PatchSet, and normalized
ranged diagnostics/evidence. Correctness takes priority over minimizing context:
required P0/P1 items are never evicted merely to reach a smaller token count.

## Future work

M3 needs only enough context to operate Studio assertions against a mapped contract. Budget-aware priority eviction, retrieval, context effectiveness metrics, and full Flight Recorder composition telemetry belong after the authoritative loop exists.
