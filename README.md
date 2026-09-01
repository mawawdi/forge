# Forge

Forge is a prompt-only Roblox Studio creator harness with a separate registered-benchmark system. In an ordinary creator session, the user opens a place, enters one prompt, reviews a visible plan and verification charter, approves an exact typed change set, runs the checks in Studio, and accepts or rolls back the result. Studio is the only persistent writer.

Documentation authority is split deliberately:

- [Architecture and implementation](docs/ARCHITECTURE.md)
- [Product thesis and invariants](docs/FORGE.md)
- [Evaluation and claim policy](docs/EVALS.md)
- [Demonstrated status and next work](docs/ROADMAP.md)
- [Research and historical evidence](docs/RESEARCH.md)

## Setup

Requirements: Node.js 22+, npm, `luau-compile`, `luau-analyze`, `luau-lsp`, Lune, Rojo, and Roblox Studio for user-run checks.

```sh
npm install
npm --prefix dashboard install
npm test
```

Tests build TypeScript, run all Node regressions, parse and analyze the plugin, run plugin module tests, and make no model request or Studio action.

## Prompt-only creator session

Build the Studio connector to a temporary or chosen output, install it in Studio, and start the local service:

```sh
rojo build plugin/default.project.json -o /tmp/ForgeStudioPlugin.rbxmx
node bin/forge.js creator serve --model openai/gpt-5.6-luna
```

Open the one-time dashboard URL printed by `creator serve`, then open a place in Studio, allow local HTTP and script injection, and wait for the thin Forge connector to pair. Submit the prompt and follow the exact primary/secondary actions in the dashboard. Plan approval, exact change approval plus apply, playtest initiation, and final acceptance remain separate decisions. Final acceptance or rejection requires a free-form creator report; Forge preserves it as creator-authority evidence and does not parse it into machine claims. The planner first inspects bounded exact-path Studio facts, then declares the initial-snapshot paths the builder may inspect. After plan approval, Forge compiles a content-addressed `CreatorBuildContract`: it derives every operation's ID, kind, path, parent, name, class, stable identity, precondition, and initialization while the builder supplies only `planChangeId` plus allowlisted property values, attributes, explicit removals, and source. Model-facing property values use natural JSON—primitive literals, `{x,y,z}`, `{r,g,b}`, or `{position,rotation}`—and Forge canonicalizes them to Studio's actual float and 8-bit color storage domain before change review, then emits the tagged representation accepted by the trusted Studio connector. For an approved replacement of an existing script, the builder can read only that exact current source. Current creator sessions and their content-addressed evidence are private under `.forge/creator`; historical `.forge/creator-sessions` bytes remain untouched and are not accepted by the current reader. A planner or builder that stops without a seal-ready artifact still produces an immutable incomplete `AgentRun` and trace before the session closes.

Forge will not present a plan unless it is structurally executable: its goal is the exact canonical creator prompt, every declared inspection dependency was actually inspected, every step covers exact typed changes, newly created scripts commit to inline source in their create operation, every created or moved output has a class-aware existence check, and every source-bearing plan has a Luau syntax check. The review view shows those generated commitments and separates machine checks from creator judgment. Change review shows the complete typed creative payload and source diffs before mutation.

The historical [Status Beacon fixture](examples/status-beacon/README.md) remains the first accepted creator proof. The distinct [Door Control fixture](examples/door-control/README.md) is the current solution-free live-proof seed. Neither contains requirements, evaluator material, acceptance JSON, or a prepared solution.

If a live place contains subtrees owned by an external Rojo workflow, declare each as an exclusion zone:

```sh
node bin/forge.js creator serve \
  --model openai/gpt-5.6-luna \
  --external-rojo-root Workspace/ExternallyManaged
```

Forge will treat those nodes as read-only. It does not provide dual Rojo/Studio writes or merge concurrent edits.

## Registered experiments

Benchmarks intentionally require more files because their hidden evaluator, thresholds, seed, budgets, model transport, exact connector capability set, and implementation snapshot must be preregistered. That is evaluation scaffolding, not creator UX.

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

Forge has one current contract shape, distinguished by `kind` where a union needs a discriminator and bound by canonical content hashes where identity matters. Capability-set IDs and hashes establish connector compatibility. A shape change replaces the old reader outright. Historical evidence remains immutable bytes and is never relabeled as current.

## CLI

```text
forge creator serve|start|status|replay-verification
forge creator approve-plan|reject-plan
forge creator approve-changes|reject-changes
forge creator start-checks|cancel-changes
forge creator accept|reject-result
forge experiment register|build|evaluate
forge studio canary|bridge
forge verify
forge trace show
```

The repository-root `.env` or process environment may provide `OPENROUTER_API_KEY` for an explicitly authorized live model run. Forge never persists the key or raw reasoning continuation.
