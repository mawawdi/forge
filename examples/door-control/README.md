# Door control creator-session fixture

This is a solution-free Studio seed for the dashboard creator workflow. Build it to a temporary place, open that place in Studio, and do not keep Rojo connected: Studio is the creator session's sole writer.

Use this exact prompt:

> Add a ProximityPrompt to Workspace/DoorAssembly/ControlPanel labeled “Toggle Door”. Each time a player uses it, move Workspace/DoorAssembly/Door straight up 8 studs to open or back to its starting position to close. Use server-authoritative code, keep the door anchored, and preserve Workspace/PreservedScenery.

The approved plan must expose checks for prompt and script existence, Luau syntax, bounded Play Solo diagnostics, preservation of `Workspace/PreservedScenery`, and creator review of the interaction. During the approved Play Solo check, trigger the prompt twice and record the observed open/close behavior in the required final report. Interaction behavior is creator-authority evidence unless it is covered by an explicit Studio observation clause.
