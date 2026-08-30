# M3 showcase — Lemonade Forge

## The claim

Forge is not a chat interface that says a Roblox mechanic is safe. It compiles
a bounded typed change, verifies its Luau and client/server authority model,
runs the mechanic inside real Roblox Studio, and emits a compact proof artifact
that either commits or rejects the candidate.

## What is real

| Demonstration | Real outcome |
| --- | --- |
| Safe CollectFruit | Four real Studio runs passed all seven correlated server assertions and committed verified ProofBundles. |
| Client-controlled reward fault | M2 identified `REMOTE_CLIENT_CONTROLLED_REWARD`; real CF-007 sent `999999`, observed authoritative inventory `999999`, rejected the ProofBundle, and rolled back the live revision exactly. |
| Restoration and re-verification | A fresh PatchSet and Studio run passed 7/7 and produced verified ProofBundle `proof_4657ed9f7c43dd87644beee8`. |
| User Stop | The real run persisted as non-authoritative `PLAYTEST_INTERRUPTED` / `incomplete`, with no assertion evidence and no verified ProofBundle. |

The detailed evidence ledger is [m3-real-studio-runs.md](research/m3-real-studio-runs.md).

## Demo flow

1. Start the user-owned bridge:

   ```sh
   node bin/forge.js studio bridge
   ```

2. Open a fresh Rojo-built CollectFruit place and let the installed plugin
   connect automatically.

3. Run:

   ```sh
   node bin/forge.js studio verify examples/collect-fruit/studio --timeout-ms 180000
   ```

4. In Studio, select **Verify in Studio**. Forge starts exactly
   one Play Solo run, validates seven server-owned assertions, and prints the
   ProofBundle and BuildTrace locations.

5. Optional fault demonstration:

   ```sh
   node bin/forge.js studio verify examples/collect-fruit/studio --timeout-ms 180000 --fault-client-reward
   ```

   The expected outcome is rejection: M2 reports the authority violation and
   CF-007 observes attacker-controlled inventory.

## Trust boundary

- Roblox Studio server execution is authoritative for runtime behavior.
- Output text is diagnostics only, never proof.
- The server returns one correlated envelope through `EndTest(JSON)`.
- Plugin and backend both validate run, plan, session, snapshot, contract,
  nonce commitment, harness hash, and assertion IDs.
- A failed or incomplete Studio run cannot become a verified ProofBundle.

## Showcase boundary

This is a proof-of-work, not a production Roblox deployment platform. Deferred
hardening includes the remaining lifecycle interruption matrix, broader mechanic
coverage, automated benchmark workers, and creator-facing product UX. Those
limitations are intentional and documented; they do not weaken the demonstrated
safe/fault/recovery evidence chain.
