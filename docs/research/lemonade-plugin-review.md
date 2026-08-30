# Lemonade Plugin Review for Forge

Status: implementation reference, not a dependency or a product specification.

## Review scope

The extracted Lemonade source contains 69 Luau files (20,579 lines), excluding
its omitted frontend package. Reviewed areas include its bootstrap/app, core
orchestrator, HTTP transport, polling service, identity tree/watcher, read and
write processors, rollback serialization, recording manager, playtest and
capture actions, diagnostics, configuration, and the adjacent TestEZ suites.

## What Lemonade does well

| Area | Lemonade implementation | Forge adoption |
| --- | --- | --- |
| Lifecycle | `Core` creates services, owns shutdown, resets state on reconnect. | A small `ForgeRuntime` owns all sessions, transaction, proof, and unload cleanup. |
| Transport | `HttpCore` bounds requests, sanitizes UTF-8, classifies failures, and retries selected uploads. `StudioActionService` uses adaptive polling. | Bounded loopback request client, adaptive polling, finite outbox, explicit degraded state. |
| Identity | `Tree` indexes `_lemonadeUniqueId`; `Watcher` assigns IDs and repairs clone collisions. | Persist `_forgeStableId` on eligible mutable instances and use it for typed live PatchSet targets. |
| Mutation | Separate action handlers and `RecordingManager` make change ownership visible. | Typed patch executor and transaction manager; no generic action dispatcher. |
| Playtest | An explicit backend `playtest` tool request parents one server stopper before `ExecutePlayModeAsync`; the edit plugin owns the yielding call, enforces a deadline, and cleans temporary objects. It is not automatically coupled to writes. | Preserve explicit action ownership, Play Solo, one server terminator, an outer deadline, and cleanup. Use Roblox's canary-proven direct `EndTest(result)` contract rather than copying Lemonade's test-argument/result wrapper. |
| Observability | Structured, bounded logs and explicit operational errors. | Diagnostics only; never elevate Output to proof. |
| Testing | Pure helpers and action handlers have focused TestEZ coverage. | Pure plugin modules gain Luau tests; bridge/proof behavior gains Node integration tests and real-Studio acceptance tests. |

## Patterns Forge must not copy

Lemonade is a general-purpose agent runtime. Its `runCode` action uses
`loadstring`; its write, import, delete, serialize, deserialize, asset, and
generic instance actions permit broad mutation; its sync protocol assumes an
external user/project backend. Those capabilities conflict with Forge's
bounded, inspectable PatchSet boundary and are intentionally excluded.

Forge also excludes screenshot/GIF capture, device simulation, arbitrary
agent-controlled scripts, web account/project synchronization, and Lemonade's
frontend. Those are not required to establish a verified CollectFruit proof.

## Concrete Forge gaps at the start of this refactor

The prior plugin was a single minified file that coupled widget state, transport,
snapshotting, patch execution, transaction state, and StudioProof execution. It
used a non-cryptographic FNV token, silently truncated script source, allowed a
basename fallback when resolving patch targets, synchronously forwarded Output,
and exposed an unbounded bridge event history and unauthenticated local control
surface. Local TypeScript tests covered the intended protocol, but no real
Studio run had completed a verified ProofBundle.

## Forge decisions

- Protocol v7 is a hard replacement for every prior Studio format; there is no compatibility reader.
- `_forgeStableId` is persisted in the place as Forge metadata. It is excluded
  from semantic verification hashes but retained in live observation and stale
  checks.
- The plugin uses `EncodingService` cryptographic hashing when the capability
  exists. Absence is a capability rejection, never a fallback to FNV.
- A temporary server harness is the sole authority for the correlated proof
  envelope. The edit plugin receives the server's `EndTest` return directly;
  Output and `LogService` are not evidence transport.
- ChangeHistory is an undo boundary, not a database transaction. Forge keeps a
  typed inverse journal and never marks an uncertain rollback as verified.

Roblox documents that `Instance.UniqueId` is not script-readable, so a plugin
cannot use it for the identity registry. Roblox's `EncodingService` exposes
official cryptographic string/buffer hashing APIs. See the [Instance
reference](https://create.roblox.com/docs/reference/engine/classes/Instance/UniqueId)
and [EncodingService reference](https://create.roblox.com/docs/reference/engine/classes/EncodingService).

## Remaining limitation

This refactor improves the architecture and local evidence checks. Only the
three safe runs, fault run, and repaired run performed in real Roblox Studio can
establish M3 completion.

## Packaging and execution-adapter finding

The inspected `LemonadePlugin.rbxm` is one root Legacy `Script` with its modules
as descendants. It does not survive or relay across a user F5 session; the edit
plugin owns the programmatic Studio call and resumes when it returns. Forge now
uses the same package/lifecycle ownership shape.

Lemonade's playtest is one optional action in `StudioActions`; polling dispatches
it only when the backend explicitly requests the `playtest` tool. Writes do not
implicitly start a game. The action calls
`ExecutePlayModeAsync({ timeoutSeconds = ... })`, and one default-context server
stopper calls `EndTest({ returnValue = ... })`. The client capture/driver scripts
never call `EndTest`.

That source shape is a useful implementation reference, not the Roblox API
contract. Forge's standalone canary proved both Run and Play server roundtrips
with neutral test arguments and direct `EndTest(token)`. Forge now preserves
Lemonade's operational ownership while using the locally proven direct result
shape. The next canary proves the client/server RemoteEvent boundary before the
CollectFruit harness is retried.

Forge's abandoned multiplayer divergence was incorrect for the creator flow.
`ExecuteMultiplayerTestAsync(1, ...)` launches separate server/client Studio
workers by design. In the observed environment it also returned a Studio-owned
table while Forge's server attempted a second `EndTest`, producing “EndTest can
only be called once.” Treating that as another result-shape edge case would have
hidden the architectural mismatch. Protocol v7 removes the multiplayer adapter
and automatic launch. Forge now arms first, starts one Play Solo request only
after the creator selects **Run StudioProof**, and accepts only the direct
server JSON string proven by the standalone canary.
