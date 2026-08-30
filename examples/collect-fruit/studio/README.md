# CollectFruit Studio fixture

This is the real Studio target for M3. The saved place contains the production-
shaped server-authoritative mechanic and client request boundary, but no Forge
test context, test remotes, nonce, or permanent assertion harness.

Build and open a fresh place:

```bash
rojo build examples/collect-fruit/studio/default.project.json \
  --output /tmp/ForgeCollectFruit.rbxlx
open /tmp/ForgeCollectFruit.rbxlx
```

Build/install the root plugin script as described in `plugin/README.md`, start
the bridge yourself, pair the widget, then run:

```bash
node bin/forge.js studio verify examples/collect-fruit/studio \
  --timeout-ms 180000
```

Forge applies the bounded patch, runs static and semantic gates, then arms the
exact run without launching Studio. When the verifier prints READY, select
**Run StudioProof** in the Forge widget. The plugin takes a fresh observation,
injects temporary scripts, and starts one Play Solo session in the current
Studio window. The server executes all seven real assertions and returns one
correlated JSON envelope directly through `StudioTestService:EndTest(JSON)`.
Do not press F5; it is not the armed-run trigger.

Studio Output is diagnostic only and is not transported as proof. Verification
requires the atomic server envelope to match the active run, plan, session,
project, snapshot, contract, nonce commitment, harness version/hash, and exact
assertion set.

For the explicit M3 client-controlled-reward fault demonstration, use a fresh
Rojo-built place and add `--fault-client-reward` to the verifier command. The
CLI must print `INTENTIONAL FAULT MODE: CLIENT_CONTROLLED_REWARD` before the
bridge attaches. A filename containing `fault` has no behavioral meaning.
