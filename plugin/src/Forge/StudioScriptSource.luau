--!strict
-- Source access has one connector-owned route. An open editor buffer is the
-- current Studio document, so reading `Source` directly would silently index
-- stale text. The fallback is used only when Studio reports no editor buffer.
local StudioScriptSource = {}
local Hash = if script ~= nil then require(script.Parent.Hash) else require("./Hash")

local function editorService()
	return game:GetService("ScriptEditorService")
end

function StudioScriptSource.read(instance: Instance): (string, boolean)
	if not instance:IsA("LuaSourceContainer") then error("Studio source capability is unavailable for " .. instance.ClassName) end
	local documentKnown, document = pcall(function() return editorService():FindScriptDocument(instance) end)
	if not documentKnown then error("Studio could not determine whether the script document is open: " .. tostring(document)) end
	if document ~= nil then
		local opened, source = pcall(function() return editorService():GetEditorSource(instance) end)
		if not opened or typeof(source) ~= "string" then error("Studio open script document is unreadable: " .. tostring(source)) end
		return source, true
	end
	local readable, persisted = pcall(function() return (instance :: any).Source end)
	if not readable or typeof(persisted) ~= "string" then error("Studio source is unreadable: " .. tostring(persisted)) end
	return persisted, false
end

-- UpdateSourceAsync is required for a currently open document so Studio keeps
-- the buffer/editor state coherent. A closed document remains a normal typed
-- property write; no failed editor call is swallowed as a successful write.
function StudioScriptSource.write(instance: Instance, expectedBeforeHash: string, source: string)
	if not instance:IsA("LuaSourceContainer") then error("Studio source capability is unavailable for " .. instance.ClassName) end
	if typeof(expectedBeforeHash) ~= "string" or not string.match(expectedBeforeHash, "^[0-9a-f]+$") or #expectedBeforeHash ~= 64 then error("Studio source expected-before hash is invalid") end
	if typeof(source) ~= "string" then error("Studio source must be a string") end
	local documentKnown, document = pcall(function() return editorService():FindScriptDocument(instance) end)
	if not documentKnown then error("Studio could not determine whether the script document is open: " .. tostring(document)) end
	if document ~= nil then
		local updated, failure = pcall(function()
			editorService():UpdateSourceAsync(instance, function(callbackCurrent: string)
				if typeof(callbackCurrent) ~= "string" or Hash.sha256(callbackCurrent) ~= expectedBeforeHash then error("source changed before approved edit") end
				return source
			end)
		end)
		if not updated then error("ScriptEditorService UpdateSourceAsync failed: " .. tostring(failure)) end
		return
	end
	local readable, persisted = pcall(function() return (instance :: any).Source end)
	if not readable or typeof(persisted) ~= "string" then error("Studio source is unreadable before write: " .. tostring(persisted)) end
	if Hash.sha256(persisted) ~= expectedBeforeHash then error("source changed before approved edit") end
	(instance :: any).Source = source
end

-- Every source mutation, including detached canaries, uses this exact
-- write/readback route.  The live path therefore retains the
-- ScriptEditorService callback guard for an open document, while a detached
-- scratch instance exercises the same closed-document implementation.  A
-- caller cannot turn a successful setter call into a successful source proof
-- without observing the exact approved result through `read`.
function StudioScriptSource.writeAndReadback(
	instance: Instance,
	expectedBeforeHash: string,
	expectedAfterHash: string,
	source: string
): string
	if typeof(expectedAfterHash) ~= "string" or not string.match(expectedAfterHash, "^[0-9a-f]+$") or #expectedAfterHash ~= 64 then error("Studio source expected-after hash is invalid") end
	StudioScriptSource.write(instance, expectedBeforeHash, source)
	local readback = StudioScriptSource.read(instance)
	if Hash.sha256(readback) ~= expectedAfterHash then error("Studio source write/readback hash mismatch") end
	return readback
end

return StudioScriptSource
