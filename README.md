# Lemonade Forge

Lemonade Forge is a verified, model-agnostic Roblox game compiler. M2.5 adds canonical project semantics, explainable context selection, and candidate mechanic-capability records around the contracted repair loop.

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

M2 can deterministically repair the bounded `CollectFruit` fixture into a new output directory:

```bash
forge repair ./examples/collect-fruit/vulnerable \
  --contract ./examples/collect-fruit/contracts/MechanicContract.json \
  --out ./tmp/collect-fruit-repaired
```

The command rejects the vulnerable input, applies an exact hash-checked one-file patch atomically, and re-runs official Luau and semantic verification. Its ProofBundle records static/semantic success while remaining `incomplete` until pure-Luau preflight and Roblox Studio are run.

Use `--format json` explicitly when integrating with another tool, and `--trace-dir <path>` to direct local trace artifacts elsewhere. M1 does not invoke a model or Roblox Studio, and it does not claim to verify Roblox physics or runtime replication.

M3 includes a source-installable Studio Plugin and a real Studio target under `examples/collect-fruit/studio`. Build the place with Rojo, open it in Studio, then start the local bridge:

```bash
rojo build ./examples/collect-fruit/studio/default.project.json --output /tmp/ForgeCollectFruit.rbxlx
node bin/forge.js studio bridge
```

The plugin's seven assertion results are authoritative only after an actual Studio playtest through the paired plugin; local tests and pure Luau execution never substitute for that run.

## Test

```bash
npm test
```
