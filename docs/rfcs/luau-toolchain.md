# RFC: Roblox-Aware Luau Toolchain

Status: implemented for M3.25  
Date: 2026-08-30

## Decision

Forge separates language validity from host-environment type validity:

1. `luau-compile --only-parse` provides official Luau syntax diagnostics.
2. `luau-lsp analyze --platform=roblox` provides Roblox-aware type diagnostics
   using a deterministic Rojo sourcemap, the project `.luaurc`, and vendored
   Roblox globals/type declarations.
3. M2 consumes the resulting semantic map independently. It does not infer that
   a type-checking success proves server authority or runtime behavior.

The pinned development tools are declared in `rokit.toml`. The vendored Roblox
definitions are described by
`packages/luau-toolchain/roblox/definitions.json`, including their upstream
source commit, Luau LSP version, and SHA-256. Each verification report records
the syntax binary hash, Luau LSP and Rojo versions, definition hash, sourcemap
hash, and `.luaurc` hash.

## Failure classification

Forge keeps three source/tool classifications distinct:

- invalid Luau syntax or language typing is a source diagnostic from official
  Luau tooling;
- invalid Roblox API/type usage is a source diagnostic from the Roblox-aware
  host tier;
- unavailable or incomplete Roblox globals, definitions, sourcemap, or analyzer
  infrastructure is a tooling issue and makes the gate `incomplete`.

The third class must never be reported as a source `LUAU_TYPE_ERROR`. Forge has
no generic-Luau fallback for Roblox projects.

## Diagnostic identity

Normalized diagnostics retain relative path, start line/column, end line/column,
rule code, severity, and message. Deduplication includes location, so two
diagnostics on the same line but at different columns remain distinct.

## Upgrade policy

Tool or definition upgrades are hard schema/configuration cuts. Update the pin,
definition metadata, expected hashes, and regression evidence together. Do not
add compatibility readers for old diagnostic or definition formats.
