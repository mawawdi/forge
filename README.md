# Forge

Build and improve Roblox places through a conversation with an agent.

Forge connects a local dashboard to Roblox Studio. A creator asks for a change,
reviews a read-only plan, accepts its exact bounds, and receives the result after
Forge builds, checks, applies, and reconciles the change. Optional Play diagnostics
can inform the next message; they are not a gameplay verdict.

## Get started

Install Node.js 22+, npm, Java 11+, Rojo, Lune, `luau-compile`, `luau-lsp`, and
Roblox Studio. Set `OPENROUTER_API_KEY` in the environment used to start Forge.

```sh
npm install
npm --prefix dashboard install
npm run build:all
node bin/forge.js creator serve --default-model meta/muse-spark-1.3-contributor
```

`build:all` compiles the service and dashboard, prepares pinned analysis and formal
tools, and installs the connector at
`~/Documents/Roblox/Plugins/ForgeStudioPlugin.rbxmx`. Restart Studio after every
connector rebuild.

1. Open a place in Studio and grant the connector permissions it requests.
2. Open the one-time dashboard link printed by the service and wait for
   **Studio ready**.
3. For an unlinked local place, choose **Link project**, then save the place so
   its project ID persists.
4. Send a request. Accept the plan, ask for a change, or reject it.
5. Inspect and save the applied result in Studio. Use ordinary Play and Stop when
   useful, then continue in the same conversation.

Keep the service running while admitted work is active. Closing the browser does
not stop a job, and restarting the service never silently retries a provider call
or Studio effect.

## Creator workflow

- Projects follow the `_forgeProjectId` saved on `Workspace`, not filenames.
  Renaming a project or conversation changes only its display label. A saved copy
  keeps the original identity until the creator explicitly forks it.
- Each conversation has independent history, preferences, drafts, and compaction
  handoffs. Current Studio/source observations always outrank remembered project
  state.
- Planning is read-only. **Accept plan** authorizes Build and automatic Apply only
  within that immutable plan. **Change plan** starts a revised proposal; **Reject
  plan** ends the proposal without editing Studio.
- Public progress and model/tool usage appear in expandable Activity. Exact diffs,
  checks, traces, and recovery evidence live in Details. Private reasoning is not
  displayed.
- Browser delivery ambiguity, interrupted provider work, and uncertain Studio
  recordings are resolved from retained state. Only the recovery action supported
  by that state is offered; uncertain effects are never guessed or auto-retried.

## Project safety

The host owns approval and orchestration; the fixed plugin owns Studio writes.
Every accepted plan fixes permitted targets, operations, capability/compiler locks,
and project revision. The builder stages a virtual graph. The plugin independently
recompiles the projection, runs detached preflight, records a bounded transaction,
performs direct readback, and reconciles the complete observed project delta.
Missing evidence stops publication.

The default writer is the open Studio document. The optional `--project-authority`
adapter permits only declared regular Luau roots with fail-closed paths, exact hash
replacement, and explicit absent-file creation. A plan never mixes writers for one
change set.

## Repository layout

| Path                                      | Purpose                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `dashboard`                               | React conversation workspace                                            |
| `packages/creator-*`                      | Loopback service, durable conversations, and creator orchestration      |
| `packages/agent-runtime`                  | Provider-neutral model/tool loop, budgets, journals, and compaction     |
| `packages/game-*`                         | Generic game IR, compiler, composition recipes, and locked Luau runtime |
| `packages/studio-*`, `plugin`             | Capability policy, protocol, fixed Studio readers/writers, and recovery |
| `packages/asset-registry`, `workers/cube` | Optional reviewed visual-asset research pipeline                        |
| `examples`, `test`                        | Disclosed solution-free seeds and fixed offline/native fixtures         |

Generic harness packages must not import examples, evaluator fixtures, generated
solutions, or Studio registries. Provider SDK types stop at the transport adapter.

## Develop and verify

Prepare a checkout with:

```sh
npm install
npm --prefix dashboard install
npm run formal:setup
npm run source-analysis:setup
```

The required completion gate is:

```sh
npm run format && npm run lint
npm run build && npm run plugin:build
npm test
git diff --check
```

`npm test` checks formatting and lint, generated data and docs, TypeScript and the
dashboard production build, backend Node tests, plugin parsing and
modules, datatype codecs, temporary-output Rojo builds, runtime identities, pinned
tools, and TLA+ models. It uses fake providers and isolated stores; it makes no
model request and never operates Studio. Frontend test suites are not part of this
repository or its completion gate. Temporary Rojo builds never replace the installed connector; always finish
with `npm run plugin:build`.

Edit policy/generator sources and regenerate these outputs rather than editing them
by hand:

- `packages/studio-evidence/src/generated.ts`
- `packages/studio-evidence/src/roblox-api-catalog.generated.ts`
- `plugin/src/Forge/GeneratedStudioEvidence.luau`
- `packages/studio-evidence/catalog/`
- `packages/studio-evidence/manifest/studio-capability-manifest.json`
- `packages/luau-toolchain/roblox/`

The authored capability policy is
`packages/studio-evidence/manifest/studio-capability-policy.json`. The explicit
networked catalog refresh is `npm run roblox-api-catalog:refresh`; normal builds do
not fetch Roblox documentation. Store changes are clean breaks. Preserve a verified
external snapshot before an authorized `.forge` purge; do not add migration readers.

At handoff, report changed/deleted files, commands and actual results, model/Studio
calls, unresolved claims, and the next smallest evidence-producing check.

## Manual fixtures

Build a solution-free seed to a previously absent path, open it in Studio, and do
not leave Rojo connected because Studio is the writer:

```sh
test ! -e /tmp/forge-door-control.rbxlx && rojo build examples/door-control/default.project.json -o /tmp/forge-door-control.rbxlx
test ! -e /tmp/forge-status-beacon.rbxlx && rojo build examples/status-beacon/default.project.json -o /tmp/forge-status-beacon.rbxlx
test ! -e /tmp/forge-airlock.rbxlx && rojo build examples/orbital-freight-airlock/default.project.json -o /tmp/forge-airlock.rbxlx
test ! -e /tmp/forge-last-light.rbxlx && rojo build examples/last-light/default.project.json -o /tmp/forge-last-light.rbxlx
```

Use Door Control for a small prompt/plan/Apply check, Status Beacon for a first
prompt-only session, and Orbital Freight Airlock for a multi-source authority and
recovery check. Last Light is the visual-world vertical slice defined in
[Visual generation](docs/VISUALS.md#last-light-vertical-slice); its clean seed has
no prepared world or gameplay. The authored observatory JSON under
`examples/visual-composition` is a disclosed compiler fixture, not a generated or
native visual result.

For native capability characterization, build the fixed fixture and connector:

```sh
test ! -e /tmp/forge-native-conformance-fresh.rbxlx && rojo build test/fixtures/studio-native-conformance/default.project.json -o /tmp/forge-native-conformance-fresh.rbxlx
npm run plugin:build
```

The user closes/reopens Studio, opens that place in Edit mode, opens **View →
Command Bar**, and runs:

```luau
require(game:GetService("ServerStorage").ForgeNativeConformance).run()
```

Proceed only after the `FORGE_NATIVE_CONFORMANCE` report says `passed`. Save,
close, reopen the exact place, and run:

```luau
require(game:GetService("ServerStorage").ForgeNativeConformance).verifyReopen()
```

Save again and export to a previously absent report path:

```sh
lune run scripts/export-native-conformance.luau /tmp/forge-native-conformance-fresh.rbxlx /tmp/forge-native-conformance-evidence.json
```

Return the output for review. This fixture characterizes construction, detached
preflight, readback, and save/reopen; it does not exercise the connector transaction,
undo/redo, gameplay, or visual-asset import. All Studio steps are user-run.

## Documentation

| Document                             | Authority                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------- |
| [Architecture](docs/ARCHITECTURE.md) | Implemented components, contracts, and data flow                           |
| [Product principles](docs/FORGE.md)  | Product thesis, creator interaction, and invariants                        |
| [Visual generation](docs/VISUALS.md) | Blender direction, spatial composition, Cube/CubePart, and visual evidence |
| [Evaluation policy](docs/EVALS.md)   | Evidence tiers and claim vocabulary                                        |
| [Roadmap](docs/ROADMAP.md)           | Remaining work and acceptance criteria                                     |
| [Research](docs/RESEARCH.md)         | Foundational rationale and immutable historical evidence                   |

Run `node bin/forge.js` for the complete CLI command reference.
