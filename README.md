# Lemonade Forge

Lemonade Forge is a verified, model-agnostic Roblox game compiler. It combines bounded model-authored candidates with deterministic project interfaces, Roblox-aware verification, and authoritative StudioProof evidence.

## Prerequisites

- Node.js 22+
- the official `luau-compile` executable on `PATH` or `FORGE_LUAU_COMPILE` pointing to it
- [Rokit](https://github.com/rojo-rbx/rokit) for the pinned `luau-lsp` and `rojo` tools in `rokit.toml`

On macOS with Homebrew:

```bash
brew install luau
rokit install
```

## Run

```bash
npm install
npm run build
npm link
forge verify ./examples/insecure-tycoon
```

Forge treats missing Roblox analyzer tooling, definitions, or sourcemap support
as an incomplete toolchain. It never converts a host-environment failure into a
source type error. See `docs/rfcs/luau-toolchain.md` for exact provenance.

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

Reverify the byte-preserved first Luna proposal without making a model call:

```bash
forge candidate reverify ./examples/collect-fruit/regressions/luna-first-pass
```

This regression currently passes official syntax and Roblox-aware types, then
is correctly rejected because its distance threshold is `12` rather than the
Forge-owned interface value `20`.

Run exactly one model repair against that preserved candidate—without a new
intent or initial-generation call—with:

```bash
forge candidate repair ./examples/collect-fruit/regressions/luna-first-pass \
  --model openai/gpt-5.6-luna
```

The command writes a private isolated candidate under the ignored
`.forge-generation-runs` directory, leaves the regression and clean seed
unchanged, runs all local gates, and prints an immutable candidate artifact
path. It never connects to Studio. If that artifact is locally verified, open
the generated-seed place, start the user-owned bridge, and run the exact
retained candidate with no second model call:

```bash
forge candidate studio /absolute/path/to/candidate_repair_<id>.json \
  --timeout-ms 180000
```

`candidate studio` verifies the artifact hash, seed preconditions, output
source hashes, contract/interface/PatchSet linkage, and current local gate
before it can enter the existing StudioProof transaction.
`candidate repair --format json` emits only the structured summary, so its
`artifactPath` can be passed directly into automation.

## Test

```bash
npm test
```
