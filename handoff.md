# Forge Handoff

This document is the operational handoff for continuing Forge development. The canonical product and architecture documents remain:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — implemented and target architecture.
- [`docs/FORGE.md`](docs/FORGE.md) — product thesis, invariants, and non-goals.
- [`docs/EVALS.md`](docs/EVALS.md) — evaluation policy and claim semantics.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — demonstrated status, historical evidence, and next work.
- [`docs/RESEARCH.md`](docs/RESEARCH.md) — rationale and research index.

## Current position

Forge now implements the auditable-evidence and dashboard-cutover milestone. Current creator sessions live only under `.forge/creator`; every referenced JSON artifact is content-addressed, retrievable, verified, and root-relative. Completed verification can be replayed without Studio, a model, or network access. Runtime traces contain real phase, provider-turn, and tool-call intervals. A standalone loopback control server serves the local React evidence workbench, while the Studio plugin is reduced to the trusted connector.

The accepted Status Beacon session remains important predecessor evidence, but it is not rewritten into the current shape. The next evidence-producing task is one distinct Door Control live run through the dashboard. That live run has not happened yet, so there is no current session ID, replay result, creator report, or new verification claim to preserve.

Repository hygiene after the final cleanup:

- `examples/status-beacon` remains the historical accepted seed; `examples/door-control` is the new solution-free live-proof seed.
- Moving Platform and Vertical Shuttle example packages were removed. Their names remain only where historical evidence is discussed.
- Registered-experiment regressions construct synthetic treatments in test code rather than relying on hand-authored product examples.
- Generated connector binaries are not retained in the repository or `.forge/artifacts`; build them to temporary output when needed.
- Historical AgentRuns, traces, registrations, candidates, runtime evaluations, proofs, canaries, and `.forge/creator-sessions` remain untouched and are not accepted by current readers.
- New sessions and immutable evidence use `.forge/creator`. Private CLI discovery for the dashboard server uses `.forge/creator-control.json`.

## Product boundaries

The intended product split is:

- The local React dashboard owns prompts, artifact review, approvals, progress, history, replay, and the required final creator report.
- The Forge control plane owns orchestration, model execution, policy, evidence, and grading.
- The Studio plugin is a thin trusted connector for snapshots, typed mutation, ChangeHistory recording, Play Solo, diagnostics, and rollback.
- A `CreatorAgentWorker` boundary isolates planner/builder execution from coordination. The current implementation is `LocalCreatorAgentWorker` with `local_process` and no isolation.
- The standalone `CreatorControlServer` owns browser/CLI authentication and the creator API; `StudioBridgeServer` owns only trusted connector transport.
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

Consent remains distinct at plan approval, exact change approval, playtest initiation, and final acceptance. The dashboard and CLI consume the same `CreatorControlView`; workflow legality is coordinator-owned rather than inferred from display strings. Final acceptance or rejection requires a 1–4096-byte non-whitespace creator report. That report is creator-authority evidence only and never upgrades Studio facts or machine-check claims.

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

## Current evidence boundary and next live proof

The earlier audit gaps are closed in the implementation and automated suite:

- immutable canonical JSON artifacts use atomic private writes, hash/byte verification, regular-file and symlink checks, relocation-safe locators, and conflict-safe deduplication;
- verification records bind the exact snapshot, execution plan, complete bounded runtime envelope and diagnostics when Studio ran, status, and exact failure facts;
- pure replay must reproduce both status and failure-fact hashes, while incomplete connector runs remain explicitly non-replayable;
- `ForgeNativeAgentRuntime` alone records rejected and executed calls, and BuildTrace validates real monotonic-backed intervals and containment;
- the dashboard/control-server cutover, restart classification, current-store discovery, required final report, and thin-plugin protocol surface are implemented.

The remaining evidence gap is live rather than structural: the new product shape has not yet been exercised in Roblox Studio. Use the exact solution-free Door Control prompt:

> Add a ProximityPrompt to Workspace/DoorAssembly/ControlPanel labeled “Toggle Door”. Each time a player uses it, move Workspace/DoorAssembly/Door straight up 8 studs to open or back to its starting position to close. Use server-authoritative code, keep the door anchored, and preserve Workspace/PreservedScenery.

The plan must visibly cover prompt and Script existence, Luau syntax, bounded diagnostics, preservation, and creator review of the interaction. Trigger the prompt twice during the approved Play Solo check. Preserve the resulting current session, replay output, creator report, hashes, failure classification, and exact claim boundaries. Until that happens, do not claim that the dashboard cutover or door behavior has live Studio evidence.

## Important implementation files

- `packages/creator-session/src/index.ts` — creator contracts and validation.
- `packages/creator-session/src/coordinator.ts` — lifecycle, Studio actions, verification, checkpointing, and review.
- `packages/creator-session/src/worker.ts` — planner/builder worker seam and local worker.
- `packages/agent-runtime/src/` — model orchestration, runtime-owned tool evidence, and interval capture.
- `packages/artifact-store/src/` — immutable current creator evidence.
- `packages/creator-control/src/` — dashboard/API server and private discovery.
- `packages/creator-session/src/verification.ts` — pure verification grading and replay.
- `dashboard/` — React/Vite evidence workbench.
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
rojo build examples/door-control/default.project.json -o /tmp/DoorControl.rbxlx
```

Only after explicit user authorization for a new live run:

```sh
node bin/forge.js creator serve --model openai/gpt-5.6-luna
```

Open the printed one-time dashboard URL. The user, not Forge or Codex, opens the Door Control place in Studio, pairs the connector, submits the exact prompt, approves artifacts, starts checks, triggers the prompt twice, records the observation in the required report, and accepts or rolls it back. Then run:

```sh
node bin/forge.js creator replay-verification <session-id>
```

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
