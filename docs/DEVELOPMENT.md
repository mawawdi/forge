# Forge Development

Use this guide for repository setup and verification. [Architecture](ARCHITECTURE.md),
[Product principles](FORGE.md), and [Evaluation policy](EVALS.md) own system behavior.

## Toolchain

Install Node.js 22+, npm, Java 11+, Rojo, Lune, `luau-compile`, and `luau-lsp`.
The setup commands install verified pinned analysis and TLA+ assets in `.forge/tooling`.
Studio is required for manual acceptance, not automated tests.

```sh
npm install
npm --prefix dashboard install
npm run formal:setup
npm run source-analysis:setup
```

`source-analysis:setup` prepares the pinned Rojo/Luau LSP tools. The creator service
also prepares a missing cache at startup. Existing cache content is verified rather
than silently overwritten. `formal:setup` prepares the pinned official TLC JAR;
`formal:check` uses it offline.

## Make changes

- Read the applicable `AGENTS.md` and implementation before changing contracts.
- Preserve unrelated uncommitted work. Use `apply_patch` for authored edits.
- Replace superseded formats outright; do not add migration or compatibility readers.
- Keep provider types at the transport boundary and evaluator material out of builders.
- Keep typed mutation authority separate from broad project inventory.
- Preserve a checksum-verified external snapshot before an authorized store purge.
- Keep scratch scripts, logs, generated places, and private traces out of the repository.

`dashboard` is the browser app; there is no `apps` directory. Backend code lives in
`packages`, plugin code in `plugin`, and isolated test fixtures in `test` and `examples`.

## Generated files

Edit the policy or generator, then regenerate. Do not hand-edit:

- `packages/studio-evidence/src/generated.ts`
- `packages/studio-evidence/src/roblox-api-catalog.generated.ts`
- `plugin/src/Forge/GeneratedStudioEvidence.luau`
- `packages/studio-evidence/catalog/`
- `packages/studio-evidence/manifest/studio-capability-manifest.json`
- `packages/luau-toolchain/roblox/`

The authored capability policy is
`packages/studio-evidence/manifest/studio-capability-policy.json`.
`roblox-api-catalog:refresh` is the explicit networked update path for the pinned
Roblox source; ordinary builds do not fetch Roblox documentation. Catalog,
capability, coverage, and runtime-build checks reject stale or inconsistent output.

## Required verification

```sh
npm run format && npm run lint
npm run build && npm run plugin:build
npm test
git diff --check
```

`npm run format` applies the pinned formatter. `npm test` checks formatting and lint,
validates pinned/generated data and documentation links, renders Mermaid diagrams,
builds TypeScript and the dashboard, runs Node and dashboard tests, exercises browser
accessibility/interaction tests, checks plugin parsing/types/modules/codecs, builds
all Rojo fixtures in a temporary directory, and checks the formal models with TLC.
These tests make no model requests and do not operate Studio.

Tests create isolated temporary stores. Do not weaken a gate or delete a useful
regression to obtain a pass. When a UI change intentionally changes a screenshot,
review the new image before replacing its baseline. Keep behavior and accessibility
assertions alongside visual coverage.

`build:all` is the convenience build/setup path. `plugin:build` always installs the
connector directly at `~/Documents/Roblox/Plugins/ForgeStudioPlugin.rbxmx`.
Temporary Rojo output is verification material, not the installed plugin.

## Manual acceptance

Restart Studio after each plugin rebuild, then reopen the intended saved place.
Start `creator serve` and use its one-time dashboard link. Follow the creator flow
in [Creator experience](CREATOR-EXPERIENCE.md). Use the current project's existing
conversation for follow-ups; do not reset `.forge` to work around a recoverable issue.

Recover any possibly open transaction with its exact connector build before changing
contracts. Keep model selection, reasoning, and response deadlines explicit in live
measurements. Preserve exact run identities, artifacts, and failure classifications.

At handoff, report changed/deleted files, commands and actual results, model/Studio
calls made, unresolved claims, and the next smallest manual check. Automated success
alone does not establish a clean generated game.
