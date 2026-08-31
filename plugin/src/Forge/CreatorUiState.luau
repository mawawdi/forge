--!strict
-- Pure presentation mapping for the UI-independent CreatorControlView. Workflow
-- legality is supplied by the coordinator as explicit action descriptors.
local CreatorUiState = {}

local ACTIONS = {
	approve_plan = true, reject_plan = true,
	approve_and_apply_changes = true, reject_changes = true,
	start_checks = true, cancel_changes = true,
	accept_result = true, reject_and_rollback = true,
}

local function action(value: any, intent: string): any?
	if value == nil then return nil end
	if typeof(value) ~= "table" or value.intent ~= intent or typeof(value.id) ~= "string" or not ACTIONS[value.id] or typeof(value.label) ~= "string" or value.label == "" then error("invalid creator control action descriptor") end
	return { id = value.id, label = value.label, intent = intent }
end

function CreatorUiState.fromView(view: any)
	if typeof(view) ~= "table" or view.kind ~= "CreatorControlView" or typeof(view.id) ~= "string" or typeof(view.hash) ~= "string" or typeof(view.creatorSessionId) ~= "string" or typeof(view.creatorSessionHash) ~= "string" or typeof(view.status) ~= "string" or typeof(view.title) ~= "string" or typeof(view.detail) ~= "string" then error("invalid creator control view") end
	local primary = action(view.primaryAction, "primary")
	local secondary = action(view.secondaryAction, "secondary")
	if primary and secondary and primary.id == secondary.id then error("creator control actions must be distinct") end
	return {
		viewId = view.id, viewHash = view.hash, creatorSessionId = view.creatorSessionId,
		status = view.status, title = view.title, detail = view.detail,
		primary = primary, secondary = secondary,
	}
end

function CreatorUiState.actionPayload(view: any, intent: string)
	local mapped = CreatorUiState.fromView(view)
	local selected = intent == "primary" and mapped.primary or intent == "secondary" and mapped.secondary or nil
	if not selected then error("creator control action is unavailable") end
	return { creatorSessionId = mapped.creatorSessionId, viewId = mapped.viewId, viewHash = mapped.viewHash, actionId = selected.id }
end

return CreatorUiState
