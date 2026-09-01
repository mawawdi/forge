# Forge

Forge is a prompt-only Roblox Studio creator harness with a separate registered-benchmark system. In an ordinary creator session, the user opens a place, enters one prompt, reviews a visible plan and verification charter, approves an exact typed change set, runs the checks in Studio, and accepts or rolls back the result. Studio is the only persistent writer.

Documentation authority is split deliberately:

- [Architecture and implementation](docs/ARCHITECTURE.md)
- [Product thesis and invariants](docs/FORGE.md)
- [Evaluation and claim policy](docs/EVALS.md)
- [Demonstrated status and next work](docs/ROADMAP.md)
- [Research and historical evidence](docs/RESEARCH.md)

## Setup

Requirements: Node.js 22+, npm, Java 11+, `luau-compile`, `luau-analyze`, `luau-lsp`, Lune, Rojo, and Roblox Studio for user-run checks.

```sh
npm install
npm --prefix dashboard install
npm run formal:setup
npm test
```

`formal:setup` downloads the pinned official TLA+ 1.7.4 tools JAR, verifies its exact byte count and SHA-256, and stores it privately under `.forge/tooling/tla/v1.7.4`; `formal:check` is offline. Tests regenerate/check the capability manifest outputs, build TypeScript and the dashboard, run all Node regressions, parse/analyze/test the plugin, model-check the mutation protocol, and make no model request or Studio action.

The official Roblox API input is separately pinned and checked offline:

```sh
npm run roblox-api-catalog:check
npm run studio-evidence:check
node bin/forge.js studio api-status
node bin/forge.js studio capabilities --class Part
```

`roblox-api-catalog:refresh` is the explicit networked update path. It fetches the exact configured `Roblox/creator-docs` commit, verifies the complete engine-reference source tree, and rewrites the normalized catalog only when the checked-in source descriptor is updated deliberately. Ordinary builds never fetch Roblox documentation.

## Prompt-only creator session

Build the Studio connector to a temporary or chosen output, install it in Studio, and start the local service:

```sh
rojo build plugin/default.project.json -o /tmp/ForgeStudioPlugin.rbxmx
node bin/forge.js creator serve --model openai/gpt-5.6-luna
```

Open the one-time dashboard URL printed by `creator serve`, then open a place in Studio, allow local HTTP and script injection, and wait for the thin Forge connector to pair. The generated connector identity binds the protocol source and capability manifest, so an old plugin is rejected before session creation and pauses rather than retrying indefinitely. Its current-security ReflectionService attestation must cover every curated writable property before Forge authorizes work. The connector records raw reflection dimensions; the backend alone checks each row's generated catalog identity, exact engine/storage type, Luau script type, and enum or Instance constraint. Missing required dimensions are incomplete, while complete contradictory facts are rejected with exact bounded findings and inspectable raw evidence. Submit the prompt and follow the exact primary/secondary actions in the dashboard. Plan approval, exact change approval plus apply, playtest initiation, and final acceptance remain separate decisions. Final acceptance or rejection requires a free-form creator report; Forge preserves it as creator-authority evidence and does not parse it into machine claims.

Apply is a provisional transaction. One generated `StudioCapabilityManifest` owns the writer, reader, canary, projection, comparator, and canonical codecs in TypeScript and Luau. The hash-bound change review shows the exact direct-readback proof obligations; after approval Forge rechecks and persists the complete state revision before any recording can open. Exact projection hashes preserve evidence provenance, while the comparable state hash excludes approval/session/projection identity and covers the manifest, semantic coverage domain, and canonical facts, preventing a freshly bound projection from fabricating drift. Forge binds the paired capability attestation into the attempt, stores a detached round-trip preflight, persists and reads back a fresh plugin-local opening cursor, then persists and reads back Studio's real opaque recording ID before the first place operation. It stores direct engine readback plus complete before/after project-state envelopes and reconciles only those immutable artifacts. A rejected or incomplete preflight is retained as an immutable incomplete attempt and never receives a mutation verdict. A mid-batch execution, post-state, or transaction-persistence failure may close only when the same plugin call proves cancellation and Forge persists complete post-cancel state plus the durable receipt; that path is also an immutable incomplete attempt, never a match. Complete contradictory facts are `mismatched`; missing, unavailable, erroneous, duplicated, extra, unordered, or misbound facts are `incomplete`. Only `matched` can enter verification, and only a persisted passing verification can commit. Restart never retries, commits, or cancels automatically. Before any new request, pairing must report `none`, `open`, `not_open`, or `unknown` transaction state even if the old session bundle was reset. Exact `open` proof enables creator cancellation; `unknown` blocks; exact complete `not_open` evidence permits only an evidence-bound stale-cursor acknowledgement, which does not touch Studio and never resumes the interrupted attempt.

The planner first inspects bounded exact-path Studio facts, then declares the initial-state paths the builder may inspect. After plan approval, Forge compiles a content-addressed `CreatorBuildContract`: it derives every operation's ID, kind, path, parent, name, class, stable identity, precondition, and initialization while the builder supplies only `planChangeId` plus allowlisted property values, attributes, explicit removals, and source. Model-facing property values use natural JSON. In addition to primitive literals, the current codec boundary accepts bounded Vector2/Vector3, Color3, CFrame, UDim2, Rect, NumberRange, number/color sequences, and stable class-constrained Instance references (including explicit `null` for an unset Instance property); Forge converts them into the exact tagged storage domain before change review. Current creator sessions and their content-addressed evidence are private under `.forge/creator`. Forge has no legacy reader or migration path; deleting `.forge` is an intentional hard reset and the current store is recreated on first use. A planner or builder that stops without a seal-ready artifact still produces an immutable incomplete `AgentRun` and trace before the session closes.

Forge will not present a plan unless it is structurally executable: its goal is the exact canonical creator prompt, every declared inspection dependency was actually inspected, every step covers exact typed changes, newly created scripts commit to inline source in their create operation, every created or moved output has a class-aware existence check, and every source-bearing plan has a Luau syntax check. The review view shows those generated commitments and separates machine checks from creator judgment. Change review shows the complete typed creative payload and source diffs before mutation.

The historical [Status Beacon fixture](examples/status-beacon/README.md) remains the first accepted creator proof. The distinct [Door Control fixture](examples/door-control/README.md) has now completed the current closed-evidence flow: its mutation reconciled as `matched`, verification passed, Studio committed the recording, the creator accepted the result, and both provider-free replays reproduced the recorded outcomes exactly. Neither fixture contains requirements, evaluator material, acceptance JSON, or a prepared solution. [The roadmap](docs/ROADMAP.md) preserves the exact ledger and claim boundaries.

## Roblox capability accountability

Forge now accounts for all 9,449 entries in the pinned official Engine API snapshot: 1,204 classes/datatypes/enums plus 8,245 member occurrences. Every entry has one generated disposition and reason. The proof-closed manifest currently enables 33 coherent classes and 183 distinct writable properties; inherited applicability produces 209 `authorable` catalog coverage rows. The remaining entries stay explicitly observable-only or unsupported until their full evidence route exists. Catalog completeness is therefore not a claim that arbitrary gameplay, networking, external services, moderation, physics, client state, or creator perception can be universally verified.

The dashboard's API coverage explorer shows the source pin, catalog/coverage/manifest identities, connector attestation health, inheritance, codec, disposition, reason, and seven-stage proof route. It is an accountability view, not an alternate mutation menu; `CreatorControlView` remains the only workflow-legality contract.

If a live place contains subtrees owned by an external Rojo workflow, declare each as an exclusion zone:

```sh
node bin/forge.js creator serve \
  --model openai/gpt-5.6-luna \
  --external-rojo-root Workspace/ExternallyManaged
```

Forge will treat those nodes as read-only. It does not provide dual Rojo/Studio writes or merge concurrent edits.

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
forge creator start-checks|cancel-changes
forge creator accept|reject-result
forge experiment register|build|evaluate
forge studio api-status|capabilities|canary|bridge
forge verify
forge trace show
```

The repository-root `.env` or process environment may provide `OPENROUTER_API_KEY` for an explicitly authorized live model run. Forge never persists the key or raw reasoning continuation.
