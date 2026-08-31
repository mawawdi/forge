# Forge engineering rules

Keep this file operational. Documentation authority is split deliberately:

- `docs/FORGE.md` defines current architecture and product thesis.
- `docs/EVALS.md` defines evaluation policy and claim semantics.
- `docs/ROADMAP.md` defines demonstrated status and next work.
- `docs/RESEARCH.md` indexes foundational rationale and historical evidence.

- Make clean breaks. Delete superseded schemas, commands, packages, and storage paths; do not add compatibility readers, migrations, deprecated aliases, or old/new fallbacks.
- Inspect implementation and tests before changing architecture. If code and `docs/FORGE.md` disagree, investigate and update the authoritative side explicitly.
- Keep indexed research focused on current rationale or unique evidence. Preserve exact run identities and failure classifications when consolidating old material, and use `docs/RESEARCH.md` to distinguish predecessor evidence from current behavior.
- Preserve the semantic-authority boundary: creator requests, observations, platform policies, agent hypotheses, evaluator criteria, and benchmark oracles are distinct. Never expose hidden evaluator material to the builder.
- Keep generic harness packages independent of examples, evaluator fixtures, mechanic adapters, repair solutions, and Studio registries.
- Keep model orchestration in `ForgeNativeAgentRuntime`; keep provider transports one-turn and replaceable. No provider SDK types may enter the native runtime or contracts.
- Keep workspace access bounded to declared roots, regular Luau source, hash-guarded replacement, explicit absent creation, and fail-closed path/symlink handling.
- Use `eligible`, `rejected`, and `incomplete` for the local gate. Use `locally_eligible` only for an AgentRun/candidate outcome. Never describe a candidate as Studio-verified without an authoritative Studio evaluation.
- Keep Studio plans canonical JSON data interpreted by fixed Forge runner source. Do not add arbitrary code, expressions, callbacks, generic property access, or mechanic-specific harnesses.
- The user runs all Roblox Studio checks. Never launch or operate Studio. Provide the exact commands, generated place path, plugin version, and click sequence, then wait for the user's result.
- Use `apply_patch` for repository edits. Preserve unrelated dirty work. Avoid broad or destructive targets; create an external rollback snapshot before an authorized purge.
- Run `git diff --check`, TypeScript build, current Node tests, plugin parse/analyze/module tests, and a temporary-output Rojo build before completion. Do not make model calls or Studio runs during tests.
- Report what changed, commands actually run, exact test results, model/Studio calls actually made, unresolved claims, and the next smallest evidence-producing task.
