# CollectFruit Studio fixture

This directory is a real Studio target for the M3 plugin path. It contains a minimal Rojo place tree, a server-authoritative `CollectFruit` mechanic, and a development-only harness that drives the seven assertions emitted by `collectFruitTestPlan()`.

The companion `forge.fixture.json` is the static baseline used by Forge. The live adapter matches Studio script paths to this baseline by unique script name and execution context, then computes canonical hashes from observed source rather than trusting the plugin-local observation token.

Build a place for manual Studio testing with:

```bash
rojo build examples/collect-fruit/studio/default.project.json --output /tmp/ForgeCollectFruit.rbxlx
```

Open the resulting place in Roblox Studio, install the local plugin from `/Users/mawawdi/Desktop/forge/plugin/ForgeStudioPlugin.lua`, start `node bin/forge.js studio bridge`, and pair the plugin through its widget.

The harness is intentionally development-only. It uses `ForgeTestControl`/`ForgeTestReply` to ask the local test client to issue requests, while all reward, identity, consumed-state, and distance decisions remain in `CollectFruit.server.luau`. The plugin forwards `FORGE_ASSERTION_RESULT:` log records and ends the playtest when it sees `FORGE_TEST_COMPLETE:`.

This fixture is not a fake Roblox runtime and is not proof until the place is actually run in Studio through the paired plugin.
