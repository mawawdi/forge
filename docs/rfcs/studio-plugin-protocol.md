# RFC: Forge Studio Plugin Protocol v10

Status: M3 implemented; M3.5 Collect+Sell acceptance recorded
Date: 2026-08-30

## Decision

Forge has one Studio protocol and one M3 lifecycle. Protocol v10 replaces v9
outright. An edit-mode root `Script` plugin owns inspection, typed mutation,
transaction state, and one explicit creator-triggered Play Solo action. Arming
never starts Studio. Manual F5 handoff, multiplayer worker processes, test-mode
plugin relays, Output evidence, and old protocol readers do not exist.

```text
MechanicContract -> StudioTestPlan -> ExecuteAssertionPlan
  -> READY / creator selects Verify in Studio
  -> temporary server/client harness
  -> ExecutePlayModeAsync({ forgeStudioProofRunId })
  -> sole server EndTest(JSON envelope)
  -> StudioTestResult -> StudioProofRun -> ProofBundle
```

Normal Studio Play Solo runs distinct client and server simulations in one
Studio window. The server drives the proof and is the sole `EndTest` owner; the
client participates through replicated boundaries. The server-return value is
the authority channel; Output is neither transport nor proof.

## Transport and sessions

The user owns one loopback bridge process. The plugin discovers its one-use
pairing credential directly from that bridge, while the bridge writes its
control credential to `.forge/studio-bridge.json` with owner-only permissions.
Verification reads that ephemeral file and never starts a competing listener.
Tokens are not printed, pasted, persisted by the plugin, or accepted as normal
CLI arguments.

```text
Verifier -> authenticated /v1/command -> bridge -> plugin polling
Verifier <- authenticated /v1/events  <- bridge <- plugin messages
```

Session secrets travel only in request headers, never in poll URLs.

Pairing still uses a one-use expiring token internally. Every discovery request
receives an independent bounded grant, so concurrent Studio windows cannot
steal one global pairing slot. It is fetched over the fixed `127.0.0.1`
transport and immediately exchanged; the widget never exposes it. Published
places are session-keyed by universe/place identity. Unpublished local places
have zero engine IDs and are therefore keyed by their file/DataModel name rather
than all collapsing into one project. A verifier fails explicitly when multiple
distinct Studio projects are connected instead of selecting one arbitrarily.
`PairProject` includes protocol version,
plugin/Studio versions, project identity, and required capabilities. Missing
`studio_play_mode`, SHA-256, stable identity, typed patch, transaction,
snapshot, or polling capability rejects pairing. An authenticated
`UnpairProject` removes the bridge session immediately, so a verifier cannot
attach to a locally abandoned session. **Disconnect** pauses plugin discovery;
**Connect** resumes it and obtains a fresh one-use credential automatically.

Auto-discovery deliberately trusts processes on the creator's local machine.
The bridge refuses non-loopback binding. Backend control endpoints still require
the random credential stored in the owner-only discovery file, and all plugin
messages still require the per-session token returned by pairing.

Message IDs are idempotency keys. The bridge bounds retained events and rejects
expired cursors. The plugin uses adaptive polling, explicit degraded/recovered
states, and a bounded FIFO outbox for proof lifecycle/result messages. A 401
cancels local session/transaction state; a transient outage retries without
reordering the atomic result and stop event.

```ts
interface StudioProtocolMessage {
  kind: "StudioProtocolMessage";
  schemaVersion: 7;
  direction: "plugin_to_backend" | "backend_to_plugin";
  type: string;
  messageId: string;
  requestId?: string;
  sessionId?: string;
  sentAt: string;
  payload: unknown;
}
```

## Snapshots and live identity

`ProjectObservation` carries a complete `StudioSnapshotObservation` plus a
`StudioRevision`. It does not carry or fabricate a semantic `ProjectSnapshot`.
The backend validates the observation and maps it through the semantic adapter;
only that backend mapping creates the canonical `ProjectSnapshot` used by the
plan and proof. Properties and attributes use sorted `{name, value}` entry
arrays on the wire, avoiding Roblox JSON's ambiguous encoding of an empty Lua
table as `[]`. The live observation hash is derived from a deterministic,
length-delimited field encoding. It excludes `capturedAt`, so an unchanged place
has an unchanged revision, and includes stable target identity plus relevant
class/path/property/attribute/tag/script/remote state. Large JSON observations
are transported in ordered, bounded, SHA-256-checked chunks without source
truncation.

Observation schema v3 also carries BasePart positions and enrolls
`ProximityPrompt` instances with bounded activation properties, including
`MaxActivationDistance`. The backend resolves these into the selected
mechanic's `InteractionBinding`; source text is not allowed to invent world
structure or collapse client activation into server authorization.

For the combined Collect+Sell proof, the binding also names one bounded
model-authored client action module. The production input wrapper invokes that
module from `Button1Down` or `Triggered`, and the Studio client driver invokes
the same function for happy-path execution. This is a split static/runtime
proof of one production path, not a test-only RemoteEvent shortcut. Injected
LocalScripts cannot use privileged `LocalUser` mouse movement APIs, so protocol
v10 contains no synthetic OS-input path.

The plugin assigns `_forgeStableId` to eligible mutable instances in a separate
visible ChangeHistory recording and repairs collisions. Stable IDs are mutation
handles, not semantic identity: the backend derives semantic Instance IDs from
path/class and removes Forge attributes before canonical semantic hashing.

## Patch and transaction boundary

M3 permits only bounded `replace_text` and `create_script` operations. Every
operation checks stable ID, class, path metadata, exact source/before state, and
the current `StudioRevision`. There is no arbitrary Luau execution, generic
instance mutation, asset import, or unrestricted filesystem/network action.

Only one transaction may be active. Forge holds a ChangeHistory recording
through verification. On rejection it requests cancellation and always applies
the typed inverse journal in reverse order. The inverse is idempotent when
cancellation already restored the state and is required because Studio may
report cancellation success without restoring `ScriptEditorService` edits.
Forge then captures a complete observation and requires its live revision to
equal the transaction's starting revision exactly. ChangeHistory is an undo
facility, not database atomicity. Cancellation/inverse uncertainty, revision
mismatch, disconnect, timeout, or incomplete evidence can never become a
verified commit.

## StudioProof authority and correlation

The plugin generates a fresh nonce after validating the session, project,
transaction, revision, harness ID/version, and the registry's exact assertion IDs. The
raw nonce remains only in ephemeral armed memory until the creator starts the
run, then is embedded only in the temporary server script.
`AssertionPlanAccepted` exposes its SHA-256 commitment. Immediately before Play
Solo, the plugin captures a fresh observation and rejects a changed revision.

Before any action the server harness requires a live Humanoid,
HumanoidRootPart, initialized declared player state, and every required world
object. For happy paths, the temporary client performs the real production
gesture and the model-authored LocalScript must initiate the request: a pointer
click for CollectFruit and `SellPrompt` activation for SellInventory. For
adversarial assertions only, the temporary client may invoke the real
RemoteEvent directly to attack server validation. The temporary driver is not
a substitute for production-client correctness.

The server positions the real player, reads authoritative state and actual
runtime positions, and returns the registered results in one JSON string
directly through `EndTest`. The combined harness returns the seven CollectFruit
regressions, six SellInventory assertions, and Collect→Sell composition. The
historical Collect-only harness retains its seven results:

- valid collection;
- exact inventory `0 -> 1`;
- fruit unavailable;
- duplicate rejected;
- nonexistent fruit rejected;
- impossible runtime distance rejected;
- client reward spoof rejected.

The plugin validates the returned run, plan, session, project snapshot,
contract, nonce/commitment, and harness hash. The backend validates them again,
requires exactly the planned unique assertion IDs, and requires start/result/
stop ordering. A stale, copied, duplicate, late, unknown, wrong-project, or
wrong-run result is rejected or leaves the proof incomplete.

`StudioHarnessRunEnvelope.diagnostics` is the sole bounded diagnostics field.
`StudioOutput` is not a protocol-v10 message type. A printed `CF-001 PASS` line has no
verification meaning.

## Operational cleanup

Temporary server/client scripts are destroyed after success or failure and on
abort/unpair/unload. One task owns the yielding Studio request and a deadline.
Because Studio exposes no safe edit-plugin cancellation for an already-yielding
Play Solo request, interruption or deadline expiry blocks that plugin runtime
from starting a second proof and requires Stop plus a plugin reload.
The server also has bounded client/readiness timeouts and returns `not_run`
results plus diagnostics if infrastructure fails. The root plugin exits in any
running DataModel, so user plugins loaded into server/client test contexts do
not create duplicate widgets or sessions.

## Deferred work

Screenshots/richer capture, stable identity across separately forked places,
remote bridge relays, distributed Studio workers, and additional lifecycle
adapters remain future work. Any adapter must preserve this same server-return
evidence semantics.

## References

- [StudioTestService](https://create.roblox.com/docs/reference/engine/classes/StudioTestService)
- [Studio testing modes](https://create.roblox.com/docs/studio/testing-modes)
- [ChangeHistoryService](https://create.roblox.com/docs/reference/engine/classes/ChangeHistoryService)
# Protocol v10: bounded harness registry

Protocol v10 accepts only two exact registered harness identities: the immutable
historical `collect-fruit@collect-fruit-v7` and
`collect-sell@collect-sell-v4`. The backend validates ID, version, source hash,
and exact assertion count before arming. The plugin resolves the same registry
before injection. There is no arbitrary assertion DSL or script-execution
message. The combined harness returns one server-owned `EndTest(JSON)` envelope
with fourteen correlated results; Output remains diagnostics only.
