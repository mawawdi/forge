# Forge

Forge is a prompt-only Roblox Studio creator harness with a separate registered-benchmark system. In an ordinary creator session, the user opens a place, enters one prompt, reviews a visible plan and verification charter, approves an exact typed change set, runs the checks in Studio, and accepts or rolls back the result. Each session has exactly one declared persistent writer: the open Studio document by default, or an explicitly opted-in Rojo source tree.

Documentation authority is split deliberately:

- [Architecture and implementation](docs/ARCHITECTURE.md)
- [Product thesis and invariants](docs/FORGE.md)
- [Evaluation and claim policy](docs/EVALS.md)
- [Demonstrated status and next work](docs/ROADMAP.md)
- [Research and historical evidence](docs/RESEARCH.md)
- [Development and quality workflow](docs/DEVELOPMENT.md)

## Setup

Requirements: Node.js 22+, npm, Java 11+, `luau-compile`, `luau-analyze`, `luau-lsp`, Lune, Rojo, and Roblox Studio for user-run checks.

```sh
npm install
npm --prefix dashboard install
npm run formal:setup
npm run source-analysis:setup
npm test
```

Use `npm run format` to apply the pinned formatter and `npm run lint` for a fast, non-mutating static check. The complete contributor workflow and generated-file boundaries are documented in [the development guide](docs/DEVELOPMENT.md).

`formal:setup` first reuses a verified pinned official TLA+ 1.7.4 tools JAR from `.forge/tooling/tla/v1.7.4`; only an absent JAR is downloaded. Each download attempt has a 15-second timeout, and transient connection failures, `429`, and `5xx` responses receive two bounded backoff retries. Other `4xx` responses and every byte-count or SHA-256 mismatch fail immediately. `formal:check` is offline. `source-analysis:setup` prewarms the private source-analysis cache with only the Rojo 7.7.0 and Luau LSP 1.63.0 release assets named in the tracked lock. `creator serve` now performs the same atomic installation automatically when that cache is absent, so deleting `.forge` does not create a hidden manual prerequisite. Existing material is always verified and a malformed path, symlink, unexpected archive, or hash mismatch fails closed rather than being overwritten. `source-analysis:check` remains offline. `docs:check` resolves repository-local Markdown links and renders every Mermaid diagram with the exact development dependency `@mermaid-js/mermaid-cli` 11.12.0 in a temporary directory. `rojo:check` first re-verifies the pinned source-analysis toolchain, then builds the plugin and every fixture with its verified Rojo 7.7.0 executable into a temporary directory; it never writes a place or plugin artifact into the repository. Tests run all of those gates, build TypeScript and the dashboard, run Node/dashboard/plugin regressions, model-check all transaction models, and make no model request or Studio action.

The official Roblox API input is separately pinned and checked offline:

```sh
npm run roblox-api-catalog:check
npm run studio-evidence:check
npm run roblox-api-coverage:check
node bin/forge.js studio api-status
node bin/forge.js studio capabilities --class Part
node bin/forge.js studio capabilities --query math.abs
```

`roblox-api-catalog:refresh` is the explicit networked update path. It fetches the exact configured `Roblox/creator-docs` commit, verifies the complete engine-reference source tree, and rewrites the normalized catalog only when the checked-in source descriptor is updated deliberately. Ordinary builds never fetch Roblox documentation.

`npm run build` regenerates the host/connector compatibility identity before compiling and writes a content-addressed runtime manifest into `dist`. `node bin/forge.js` refuses to start when the checked-out runtime sources and compiled output differ; rebuild and reinstall the connector together after transaction, protocol, or plugin changes.

## Prompt-only creator session

Build the Studio connector directly into the local Roblox Studio Plugins directory, then start the local service:

```sh
npm run plugin:build
node bin/forge.js creator serve --model openai/gpt-5.6-luna
```

Open any platform-valid place in Studio—including an existing `.rbxlx` with no Forge metadata—then open the one-time dashboard URL, allow local HTTP and script injection, and wait for the connector to pair. Forge first collects a complete sharded, content-addressed project index and the current Script Editor buffers. Duplicate names and unsupported classes remain indexable because mutation authority uses opaque connector-epoch identities rather than display paths. The planner can search and page source, inspect symbols/references, and traverse static require dependencies before proposing a plan; the exact consulted ranges and dependency closure are immutable evidence. Submit the prompt and follow only the dashboard's current hash-bound actions. Plan approval and exact change approval remain explicit decisions. After matched provisional Apply, Forge silently arms the next ordinary Play session; press Play whenever ready, perform the approved interaction, then press Stop. Complete evidence advances even when it proves a mismatch. Technical incompleteness shows **Retry Play Verification** / **Cancel Changes** and never silently re-arms. After acceptance, the committed result exists in Studio; export it explicitly with **File → Save to File** and choose `.rbxlx`. Forge makes no filesystem-output claim before that creator action.

Apply is a provisional transaction. One generated `StudioCapabilityManifest` owns the writer, reader, canary, projection, comparator, and canonical codecs in TypeScript and Luau. The hash-bound change review shows the exact direct-readback proof obligations; after approval Forge collects and persists a complete project-index graph before any recording can open. For source-bearing changes, the host streams every immutable source blob and waits for its exact request-bound Studio acknowledgement before sending Prepare. Forge binds the paired capability attestation into the attempt, stores a detached round-trip preflight, persists and reads back a fresh plugin-local opening cursor, then persists and reads back Studio's real opaque recording ID before the first place operation. It stores direct engine readback plus complete before/after `StudioProjectRevision` graphs and reconciles only those immutable leaves; no second monolithic capture is authoritative. A rejected, interrupted, or incomplete preflight is retained as an immutable incomplete attempt and never receives a mutation verdict. A mid-batch execution, post-index, or transaction-persistence failure may close only when the same plugin call proves cancellation and Forge persists a complete post-cancel index plus the durable receipt; that path is also an immutable incomplete attempt, never a match. Every commit or cancellation first persists an exact action/current-index/detector-epoch intent. The single recording-closure primitive then reruns that gate immediately before one `FinishRecording` call and requires `IsRecordingInProgress(recordingId)` to return exactly `false` before it may persist a finished cursor. A throw, non-boolean result, still-open result, restart, or later dirty notice remains recovery-required; it is never treated as closure. For an exact projection, `observed` and authoritative `absent` are both complete coverage; expected status/value comparison belongs only to pure reconciliation and grading. Omissions, unavailable/read-error facts, duplicates, extras, invalid order, or bad bindings are incomplete. Only `matched` can enter verification, and only a persisted passing verification can commit. Incomplete creator-play evidence preserves the matched provisional recording in `awaiting_verification_retry`; it never causes automatic re-arm, cancellation, or repair. Restart never retries, commits, or cancels automatically. Before any new request, pairing must close both the active-recording cursor and the separate unacknowledged-finalization-receipt dimension of transaction inventory, even if the old session bundle was reset. A retained receipt is persisted and acknowledged first; only the plugin's acknowledgement-correlated fresh inventory report releases that gate, so an unrelated `none` cannot race a new Prepare. Exact `open` proof enables creator cancellation; `unknown` blocks; exact complete `not_open` evidence permits only an index-bound stale-cursor acknowledgement, which does not touch Studio and never resumes the interrupted attempt.

Passive Play persistence uses only the current `ForgePassiveRuntimeDirectV2` key; the incompatible V1 key is ignored. If current-version passive state is genuinely malformed, the connector remains fail-closed and exposes **Discard invalid receipt & recover**. That explicit action refuses valid evidence, clears no Studio recording, and pairs only so Forge can inspect the independent creator-transaction inventory.

The planner combines the pinned offline Roblox API catalog with bounded `source.search`, `source.read`, `source.symbols`, `source.references`, and `source.dependencies`. Source results are labeled `static_analysis`; Forge never executes project source or upgrades analysis into Studio or gameplay fact. The host uses only the verified Rojo 7.7.0 and Luau LSP 1.63.0 toolchain. Static require traversal never resolves dynamic requires by guesswork. One LSP session is limited to 30 seconds, each request to five seconds, each message to 1 MiB, collection to 200 symbols and references per symbol, and returned references to 1,024 rows. A source-bearing plan must bind its exact host-derived `CreatorSourceConsultation`. The builder may read any source inside that approved closure and nothing outside it. Existing-source changes use `edit_source`: sorted, non-overlapping UTF-8 byte edits against an exact before hash. Forge materializes the full candidate host-side, validates final hash/byte count, runs Luau analysis, and shows the exact diff; Studio applies through `ScriptEditorService:UpdateSourceAsync` only when the live editor-source hash still matches. New scripts carry complete source through the same chunked source-blob boundary.

Forge will not present a plan unless it is structurally executable: its goal is the exact canonical creator prompt, every declared inspection dependency was actually inspected, every step covers exact typed changes, newly created scripts commit to inline source in their create operation, every created or moved output has a class-aware existence check, and every source-bearing plan has a Luau syntax check. The review view shows those generated commitments and separates machine checks from creator judgment. Change review shows the complete typed creative payload and source diffs before mutation.

Forge uses one default agent budget wherever a caller has not explicitly preregistered another experimental budget: 32 turns, 256 tool calls, 128 writes, 16 verifier calls, and a 30-minute deadline. Complete project indexing has its own persisted resource policy: up to 1,048,576 instances, 1 GiB aggregate canonical index material, 128 MiB per source blob, ten minutes, 512 records or 4 MiB per shard, and 256 KiB transport chunks. Resource exhaustion is incomplete evidence; Forge never labels a partial index complete.

The historical [Status Beacon fixture](examples/status-beacon/README.md) remains the first accepted creator proof. The distinct [Door Control fixture](examples/door-control/README.md) has an accepted documentary ledger for the predecessor closed-evidence transaction: its recorded mutation reconciled as `matched`, verification passed, Studio committed the recording, the creator accepted the result, and both provider-free replays returned `exact_match` before the local store was deliberately removed. It is not live proof of the current project-index, source-intelligence, or Rojo-authority paths. The solution-free [Orbital Freight Airlock fixture](examples/orbital-freight-airlock/README.md) is the next, deliberately interconnected client/server proof. None of the fixtures contains requirements, evaluator material, acceptance JSON, or a prepared solution. [The roadmap](docs/ROADMAP.md) preserves the exact ledger and claim boundaries.

## Roblox capability accountability

Forge accounts for all 9,685 entries in the pinned official Engine API snapshot: all 638 classes, 48 datatypes, 518 enums, 50 globals, 11 standard libraries, and every documented member/item. Every entry has one generated disposition and reason. At the class level, 33 classes have a proof-closed direct Studio authoring route, 554 current classes are available to the planner and builder as source APIs, and the remaining 51 are restricted only because Roblox marks them deprecated. Catalog-derived selection enables 364 writable property applications from 248 distinct declarations; inheritance and their enum closure produce 635 `authorable` rows. Across the complete catalog, 7,509 nondeprecated, script-accessible entries are `source_only`: the planner and builder can retrieve their official signatures and use them in bounded Luau source, but Forge does not claim a typed mutation or behavioral proof route for them. Sixteen datatype rows are observable codec context. The remaining 1,525 rows are restricted because they are deprecated, hidden/NotScriptable, security-gated, or otherwise outside the proof-closed mutation surface. Content-bearing asset identifiers, structural `Name`/`Parent`, and unsupported protected types remain source-only instead of being misrepresented as direct authoring. Catalog completeness is not a claim that arbitrary gameplay, networking, external services, moderation, physics, client state, or creator perception can be universally verified.

The dashboard's compact Roblox API ledger shows the source pin, catalog/coverage/manifest identities, connector attestation health, signatures, security, capability tags, official YAML provenance, inheritance, codec, disposition, reason, and seven-stage proof route. It is an accountability view, not an alternate mutation menu; `CreatorControlView` remains the only workflow-legality contract.

For a Rojo-owned source project, opt in with one private project-authority manifest:

```sh
node bin/forge.js creator serve \
  --model openai/gpt-5.6-luna \
  --project-authority path/to/project-authority.json
```

The manifest defines exact Studio roots and, for `rojo_source`, one Rojo project
file plus bounded source roots. Its paths and workspace root are private to the
trusted host. At service startup Forge generates the mapping with the verified,
pinned Rojo 7.7.0 `sourcemap` command; the manifest cannot supply a sourcemap or
tool path. A Rojo declaration makes the exact mapped scripts and directories
available to the guarded source writer; every other indexed object remains
Studio-owned. Forge derives and seals one writer per change set. Mapped source
edits select `rojo_source`, typed model/property work selects `studio_document`,
and a mixed batch is rejected before approval. Source success still requires a
later complete Studio index proof; Forge does not claim a saved `.rbxlx` until
the creator explicitly uses **File → Save to File**.

## Registered experiments

Benchmarks intentionally require more files because their hidden evaluator, thresholds, seed, budgets, model transport, exact manifest/projection bindings, and implementation snapshot must be preregistered. That is evaluation scaffolding, not creator UX.

```sh
node bin/forge.js experiment register path/to/seed \
  --prompt-file path/to/creator-prompt.txt \
  --requirements path/to/requirements.json \
  --acceptance path/to/acceptance.json \
  --runtime-plan path/to/runtime-eval-definition.json \
  --runtime-configuration path/to/runtime-evaluator-configuration.json \
  --model openai/gpt-5.6-luna \
  --output /tmp/experiment-registration.json
```

Registered treatments are supplied outside `examples/`; the repository keeps only solution-free creator fixtures. Synthetic tests construct benchmark material in memory so evaluator-isolation and registration coverage do not depend on a hand-authored product example.

Forge has one current contract shape, distinguished by `kind` where a union needs a discriminator and bound by canonical content hashes where identity matters. The generated capability-manifest hash and connector-build hash establish compatibility. A shape change replaces the old reader outright. Historical evidence remains immutable bytes and is never relabeled as current.

## CLI

```text
forge creator serve|start|status|replay-verification|replay-mutation
forge creator approve-plan|reject-plan
forge creator approve-changes|reject-changes
forge creator cancel-changes
forge creator accept|reject-result
forge experiment register|build|evaluate
forge studio api-status|capabilities|canary|bridge
forge verify
forge trace show
```

The repository-root `.env` or process environment may provide `OPENROUTER_API_KEY` for an explicitly authorized live model run. Forge never persists the key or raw reasoning continuation.
