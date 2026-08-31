# Forge

Forge is a Roblox agent harness that lets a model inspect and edit a bounded project, independently verifies the resulting candidate, and evaluates factual runtime outcomes through a generic Roblox Studio capability boundary.

Documentation is divided by authority:

- [Architecture: current implementation and goal](docs/ARCHITECTURE.md)
- [Product thesis and invariants](docs/FORGE.md)
- [Evaluation policy](docs/EVALS.md)
- [Current roadmap and status](docs/ROADMAP.md)
- [Research and evidence index](docs/RESEARCH.md)

## Setup

Requirements: Node.js 22+, npm, `luau-compile`, `luau-analyze`, `luau-lsp`, Lune, Rojo, and Roblox Studio for user-run runtime checks.

```sh
npm install
npm run build
```

Real agent builds require `OPENROUTER_API_KEY` in the process environment or the repository-root `.env`, plus an explicit `--model`. Forge never persists the key or raw reasoning continuation. The consumed MovingPlatform experiment used `openai/gpt-5.6-luna`; any future real run requires a separately reviewed experiment.

## Tests

```sh
npm test
```

This runs the TypeScript build, all Node tests, plugin parsing and analysis, and plugin module tests. It does not call a model or launch Studio.

Registered benchmark treatments are preflighted before any provider envelope:

```sh
forge experiment register examples/vertical-shuttle/seed \
  --prompt-file examples/vertical-shuttle/task/creator-prompt.txt \
  --requirements examples/vertical-shuttle/task/requirements.json \
  --acceptance examples/vertical-shuttle/task/acceptance.json \
  --runtime-plan examples/vertical-shuttle/task/evaluator/runtime-eval-definition.json \
  --model openai/gpt-5.6-luna \
  --output examples/vertical-shuttle/task/experiment-registration.json
forge experiment build examples/vertical-shuttle/seed \
  --registration examples/vertical-shuttle/task/experiment-registration.json
```

The registration is required again for `forge experiment evaluate`; it binds evaluator material without exposing it to the builder. Studio evaluation remains user-triggered.

To build the plugin without writing a tracked bundle:

```sh
tmp_plugin="$(mktemp -d)/ForgeStudioPlugin.rbxmx"
rojo build plugin/default.project.json -o "$tmp_plugin"
```

## Architecture

See [the canonical architecture](docs/ARCHITECTURE.md) for the implemented build and runtime-evaluation paths, the source-root correction from the consumed trial, and the explicitly unimplemented long-term target.

## Demonstrated evidence

The local suite covers semantic-authority leakage, native multi-turn tool use and verifier-feedback repair, provider/budget failures, safe source creation, candidate immutability, Roblox-aware verification, protocol-v12 correlation and malicious payloads, factual position grading, and scoped runtime proof construction.

The user-run protocol-v12/plugin-8.0.0 capability canary established the bounded Studio observation substrate. A fresh registered Vertical Shuttle Luna run produced one locally eligible candidate, and its single user-triggered Studio evaluation is `runtime_verified` for that exact registered treatment only. The sole MovingPlatform model trial remains incomplete before candidate creation because its pre-fix harness did not expose the declared writable source root; the consumed trial is not retried.

## CLI

```text
forge agent build
forge experiment register
forge experiment build
forge experiment evaluate
forge studio canary
forge studio bridge
forge verify
forge trace show
```
