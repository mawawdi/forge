# Execution Isolation Boundaries

Forge needs two distinct execution boundaries, because they answer different questions.

## Agent and generated-code isolation

[Fly's agent architecture](https://fly.io/ai-agents/) separates an agent process from the code it runs and places isolated execution in Firecracker microVMs. [Fly's platform architecture](https://fly.io/docs/reference/architecture/) describes the same hardware-virtualized substrate for application workloads. This is a useful target for Forge's planner, builder, local tool, and evaluator worker seam: generated code can receive a bounded filesystem, network policy, resource budget, and disposable checkpoint without receiving Studio credentials or mutation authority.

Fly's public homepage associates Lemonade with Fly. That supports only the claim that Lemonade is a Fly customer; it does not reveal whether Lemonade's Roblox product uses one VM per task, how it drives Studio, or where it grades gameplay. Forge must not infer a private competitor topology from a customer logo.

## Roblox engine authority

Roblox's [`StudioTestService`](https://create.roblox.com/docs/reference/engine/classes/StudioTestService) exposes plugin-security `ExecutePlayModeAsync` and `EndTest`. Roblox's [Studio testing modes](https://create.roblox.com/docs/studio/testing-modes) distinguish Studio simulation from other test modes. A Linux microVM cannot independently reproduce the user's current Studio place, plugin security context, Change History transaction, client/server simulation, or engine implementation.

Forge therefore treats real Studio as a separate proof worker. The control plane sends one canonical, hash-bound data plan; fixed plugin code starts Play Solo, observes only manifest-defined facts, and returns an authoritative evidence envelope. A future microVM may compile, statically check, or grade that evidence, but it cannot manufacture it or replace Studio authority.

## Consequence for creator interaction checks

The runtime proof program must be executable before Studio mutation begins. Resolution calls precede dependent observations; series schedules and a creator-observation window fit one explicit budget; and the exact post-mutation revision-bound artifact is persisted before `Start Approved Checks` becomes legal. For interactions a human must trigger, machine sampling spans at least 15 seconds inside the current 20-second bound. Keeping Play Solo open after sampling ends is not evidence of anything that happened later.
