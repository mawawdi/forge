--!strict
-- Presentation only. These labels never authorize a Studio operation.
local Presentation = {}

Presentation.colors = table.freeze({
	canvas = { 32, 33, 38 }, surface = { 41, 43, 51 }, inset = { 25, 26, 30 },
	text = { 238, 239, 243 }, muted = { 161, 166, 178 }, line = { 69, 73, 85 },
	accent = { 181, 195, 255 }, accentInk = { 32, 38, 61 },
	success = { 126, 201, 176 }, attention = { 220, 166, 110 },
})

export type Status = {
	title: string, description: string, tone: string, working: boolean, record: boolean,
}
local statuses: {[string]: Status} = {}
local function define(codes: {string}, title: string, description: string, tone: string, working: boolean?, record: boolean?)
	local status = table.freeze({ title = title, description = description, tone = tone, working = working == true, record = record == true })
	for _, code in codes do statuses[code] = status end
end

define({ "CONNECTING", "RECOVERY PAIRING" }, "Connecting to Forge", "Keep the Forge service running. This place will connect automatically.", "accent", true)
define({ "WAITING FOR BRIDGE" }, "Start Forge to connect", "Start the Forge service in your terminal, then open its dashboard link.", "muted")
define({ "DISCONNECTED" }, "Ready to connect", "Connect this place to continue your project conversations in Forge.", "muted")
define({ "CONNECTED" }, "You’re connected", "Continue in the Forge dashboard to chat, review changes, and follow the agent’s work.", "success")
define({ "BRIDGE UNREACHABLE" }, "Reconnecting", "The connection was interrupted. Forge is trying again; your project changes are left in place.", "attention", true)
define({ "CONNECTION REJECTED" }, "Couldn’t connect", "Check the details below. If the connector was updated, restart Studio and the Forge service together.", "attention")
define({ "UNSUPPORTED STUDIO" }, "Update Roblox Studio", "This Studio version is missing a feature Forge needs. Update Studio, then try again.", "attention")
define({ "RECOVERY REQUIRED" }, "A change needs attention", "Reconnect, then use the Forge dashboard to review the unfinished change.", "attention", false, true)
define({ "INVALID PLAY DATA" }, "Saved test data needs attention", "Discard the unreadable test data to reconnect. This does not undo changes to your place.", "attention")
define({ "EVIDENCE INCOMPLETE" }, "Something needs attention", "Forge couldn’t finish this Studio step. Open Details for the error and check the dashboard for your next action.", "attention", false, true)
define({ "PROJECT CHANGED" }, "Your project changed", "Review the update in Forge before continuing with earlier work.", "attention", false, true)
define({ "NOT READY" }, "No test is ready", "Continue in the Forge dashboard. A test becomes available after the required review.", "muted")
define({ "WAITING FOR PLAY" }, "Ready for your playtest", "Press Play in Studio, try the change, then press Stop. Forge will collect the approved observations.", "accent", false, true)
define({ "READY TO EVALUATE" }, "Ready to run the test", "The approved test is ready. Start it below when you’re ready.", "accent", false, true)
define({ "OBSERVING PLAY", "RUNTIME RUNNING" }, "Watching your test", "Try the change in Studio. Stop the test when you’re finished.", "accent", true, true)
define({ "PLAY EVIDENCE READY", "PLAY EVIDENCE RETURNED", "PLAY RECEIPT ACKNOWLEDGED", "RUNTIME COMPLETE" }, "Test results collected", "Return to Forge to see what was checked and review the result. Collection alone does not mean the test passed.", "success", false, true)
define({ "PLAY EVIDENCE INCOMPLETE", "RUNTIME INCOMPLETE", "RUNTIME REJECTED" }, "The test is incomplete", "Forge couldn’t collect everything it needed. Review the details in Forge before trying again.", "attention", false, true)
define({ "READING PROJECT" }, "Reading your project", "Forge is reading the objects and scripts in this place.", "accent", true, true)
define({ "PROJECT READ" }, "Project read complete", "The current project information has been sent to Forge. Continue in your conversation.", "success", false, true)
define({ "CHECKING CHANGES" }, "Checking the changes", "Forge is checking the approved changes before applying them.", "accent", true, true)
define({ "CHECK RETURNED" }, "Check results sent", "Review the results and any next action in your Forge conversation.", "success", false, true)
define({ "APPLYING CHANGES" }, "Applying the changes", "Forge is applying the changes you approved. Keep Studio open.", "accent", true, true)
define({ "CHANGES APPLIED" }, "Apply results sent", "Return to Forge to see what changed and what to do next.", "accent", false, true)
define({ "FINALIZING CHANGES" }, "Finishing the change", "Forge is completing the decision you made in the dashboard.", "accent", true, true)
define({ "CHANGES FINALIZED" }, "Change results sent", "Review the result in Forge. Save your place in Studio when you’re ready.", "success", false, true)
define({ "CONNECTING PROJECT" }, "Connecting this project", "Forge is recording the project connection you approved.", "accent", true, true)
define({ "PROJECT CONNECTED" }, "Project connection checked", "Return to Forge to review the result and continue your conversation.", "success", false, true)

function Presentation.status(code: string): Status
	return statuses[code] or statuses["EVIDENCE INCOMPLETE"]
end

export type ConnectionMode = "connecting" | "connected" | "disconnected" | "reserved" | "invalid_receipt"
function Presentation.connection(mode: ConnectionMode): { label: string, action: string, enabled: boolean, showPrimary: boolean }
	if mode == "invalid_receipt" then return { label = "Needs attention", action = "Discard invalid test data", enabled = true, showPrimary = true } end
	if mode == "reserved" then return { label = "Test session", action = "Test session in use", enabled = false, showPrimary = false } end
	if mode == "connected" then return { label = "Connected", action = "Disconnect", enabled = true, showPrimary = false } end
	if mode == "connecting" then return { label = "Connecting", action = "Connecting automatically…", enabled = false, showPrimary = false } end
	return { label = "Not connected", action = "Connect", enabled = true, showPrimary = true }
end

local commands = {
	CollectStudioProjectIndex = { started = "READING PROJECT", finished = "PROJECT READ" },
	RequestStudioEvidence = { started = "READING PROJECT", finished = "CHECK RETURNED" },
	PreflightCreatorChangeSet = { started = "CHECKING CHANGES", finished = "CHECK RETURNED" },
	ApplyCreatorChangeSet = { started = "APPLYING CHANGES", finished = "CHANGES APPLIED" },
	FinalizeCreatorChangeSet = { started = "FINALIZING CHANGES", finished = "CHANGES FINALIZED" },
	RollbackCreatorCheckpoint = { started = "FINALIZING CHANGES", finished = "CHANGES FINALIZED" },
	LinkStudioProject = { started = "CONNECTING PROJECT", finished = "PROJECT CONNECTED" },
	ForkStudioProject = { started = "CONNECTING PROJECT", finished = "PROJECT CONNECTED" },
}
function Presentation.command(kind: string): { started: string, finished: string }?
	return (commands :: {[string]: { started: string, finished: string }})[kind]
end

return Presentation
