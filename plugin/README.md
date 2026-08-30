# Forge Studio Plugin

> **M3 runtime status:** pairing, complete observations, typed patches, and the
> authoritative seven-assertion StudioProof path have completed three
> reproducible safe runs. A real client-controlled-reward fault was detected by
> M2, failed CF-007, rejected its ProofBundle, and restored the exact starting
> live revision. A fresh repaired run then verified 7/7. A user-stopped run
> persists as `PLAYTEST_INTERRUPTED` / `INCOMPLETE`. M3 is showcase complete;
> remaining lifecycle hardening is deferred.

`plugin/src` is the only source of truth. `npm run plugin:build` produces
`plugin/ForgeStudioPlugin.rbxmx`, whose root is one Legacy `Script` with modular
children—the same reliable packaging shape used by the inspected Lemonade
plugin. There is no legacy single-file or prior-protocol installation path.

## Install and pair

1. Run `npm run plugin:build`.
2. Open `plugin/ForgeStudioPlugin.rbxmx` in Studio, select the root
   `ForgeStudioPlugin` script, and save it as a Local Plugin.
3. Start `node bin/forge.js studio bridge` yourself and keep it running. The
   widget discovers and pairs with this loopback bridge automatically.
4. In another terminal, run:

   ```sh
   node bin/forge.js studio verify examples/collect-fruit/studio \
     --timeout-ms 180000
   ```

The verifier never starts Studio or the bridge. After it reports that the plan
is armed, select **Verify in Studio** in the Forge widget. The plugin starts one
Play Solo session in the current Studio window and returns to edit mode when the
server harness calls `EndTest`. Do not press F5; it is not the armed-run trigger.

Selecting **Disconnect** invalidates the current bridge session and pauses
automatic reconnection. Selecting **Connect** resumes discovery without
restarting the bridge. Stable IDs remain intentional project metadata; no
session token, transaction, nonce, or temporary harness is persisted.

Each Studio window receives its own one-use pairing grant. Different local
`.rbxlx` files no longer replace each other merely because their unpublished
place and universe IDs are both zero. Keep only the intended project connected
while verifying; Forge rejects an ambiguous multi-project bridge instead of
mutating whichever session happened to arrive first.

## Runtime boundary

Protocol v10 requires `forge-studio-plugin-6.0.0`, reports capabilities during
pairing, and rejects older plugins outright. Studio transports a `ProjectObservation`; the backend alone
maps it into the canonical semantic `ProjectSnapshot`. Live revision hashes use a deterministic, length-delimited
canonical observation that excludes `capturedAt`; repeated unchanged snapshots
therefore have the same revision. Full source is transported without silent
truncation, using bounded SHA-256-checked chunks when needed.
Property and attribute maps are encoded as sorted entry arrays so empty Luau
tables have one unambiguous JSON representation.
ProximityPrompt instances are observed with bounded activation properties, and
BasePart observations include a numeric position vector. These facts feed the
backend interaction binding; they are not inferred from source text.

Eligible mutable instances receive `_forgeStableId` in a separate visible
ChangeHistory action. Stable IDs are live mutation handles only: Forge combines
them with class/path/source preconditions, and excludes them from backend
semantic hashes. Only typed `replace_text` and `create_script` operations are
allowed. There is no generic code runner or arbitrary instance API.

For StudioProof, the plugin:

1. arms the exact run without launching Studio, creates a fresh nonce, and publishes only its SHA-256 commitment;
2. waits for the creator to select **Verify in Studio**;
3. takes a fresh pre-play observation and rejects a stale revision;
4. injects one temporary default-context server harness in `Workspace` and one client driver in `StarterPlayerScripts`;
5. calls `StudioTestService:ExecutePlayModeAsync` with only a non-secret run hint while an outer plugin task owns the deadline;
6. invokes the same model-authored client action modules used by the fixture's
   real input handlers; static verification proves Button1Down/Triggered wiring,
   while bounded adversarial assertions may invoke the corresponding RemoteEvent
   directly to attack the server boundary;
7. receives exactly one JSON string directly from the server's `EndTest(JSON)` call;
8. validates run, plan, session, project snapshot, contract, nonce, and harness
   bindings before sending `StudioTestResult`;
9. destroys all temporary edit-mode objects.

If an active Play Solo request is interrupted or exceeds its deadline,
the executor becomes fail-closed and requires a plugin reload before another
proof run. Roblox does not expose a safe edit-plugin cancellation operation for
an already-yielding Play Solo request.

If the creator presses Stop before the server returns its envelope, Forge reports
`INCOMPLETE` / `PLAYTEST_INTERRUPTED`, rolls the transaction back, and never
creates a verified ProofBundle.

Studio Output is not a protocol message and cannot become proof. Bounded
diagnostics live inside the atomic server result envelope. Completed proof
events use a FIFO in-memory outbox during transient bridge failures. Unpair is
an authenticated bridge operation, and a lost/expired session cancels local
transaction state rather than leaving the place apparently paired.

## Transaction semantics

Forge serializes transaction ownership and checks the exact live revision before
every phase. A rejected run asks ChangeHistory to cancel the recording and then
always replays the typed inverse journal. This is deliberate: Studio can report
a successful cancellation without restoring source changed through
`ScriptEditorService`. Forge then captures a fresh observation and accepts the
rollback only if its complete live revision exactly equals the transaction's
starting revision. ChangeHistory is an undo boundary, not database atomicity.
Any cancellation/inverse uncertainty, revision mismatch, disconnect, timeout,
or incomplete evidence remains unverified and is shown as `ROLLBACK FAILED`.

## M3 status

Local TypeScript tests, plugin packaging, and fixture verification pass. Three
repeatability runs, one valid fault rejection, one fresh 7/7 verified rerun,
and one real interrupted incomplete run are recorded. M3 is complete for the
showcase; stale-state and bridge-loss lifecycle hardening remain deferred.
