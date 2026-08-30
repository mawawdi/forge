# Forge

Forge is a Roblox-specific agent harness and evaluation system. It gives game
building agents bounded tools and independently records what can actually be
claimed about a candidate.

The repository preserves the completed M1–M3.5 compiler/Studio vertical slice
as historical regression evidence. Post-M3.5 work moves toward a tool-using
builder over observed project state; it does not pre-design every mechanic.

Read [the research report](docs/deep-research-report.md) for the transformation
direction, [the specification](docs/SPEC.md) for current claims, and
[the roadmap](docs/ROADMAP.md) for milestone status.

## Prerequisites

- Node.js 22+
- `luau-compile` on `PATH` (or `FORGE_LUAU_COMPILE`)
- Rokit tools from `rokit.toml`, including `luau-lsp` and `rojo`

On macOS with Homebrew:

```bash
brew install luau
rokit install
npm install
```

## Local verification

```bash
npm run build
forge verify ./examples/insecure-tycoon
forge verify ./examples/clean-tycoon
```

The insecure control must reject. The clean control must pass local checks.
Each invocation persists a privacy-minimized BuildTrace under
`.forge/flight-recorder`; inspect it with:

```bash
forge trace show <trace-id>
```

Local verification is not Roblox runtime proof.

## Bounded builder experiment

M4.1 exposes a single-agent build command:

```bash
forge agent build <project> \
  --prompt "<creator request>" \
  --requirements <requirement-set.json> \
  --format json
```

The agent sees only a source-free orientation and Forge-owned bounded tools.
It edits an isolated candidate workspace, never the seed. The final local gate
is always independent of the agent’s own verifier use. `locally_eligible` does
not mean Studio-verified; M4.1 records `studio: not_run`.

The current canonical requirement set is
`tasks/m4.1-collect-authority.requirements.json`. A new real run requires a
reviewed experiment configuration; the sole recorded Claude-adapter attempt
stopped before a model call because credentials were unavailable.

## Tests

```bash
npm test
```

This runs Node and plugin tests. It does not launch Roblox Studio or call a
model.
