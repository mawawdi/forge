# RFC: Canonical Project Semantic Map

Status: implemented as the M2.5 bridge foundation  
Date: 2026-08-29

## Decision

Forge keeps a versioned `ProjectSemanticMap` between project adapters and verification. It is the canonical representation of the relevant Roblox world model; the existing M2 remote-flow graph is retained inside it rather than rebuilt as a second graph.

The current map contains:

- inferred or declared Instances with stable path/class identities, parent links, relevant properties, attributes, and sorted tags;
- scripts with execution context, source hash, dependency paths, and the loaded source used only by local analysis;
- modules, remotes, persistent-state declarations, UI bindings, mechanic-contract IDs, and typed dependency edges;
- layered hashes: `sourceHash`, `structureHash`, and `semanticHash`.

The canonical projection removes absolute paths and raw source. Its stable ordering rules are:

1. normalize paths to `/` and reject `..` traversal;
2. sort files, scripts, modules, instances, remotes, dependencies, state, UI bindings, tags, and contract IDs;
3. hash source as sorted `relativePath + newline + source` records;
4. hash structure from hierarchy, script metadata, modules, and remotes;
5. hash semantic relationships from the structure hash, M2 remote evidence, dependencies, state, UI, and contract IDs.

`ProjectSnapshot` records `sourceHash`, `structureHash`, `contractHash`, `projectSemanticHash`, and `semanticMapHash`. `projectSemanticHash` deliberately excludes the local root path, so semantically identical fixture copies can compare equal. `semanticMapHash` may retain map identity details for local artifact inspection.

## Adapter boundary

```ts
interface ProjectSourceAdapter {
  load(input: ProjectLoadRequest): Promise<ProjectSemanticMap>;
  snapshot(map: ProjectSemanticMap): ProjectSnapshot;
}
```

The current implementation is a deterministic Rojo/filesystem-style adapter over `forge.fixture.json` and Luau roots. The future adapters are:

- a Studio adapter that reads the live DataModel and returns the same map shape;
- an optional rbx-dom adapter for serialized `.rbxm`, `.rbxl`, `.rbxmx`, and `.rbxlx` inputs.

## rbx-dom fit

The public `rojo-rbx/rbx-dom` project materially covers the missing world-model concerns: `rbx_dom_weak` represents Instances and properties, reflection crates provide class metadata, and `rbx_xml`/`rbx_binary` handle Roblox model/place formats. It is therefore a strong future adapter target. It is not adopted now because this repository is a TypeScript subprocess candidate with no Rust workspace, rbx-dom does not specify an MSRV, and adding Rust/native build distribution before M3 would increase toolchain risk without improving the current Studio connector path. See the [rbx-dom README](https://github.com/rojo-rbx/rbx-dom#readme).

This is a deferral behind an interface, not a rejection of the library. Adoption should be reconsidered when Forge must ingest real place/model files outside Studio or needs reflection-accurate serialization.

## Affected verification cones

`affectedVerificationCone(map, changedPaths)` returns changed scripts, dependent scripts, remote IDs, contract IDs, and the checks that are conservatively relevant. M2 uses the cone for context selection; future incremental verification may use it to narrow work. A cone is not permission to skip global checks: until dependency coverage is proven complete, full verification remains the safe fallback.

## Non-goals

This RFC does not add a Studio bridge, binary place parser, live-state merge algorithm, or incremental-verification cache. It also does not treat filesystem source as the complete Roblox world model; it is only the current adapter's available evidence.
