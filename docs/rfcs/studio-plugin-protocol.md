# RFC: Forge Studio Plugin Protocol

Status: M3 foundation implemented; authoritative Studio run pending
Date: 2026-08-29

## Decision

The Forge Studio Plugin is the product-specific Studio boundary. It is a thin, privileged execution bridge that owns live DataModel inspection, bounded PatchSet execution, ChangeHistory transactions, playtest control, and evidence forwarding. The backend remains responsible for intent, contracts, patch creation, test-plan selection, verification policy, repair, and proof assembly.

Roblox Studio MCP is not the Forge product interface. It remains useful for development, debugging, and comparative tooling. Roblox's current built-in MCP exposes generic DataModel exploration, script operations, Luau execution, play state, and input simulation, but Forge must own its contract, transaction, assertion, and evidence semantics. The archived Rust MCP server is reference material only.

## Transport

M3 uses a replaceable local HTTP polling transport:

```text
Forge CLI/backend
  └── StudioBridgeServer: 127.0.0.1:<port>
        ├── POST /v1/message
        ├── GET  /v1/poll?sessionId=&sessionToken=
        └── GET  /health
              ▲
              │ HttpService:RequestAsync
       Forge Studio Plugin
```

Polling is the smallest reliable candidate transport supported by the plugin APIs. It avoids building a WebSocket or MCP server, works with a local bridge, and keeps protocol semantics independent of infrastructure. Plugin HTTP access may require a user permission prompt for the configured address; production deployment must use an explicit allowlist, TLS/relay policy, and stronger authentication. The demo must not treat an HTTP response as proof until its message, session, project, request, and snapshot checks pass.

The session token is sent as `X-Forge-Session-Token` on authenticated POST messages and as the `sessionToken` query parameter for polling. Session IDs are routing identifiers, not credentials.

The transport boundary is:

```ts
interface StudioTransport {
  send(message: BackendToPluginMessage): Promise<void>;
  subscribe(handler: (message: PluginToBackendMessage) => void | Promise<void>): () => void;
}
```

The implementation is `StudioBridgeServer` in `packages/studio-bridge`. A future relay or native transport can implement the same interface without changing protocol or proof objects.

## Message contract

Every message is a discriminated, versioned envelope:

```ts
interface StudioProtocolMessage {
  kind: "StudioProtocolMessage";
  schemaVersion: 1;
  direction: "plugin_to_backend" | "backend_to_plugin";
  type: string;
  messageId: string;
  requestId?: string;
  correlationId?: string;
  sessionId?: string;
  sentAt: string;
  payload: unknown; // narrowed by type-specific union member at runtime
}
```

The implementation provides typed union members for:

- plugin → backend: `PluginHello`, `PairProject`, `ProjectConnected`, `ProjectSnapshot`, `ProjectDelta`, `PatchApplied`, `PatchRejected`, `PlaytestStarted`, `PlaytestStopped`, `AssertionResult`, `RuntimeEvidence`, `StudioOutput`, `PluginError`, `Heartbeat`;
- backend → plugin: `PairProject`, `PairAccepted`, `PairRejected`, `RequestSnapshot`, `ApplyPatchSet`, `BeginTransaction`, `CommitTransaction`, `RollbackTransaction`, `StartPlaytest`, `StopPlaytest`, `ExecuteAssertionPlan`, `RequestRuntimeState`.

Runtime validators reject unknown message directions/types, malformed envelopes, and oversized HTTP bodies. Correlation and request IDs are mandatory for operations initiated by the backend. Messages from the backend are untrusted by the plugin until schema, session, project, operation, and snapshot preconditions pass.

## Pairing

The candidate pairing flow is deliberately secure enough for a local demo without pretending to be production auth:

1. `forge studio bridge` binds to loopback and prints a one-use, ten-minute pairing token.
2. The user pastes the token into the plugin widget.
3. The plugin sends `PairProject` with place/universe identity, plugin version, and Studio version.
4. The bridge consumes the token, creates a random session ID and session token, and queues `PairAccepted`.
5. The plugin persists only the scoped session values through plugin settings and starts polling.
6. The plugin sends a live `ProjectSnapshot` observation; the backend associates it with the Forge project, session, plugin version, and canonical snapshot computed by the adapter.

The current plugin reports Studio version as `unknown` until a stable, supported version API is selected. It never embeds a secret. Production pairing needs authenticated user/project identity, token revocation, TLS, expiry enforcement across restarts, and audit policy.

## Live semantic map

The plugin emits `StudioSnapshotObservation`, a wire observation rather than a second domain model. It contains only M3-relevant hierarchy, class/name/path, selected primitive properties, attributes, tags, remotes, and bounded script source/hash data. The backend maps this observation through the existing `ProjectSemanticMap` adapter boundary and recomputes canonical `ProjectSnapshot` hashes. FNV is used only as a plugin-local stale-observation token; it is never an authoritative Forge hash.

Initial synchronization is snapshot-based:

```text
snapshot before
  -> typed transaction / PatchSet
  -> snapshot after
  -> semantic diff
```

Real-time deltas are represented by `ProjectDelta` but are not required for M3. This makes correctness possible before reliable event streaming is proven.

## Patch and transaction semantics

The plugin executes the existing `PatchSet` union. M3 adds typed Instance operations (`create_instance`, `delete_instance`, `set_property`, `set_attribute`, `move_instance`) while retaining M2's bounded source operations. It does not accept arbitrary source blobs outside a declared operation.

Each operation returns `PatchOperationResult` with operation ID, target, status, optional before/after hashes, and an error. The plugin validates path/target existence, class preconditions, property/attribute preconditions, and transaction identity.

Transactions use `ChangeHistoryService:TryBeginRecording()` and `FinishRecording()` with commit or cancel. Roblox documents this as the plugin mechanism for grouping plugin changes into undo/redo history. The guarantee is bounded: a committed recording is one Studio history unit and a canceled recording asks Studio to discard the recording. Forge must still take a post-operation snapshot and treat any mismatch as failure; it cannot claim database-style atomicity or guarantee rollback of external side effects, running code, network calls, or persistence.

## StudioTestPlan and assertions

`StudioTestPlan` in `packages/studio-proof` compiles one `MechanicContract` and `ProjectSnapshot` into typed setup, actors, actions, assertions, adversarial cases, cleanup, and plan version. The initial `collectFruitTestPlan()` produces seven assertions:

1. valid collection succeeds;
2. inventory increases by one;
3. fruit becomes unavailable;
4. duplicate request is rejected;
5. nonexistent ID is rejected;
6. impossible distance is rejected;
7. client-supplied reward amount is rejected.

`StudioAssertionResult` requires expected and observed values, evidence entries, duration, run/plan/assertion IDs, and an `authoritative` flag. A result is not a pass merely because a plugin command returned successfully. The plugin forwards only results emitted by the real place harness and correlates them to the active run and plan; if the harness is absent or incomplete, the proof collector remains `incomplete`.

Roblox's `StudioTestService` provides plugin-secured play, run, and multiplayer test entry points, and current Studio testing supports up to eight simulated clients. `TestService` and `LogService` provide test result/output surfaces. The first real harness should use those APIs and a development-only test channel in the place, not a mocked runtime.

## Proof and trace integration

`attachStudioProof()` extends the existing `ProofBundle` with the Studio test-plan ID, run ID, before/after snapshot references, plugin/Studio versions, assertion result IDs, and authoritative status. It updates the existing `roblox_studio` check; it does not create a second evidence format.

M3 Flight Recorder spans are reserved for:

```text
forge.studio.connect
forge.studio.snapshot
forge.studio.transaction.begin
forge.studio.patch.apply
forge.studio.start
forge.studio.playtest
forge.studio.action
forge.studio.assert
forge.studio.adversarial
forge.studio.playtest.stop
forge.studio.transaction.commit
forge.studio.transaction.rollback
```

The trace taxonomy now contains these Studio spans. The current plugin/bridge foundation records the component/version boundary; wiring every span to a real run remains pending the first Studio session. Failed Studio runs retain their run/plan/snapshot references so they can later be promoted into CoreLoopBench without changing the historical result.

## Real versus mocked boundary

Real in this foundation: typed protocol validation, local pairing/session state, plugin DataModel traversal code, ChangeHistory API calls, plugin HTTP calls, PatchSet target checks, and the backend's proof-plan/bridge logic.

Not yet executed here: a live Roblox place, an installed/running plugin session, a real Studio playtest, server/client interaction, TestService harness output, or authoritative CollectFruit assertion results. Until those are run, the M3 ProofBundle remains incomplete and no plugin observation is labeled authoritative.

## References and limitations

- [Roblox Plugin API](https://create.roblox.com/docs/reference/engine/classes/Plugin): toolbar and dock-widget surface.
- [ScriptEditorService](https://create.roblox.com/docs/reference/engine/classes/ScriptEditorService): supported editor source access/update path.
- [ChangeHistoryService](https://create.roblox.com/docs/reference/engine/classes/ChangeHistoryService/Undo): undo/redo recording boundary.
- [StudioTestService](https://create.roblox.com/docs/reference/engine/classes/StudioTestService): plugin-controlled play/run/multiplayer tests.
- [Studio testing modes](https://create.roblox.com/docs/studio/testing-modes): scripted testing and simulated clients.
- [HttpService](https://create.roblox.com/docs/cloud-services/http-service): plugin HTTP access and user permission requirement.
- [LogService](https://create.roblox.com/docs/reference/engine/classes/LogService): output/error observation surface.
