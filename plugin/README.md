# Forge Studio Plugin

This directory contains the M3 Forge Studio Plugin artifact: [ForgeStudioPlugin.lua](ForgeStudioPlugin.lua).

It is intentionally a thin runtime bridge. It has no AI loop, planner, model credentials, or arbitrary command execution. It uses the local Forge bridge for typed messages, snapshots, PatchSets, transactions, playtest control, and evidence forwarding.

## Local installation

1. Build Forge with `npm test`.
2. Start the loopback bridge:

   ```bash
   node bin/forge.js studio bridge
   ```

3. Copy `ForgeStudioPlugin.lua` into a new Script in Roblox Studio.
4. Save the Script as a Local Plugin using Studio's Plugins menu.
5. Open the Forge widget, paste the one-time token printed by the bridge, and select Pair.
6. Approve the Studio HTTP permission prompt for `http://127.0.0.1:8787` if Studio requests it.
7. Select Snapshot to send the live observation to the bridge.

The bridge terminal prints every inbound protocol message. After Snapshot, look for
`[studio -> forge] ProjectSnapshot`; the following JSON is the live observation,
including instance, script, and remote records.

If the widget remains on `Pairing requested`, reload the Local Plugin after updating
the script. The pairing token is one-use: restart `node bin/forge.js studio bridge`
to print a fresh token before trying again. The plugin must consume the bridge's
successful pairing response immediately; a repeated attempt with the consumed token
returns `401 Unauthorized`.

The current artifact is a source-installable Local Plugin script, not a published Creator Store asset. Studio must be available to perform the installation and any authoritative run.

## Current limits

- The plugin sends a bounded live observation and a plugin-local FNV token. The backend must construct canonical SHA-256 `ProjectSnapshot` hashes.
- Script source edits use `ScriptEditorService:UpdateSourceAsync()` and a guarded direct-source fallback for scripts that are not open in the editor.
- ChangeHistory cancellation is the rollback request. Forge still verifies the post-transaction snapshot and does not claim database-style atomicity.
- `ExecuteAssertionPlan` forwards only correlated results emitted by the real place harness. If the harness is absent or does not complete, the proof collector remains `incomplete`; a plugin connection never becomes proof by itself.
- Studio version is currently reported as `unknown`; the protocol keeps the field mandatory for eventual evidence provenance.
- Never pair this candidate bridge with a production place or enable production DataStore access for testing.
