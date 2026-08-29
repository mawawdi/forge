# Lemonade Forge

Lemonade Forge is a verified, model-agnostic Roblox game compiler. Milestone 1 is a local deterministic verifier around the official Luau analyzer.

## Prerequisites

- Node.js 22+
- the official `luau-analyze` executable on `PATH` or `FORGE_LUAU_ANALYZE` pointing to it

On macOS with Homebrew:

```bash
brew install luau
```

## Run

```bash
npm install
npm run build
npm link
forge verify ./examples/insecure-tycoon
```

The insecure fixture is expected to exit with status 1 and report structured Luau and Roblox client/server diagnostics. A clean control fixture exits zero:

```bash
forge verify ./examples/clean-tycoon
```

Every invocation also writes a privacy-minimized Flight Recorder trace to `.forge/flight-recorder` and emits its ID on stderr. Inspect one with:

```bash
forge trace show <trace-id>
```

Use `--format json` explicitly when integrating with another tool, and `--trace-dir <path>` to direct local trace artifacts elsewhere. M1 does not invoke a model or Roblox Studio, and it does not claim to verify Roblox physics or runtime replication.

## Test

```bash
npm test
```
