# Last Light clean seed

This place contains only engine service containers. It contains no scripts, gameplay, station geometry, UI, runtime package or mechanic adapter. The creator brief is in [CREATOR-BRIEF.md](CREATOR-BRIEF.md).

Build a seed place from the repository root:

```sh
rojo build examples/last-light/default.project.json -o /tmp/forge-last-light-seed.rbxlx
```

Open `/tmp/forge-last-light-seed.rbxlx` in Roblox Studio, enable the installed Forge connector, connect it to the running Forge host, and submit the creator brief. Review the compiled inventory before accepting it. The user runs all Studio checks.

The offline fixture in `test/fixtures/last-light.spec.ts` composes the production scene, responsive UI and optional Forge runtime recipes with five unfilled ordinary Luau source slots. Its compiler test uses explicitly trivial recorded slot contents to check structural compilation only. It does not implement or prove gameplay, interaction, replay, source analysis or published-client behavior.
