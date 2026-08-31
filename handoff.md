# Forge Handoff

This document is the operational handoff for continuing Forge development. The canonical product and architecture documents remain:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — implemented and target architecture.
- [`docs/FORGE.md`](docs/FORGE.md) — product thesis, invariants, and non-goals.
- [`docs/EVALS.md`](docs/EVALS.md) — evaluation policy and claim semantics.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — demonstrated status, historical evidence, and next work.
- [`docs/RESEARCH.md`](docs/RESEARCH.md) — rationale and research index.

## Current position

Forge now has a successful prompt-only creator vertical slice. A creator opened the Status Beacon fixture in Roblox Studio, submitted only a natural-language prompt, reviewed and approved a generated plan, reviewed and approved an exact typed change set, authorized Studio checks, visually reviewed the result, and accepted it. Studio remained the only persistent writer.

Repository baseline at handoff creation:

- Branch: `main`
- Commit: `93a4583201ea3f6d6d7381b8dec2097c1d1cc67f`
- The working tree was clean before this file was added.
- Forge intentionally has no schema, protocol, plugin, or release-version fields/readers. Contract identity comes from `kind`, canonical content hashes, capability-set identities, and clean replacement of old shapes.

Repository hygiene after the final cleanup:

- `examples/status-beacon` is the only retained product example.
- Moving Platform and Vertical Shuttle example packages were removed. Their names remain only where historical evidence is discussed.
- Registered-experiment regressions construct synthetic treatments in test code rather than relying on hand-authored product examples.
- Generated connector binaries are not retained in the repository or `.forge/artifacts`; build them to temporary output when needed.
- `.forge/artifacts` retains only the Status Beacon place and its lock file.
- Historical AgentRuns, traces, registrations, candidates, runtime evaluations, proofs, canaries, and creator sessions remain untouched.

## Product boundaries

The intended product split is:

- A future web dashboard owns prompts, artifact review, approvals, progress, and history.
- The Forge control plane owns orchestration, model execution, policy, evidence, and grading.
- The Studio plugin is a thin trusted connector for snapshots, typed mutation, ChangeHistory recording, Play Solo, diagnostics, and rollback.
- A `CreatorAgentWorker` boundary isolates planner/builder execution from coordination. The current implementation is `LocalCreatorAgentWorker` with `local_process` and no isolation.
- Future microVMs may isolate non-Studio agent and local-evaluation work. They cannot replace authoritative Roblox Studio runtime observation.

The normal creator product requires only an open Studio place and a creator prompt. Registered experiments intentionally require preregistered evaluator, seed, budget, model, and implementation material; that scaffolding is not ordinary creator UX.

## Implemented creator flow

The current path is:

1. Studio pairs with the local Forge creator service and provides a bounded snapshot with stable identities.
2. A read-only planner inspects exact paths and proposes typed changes plus a verification charter.
3. Forge validates the proposal before it reaches approval.
4. Creator plan approval produces a content-addressed `CreatorBuildContract`.
5. A typed builder supplies only the creative payload permitted by that contract.
6. Forge canonicalizes natural model-facing JSON into Studio's actual storage domain and runs the local gate.
7. The creator approves the exact change set; Studio applies it inside one open ChangeHistory recording.
8. Forge reconciles a fresh post-apply snapshot with the approved change set.
9. The creator authorizes the exact Studio checks. Forge commits on machine-check success or cancels and repairs/rolls back on failure.
10. The creator visually reviews the committed result and accepts it or rejects and rolls it back.

Consent remains distinct at plan approval, exact change approval, playtest initiation, and final acceptance. The plugin and CLI consume the same `CreatorControlView`; workflow legality is coordinator-owned rather than inferred from display strings.

## Demonstrated successful session

The accepted prompt was:

> Add a status beacon above Generator that alternates green and red every second while the game is running. Preserve PreservedTree.

Final evidence:

- Session: `creator_session_ad50593a-e0f1-4651-95f4-c88b3b5f6242`
- Session status: `creator_accepted`
- Session artifact: `.forge/creator-sessions/creator_session_ad50593a-e0f1-4651-95f4-c88b3b5f6242.json`
- Plan: `creator_plan_ea7f9617b3c2c33933fc2bc6`
- Plan hash: `ea7f9617b3c2c33933fc2bc6818c9ada801a39b9701318ce4e46ead94f128cc8`
- Build contract: `creator_build_contract_816c4584f89ad8ed72abb2e9`
- Build-contract hash: `816c4584f89ad8ed72abb2e9533bcdc7e3a2beba75a549d27dabb968497919a7`
- Change set: `creator_change_set_9a546962a40226a512c86a76`
- Change-set hash: `9a546962a40226a512c86a7610e4fd4d56c07c624618d428813f207fbdf7948d`
- Initial Studio revision: `1486c8986bdf1fd40db6cbd43030a29f8f3c4faf856b2149efdfe72b88bb0806`
- Final Studio revision: `360c3e26d94c868fa2441badad2be1282b82ffa13f1729f7d88a523045c6aff3`
- Verification charter: `verification_charter_94d363527bc302cf8ff373a7`
- Verification record: `creator_verification_f6a9c0c5f1b07e5a6b57eeb9`
- Verification-record hash: `f6a9c0c5f1b07e5a6b57eeb96c5cd302eeeef89c02ac0160dd354a6f0c24471c`
- Verification status: `passed`, with no failure facts.
- Checkpoint: `creator_checkpoint_cb96fdbafb2f14f8aeac1e5d`
- Checkpoint status: `committed`
- Final review: `creator_review_4ac1d95c5f5a797d8bc8bba9`
- Final review decision: `accepted`
- Repairs used: `0`

Planner evidence:

- AgentRun: `agent_run_789d36a5-25a8-447e-9d04-fb417991fc21`
- AgentRun hash: `52f96557fb1d5056377f6905af3a2d753432c2bbffcd9705dc09574bc42061c2`
- Trace: `trace_f3b55c17-1ad7-4d55-8f27-89373683fa80`
- Trace hash: `27cb87ceb6589c1a2c7770af8e8bcddbc217d4ebbb6a6a818d27cec4b2fdcb2e`
- Outcome: sealed plan, `locally_eligible`, three provider calls.

Builder evidence:

- AgentRun: `agent_run_a62cb929-4d7d-4f98-a2cb-b47356991d03`
- AgentRun hash: `398aedf0104158e1075fc442f5281f645517c32a6d008b7ffe06e3429d631b53`
- Trace: `trace_46e23d99-05c8-4abf-906b-c9e457e393b6`
- Trace hash: `71d0eed4a94d6c0a2a65ab8677269ff5cc87c4fd6d47ca5b0fa7f0baafdd9137`
- Outcome: sealed change set, `locally_eligible`, four provider calls.

The four artifact hashes above were recomputed from disk and match the session locators exactly.

## What the successful run established

The saved final Studio snapshot establishes that:

- `Workspace/StatusBeacon` exists as a `Part` at `(0, 8, 0)`.
- It is anchored, neon, non-collidable, non-touching, opaque, and sized `2 × 2 × 2`.
- `ServerScriptService/StatusBeaconController` exists as an enabled server `Script`.
- Its observed source hash is `635558014e6df3e3105740506e37c1218d438fd02dbd49c8c5c665de45549d26`, exactly matching the approved source.
- The bounded `Workspace/PreservedTree` snapshot passed its unchanged check.
- The complete approved playtest passed the zero-error, zero-warning, non-truncated diagnostics threshold.
- The creator reported that the beacon looked correct in Studio, observed its green/red alternation, and accepted the exact result.

Do not overstate the claim. Alternation timing and visual quality were creator-reviewed facts, not machine-observed color-series facts. The AgentRun traces correctly say `runtimeGate: not_run` because they cover the planner and builder phases; Studio verification is represented separately by the creator verification record.

## Immediate evidence gaps

Two general audit-quality gaps were found while checking the successful run:

1. The creator-session bundle retains hashes for the Studio runtime observation and diagnostics but not their canonical bodies. The verification status and bindings are preserved, but a later auditor cannot independently replay grading from the saved bundle alone.
2. Planner and builder traces report identical `startedAt` and `endedAt` timestamps and zero-duration spans even though their aggregate latencies are `14697 ms` and `13773 ms`. Content and hash linkage are intact, but trace timing is not useful.

The next implementation should fix these generically rather than special-casing Status Beacon:

- Persist the complete bounded `RuntimeObservationEnvelope` and diagnostics material as immutable evidence, or persist independently addressable canonical artifacts whose bytes are available by their recorded hashes.
- Bind those artifact locators into `CreatorVerificationRecord` and the session evidence graph.
- Make verification replayable from persisted charter, execution plan, observation, and diagnostics without contacting Studio.
- Record real planner, builder, provider-turn, and tool-call start/end times and durations in traces.
- Add regressions that fail if a trace has impossible timing or a passed Studio verification lacks retrievable observation material.

After that, run one genuinely different prompt-only creator scenario. Do not repeat Status Beacon merely to accumulate another success.

## Important implementation files

- `packages/creator-session/src/index.ts` — creator contracts and validation.
- `packages/creator-session/src/coordinator.ts` — lifecycle, Studio actions, verification, checkpointing, and review.
- `packages/creator-session/src/worker.ts` — planner/builder worker seam and local worker.
- `packages/native-agent-runtime/src/` — model orchestration and trace materialization.
- `packages/studio-capabilities/src/` — fixed Studio capability plans and runtime observation contracts.
- `packages/studio-protocol/src/` — connector messages and authenticated session transport.
- `plugin/src/Forge/StudioAuthoring.luau` — typed Studio mutation and storage-domain handling.
- `plugin/src/Forge/StudioInstancePolicy.luau` — shared snapshot/identity scope.
- `plugin/src/Forge/SnapshotCollector.luau` — bounded Studio facts and revision hashes.
- `plugin/src/Forge/IdentityRegistry.luau` — stable instance identities.
- `test/creator-session.test.ts` — creator lifecycle and regression coverage.
- `scripts/test-plugin-modules.luau` — pure/plugin module regression coverage.

## Commands for a fresh local validation

Automated validation must not make a provider request or operate Roblox Studio.

```sh
git diff --check
npm test
```

Also render every Mermaid block in `docs/ARCHITECTURE.md`, check local Markdown links, and build the plugin and any test place to temporary output paths:

```sh
rojo build plugin/default.project.json -o /tmp/ForgeStudioPlugin.rbxmx
rojo build examples/status-beacon/default.project.json -o /tmp/StatusBeacon.rbxlx
```

Only after explicit user authorization for a new live run:

```sh
node bin/forge.js creator serve --model openai/gpt-5.6-luna
```

The user, not Forge or Codex, opens Studio, pairs the connector, approves artifacts, starts checks, observes the result, and accepts or rolls it back.

## Constraints for the next agent

- Preserve semantic-authority boundaries. Evaluator bodies never enter builder messages.
- Keep generic harness packages independent of examples and evaluator fixtures.
- Make clean breaks; do not add compatibility readers, migrations, deprecated aliases, or old/new fallbacks.
- Do not restore schema, protocol, plugin, or release versioning.
- Keep Studio plans as canonical JSON interpreted by fixed trusted runner code. Never add arbitrary evaluator or model-authored execution code.
- Preserve all historical AgentRuns, traces, registrations, Studio outcomes, and rejected sessions unchanged.
- Never launch or operate Roblox Studio. Give the user exact paths and click instructions.
- Do not make a provider/model call without explicit authorization.
- Use `apply_patch` for repository edits and preserve unrelated work.

## Historical context

`docs/ROADMAP.md` records six consumed Status Beacon failures and their classifications. They demonstrated, in order, invalid planning/UI design, missing builder failure evidence, an underpowered planning contract, hidden builder contract information, model-facing tagged property leakage, and Studio color-storage mismatch. Those sessions are immutable historical evidence. The accepted session above is the first complete creator-path success after those generalized corrections.
