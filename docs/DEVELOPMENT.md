# Forge Development Guide

This guide defines the repository workflow. Product and evidence semantics remain authoritative in [Architecture](ARCHITECTURE.md), [Forge invariants](FORGE.md), and [Evaluation policy](EVALS.md).

## Required toolchain

- Node.js 22 or newer and npm
- Java 11 or newer for TLC
- Rojo, Lune, `luau-compile`, and `luau-lsp`
- the pinned source-analysis and TLA tools installed by the setup commands in the root README

## Working rules

- Make schema and protocol changes as clean replacements. Do not retain legacy readers, aliases, or migrations.
- Preserve unrelated work in the dirty tree. Use `apply_patch` for authored source changes.
- Keep provider-specific types inside provider adapters. Native runtime and public contracts remain provider-independent.
- Keep indexed project facts distinct from typed mutation authority. An unsupported class may be inventoried without becoming writable.
- Treat generated files as build products. Change their source manifest or generator, then regenerate them.
- Do not invoke a model or operate Roblox Studio from automated validation. Studio evidence is produced only by the user-run flow.

## Generated and pinned files

Do not hand-edit these paths:

- `packages/studio-evidence/src/generated.ts`
- `packages/studio-evidence/src/roblox-api-catalog.generated.ts`
- `plugin/src/Forge/GeneratedStudioEvidence.luau`
- `packages/studio-evidence/catalog/`
- `packages/studio-evidence/manifest/studio-capability-manifest.json`
- `packages/luau-toolchain/roblox/`

The capability policy and generation scripts are the authored inputs. `npm run studio-evidence:check` and `npm run roblox-api-catalog:check` reject stale output, while `npm run roblox-api-coverage:check` independently proves that every pinned API row appears exactly once with a valid disposition and no restricted enum leaks into direct authoring.

## Quality workflow

Before changing code:

```sh
npm install
npm --prefix dashboard install
npm run formal:setup
npm run source-analysis:setup
```

During development:

```sh
npm run format
npm run lint
npm run build
```

Before handoff:

```sh
npm test
npm run plugin:build
git diff --check
```

`npm test` is check-only. It verifies formatting, lint, generated output, documentation and Mermaid links, TypeScript, the dashboard, Node tests, Luau parsing and analysis, plugin module tests, temporary Rojo builds, runtime-build identity, and every TLC model. `npm run format` is the explicit mutating formatter command.

When a gate fails, fix the authored source rather than weakening the gate or editing generated output. Report every command actually run and whether any model or Studio action occurred.
