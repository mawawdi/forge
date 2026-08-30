# StudioTestService isolation result

Status: M3-P0 through M3-P3 passed on the current local Roblox Studio build. M3 remains
incomplete.

## Observed fact

The dependency-free canary produced both required exact roundtrips:

- `ExecuteRunModeAsync` -> server `EndTest(token)` -> plugin received `token`.
- `ExecutePlayModeAsync` -> server `EndTest(token)` -> plugin received `token`.
- Play LocalScript -> RemoteEvent -> server `EndTest(token)` -> plugin received
  `token`.
- CollectFruit real RemoteEvent -> server inventory `0 -> 1`; `Fruit42`
  consumed; measured runtime distance `6.71` studs.
- Duplicate CollectFruit request -> inventory remained `1`.
- Client reward claim `999999` -> authoritative inventory became `1`.

The earlier Forge harness instead passed `{ timeoutSeconds = 90 }` as the test
argument and called `EndTest({ returnValue = JSON })`. On the same Studio build,
that path returned a table whose visible keys were `gameOutput` and
`jestOutput`.

`jestOutput` is Roblox Studio's internal result field. Forge does not use Jest
for its Studio runtime proof.

## Interpretation

Roblox documents the parameter to `ExecutePlayModeAsync(args)` as test arguments,
not an options object, and documents `EndTest(result)` as returning that result
directly. The canary validates that documented contract locally. The earlier
`timeoutSeconds` and `{ returnValue }` shapes came from Lemonade's implementation
and are not required by the Roblox API. The `timeoutSeconds` key also coincided
with Studio selecting its internal runner result path.

- https://create.roblox.com/docs/reference/engine/classes/StudioTestService
- https://devforum.roblox.com/t/introducing-studiotestservice/4116257?page=2

## Engineering decision and outcome

The runtime path was reintroduced one boundary at a time through a temporary
standalone canary:

1. Run server return: passed.
2. Play server return: passed.
3. Play LocalScript -> RemoteEvent -> server return: passed.
4. One CollectFruit assertion: passed.
5. Duplicate and reward-spoof core checks: passed.
6. Full correlated harness and bridge: passed in three reproducible safe runs.

Forge's main adapter now uses an outer edit-plugin deadline, passes only a
neutral run hint, and expects the server's direct JSON result. No compatibility
reader for the abandoned wrapped result exists.

The temporary canary source and generated model were removed after their
successful kernel was integrated into the production plugin. This report is the
retained characterization record; it is not a second runtime implementation.

## Non-decisions

- Do not switch to multiplayer merely to make the test green; it launches
  separate Studio processes and changes the creator workflow.
- Do not parse `gameOutput` or `jestOutput` into authoritative evidence.
- Do not treat Lemonade's test-argument/result shape as part of Roblox's public
  contract.
- Do not add fallback readers for earlier protocol shapes.
