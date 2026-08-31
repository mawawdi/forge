# Forge

Forge is a Roblox agent harness that lets a model inspect and edit a bounded project, independently verifies the resulting candidate, and evaluates factual runtime outcomes through a generic Roblox Studio capability boundary.

Documentation is divided by authority:

- [Architecture and thesis](docs/FORGE.md)
- [Evaluation policy](docs/EVALS.md)
- [Current roadmap and status](docs/ROADMAP.md)
- [Research and evidence index](docs/RESEARCH.md)

## Setup

Requirements: Node.js 22+, npm, `luau-compile`, `luau-analyze`, `luau-lsp`, Lune, Rojo, and Roblox Studio for user-run runtime checks.

```sh
npm install
npm run build
```

Real agent builds require `OPENROUTER_API_KEY` in the process environment or the repository-root `.env`, plus an explicit `--model`. Forge never persists the key or raw reasoning continuation. The consumed MovingPlatform experiment used `openai/gpt-5.6-terra`; any future real run requires a separately reviewed experiment.

## Tests

```sh
npm test
```

This runs the TypeScript build, all Node tests, plugin parsing and analysis, and plugin module tests. It does not call a model or launch Studio.

To build the plugin without writing a tracked bundle:

```sh
tmp_plugin="$(mktemp -d)/ForgeStudioPlugin.rbxmx"
rojo build plugin/default.project.json -o "$tmp_plugin"
```

## Architecture

```text
RequirementSet -> native bounded builder -> sealed candidate
                                      |-> independent local verifier
                                      `-> Studio facts -> backend grader -> RuntimeProofBundle
```

The builder has eight Forge-owned tools, an agent-authored plan, deterministic budgets, and an isolated source workspace. Studio accepts only the three versioned capabilities `instance.resolve@1`, `base_part.position@1`, and `base_part.position_series@1`; it does not accept arbitrary Luau.

## Demonstrated evidence

The local suite covers semantic-authority leakage, native multi-turn tool use and verifier-feedback repair, provider/budget failures, safe source creation, candidate immutability, Roblox-aware verification, protocol-v12 correlation and malicious payloads, factual position grading, and scoped runtime proof construction.

The user-run protocol-v12/plugin-8.0.0 capability canary completed and established the bounded Studio observation substrate only. The sole MovingPlatform model trial crossed its irreversible boundary but ended incomplete before producing a candidate because Forge did not expose its declared writable source root to the model. No hidden Studio evaluation or runtime verdict exists. The next task is the harness regression described in [docs/ROADMAP.md](docs/ROADMAP.md#immediate-next-task), not a retry.

## CLI

```text
forge agent build
forge candidate evaluate
forge studio canary
forge studio bridge
forge verify
forge trace show
```
