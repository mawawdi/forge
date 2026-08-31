--!strict
-- Applies only canonical, creator-approved, allowlisted Studio changes. The
-- model never calls this module and no operation contains executable callbacks.
local StudioAuthoring = {}
StudioAuthoring.__index = StudioAuthoring

local ALLOWED_CLASSES = { Folder = true, Model = true, Part = true, ProximityPrompt = true, RemoteEvent = true, RemoteFunction = true, Script = true, LocalScript = true, ModuleScript = true }
local SCRIPT_CLASSES = { Script = true, LocalScript = true, ModuleScript = true }
local ROOTS = { Workspace = true, ReplicatedStorage = true, ServerScriptService = true, ServerStorage = true, StarterPlayer = true, StarterGui = true, StarterPack = true, ReplicatedFirst = true, Lighting = true, SoundService = true, Teams = true }
local PART_PROPERTIES = { Anchored = "boolean", CanCollide = "boolean", CanTouch = "boolean", CFrame = "cframe", Color = "color3", Material = "string", Size = "vector3", Transparency = "number" }
local PROMPT_PROPERTIES = { ActionText = "string", Enabled = "boolean", HoldDuration = "number", MaxActivationDistance = "number", ObjectText = "string", RequiresLineOfSight = "boolean" }
local MATERIAL_ENUM_NAMES = { Plastic = true, SmoothPlastic = true, Wood = true, WoodPlanks = true, Metal = true, DiamondPlate = true, Foil = true, Grass = true, Ice = true, Brick = true, Sand = true, Fabric = true, Granite = true, Marble = true, Pebble = true, Cobblestone = true, Concrete = true, CorrodedMetal = true, Glacier = true, Glass = true, Neon = true, ForceField = true }
local MAX_SOURCE_UTF8_BYTES = 48000
local MAX_SIZE_COMPONENT = 2048
local MAX_ABSOLUTE_VECTOR_COMPONENT = 100000
local MAX_ABSOLUTE_CFRAME_TRANSLATION = 100000

-- These indirections keep payload validation testable without granting a test
-- environment access to Studio services or source hashing.
local function changeHistoryService() return game:GetService("ChangeHistoryService") end
local function httpService() return game:GetService("HttpService") end
local function sha256(value: string): string return require(script.Parent.Hash).sha256(value) end

local function pathOf(instance: Instance): string
	local parts = {}
	local cursor: Instance? = instance
	while cursor and cursor ~= game do table.insert(parts, 1, cursor.Name); cursor = cursor.Parent end
	return table.concat(parts, "/")
end

local function resolvePath(path: string): Instance?
	if typeof(path) ~= "string" or string.find(path, "\\", 1, true) or string.sub(path, 1, 1) == "/" or string.sub(path, -1) == "/" then return nil end
	local pieces = string.split(path, "/")
	if #pieces < 1 or not ROOTS[pieces[1]] then return nil end
	local current: Instance? = game:FindFirstChild(pieces[1])
	for index = 2, #pieces do
		local name = pieces[index]
		if name == "" or name == "." or name == ".." or not current then return nil end
		current = current:FindFirstChild(name)
	end
	return current
end

local function finite(value: any): boolean return typeof(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge end

local function exactKeys(value: any, keys: {string})
	if typeof(value) ~= "table" then error("typed property value must be a table") end
	local allowed = {}
	for _, key in ipairs(keys) do allowed[key] = true end
	for key in pairs(value) do if typeof(key) ~= "string" or not allowed[key] then error("typed property value has an unexpected field") end end
	for _, key in ipairs(keys) do if value[key] == nil then error("typed property value is missing " .. key) end end
end

local function exactSequence(value: any, length: number)
	if typeof(value) ~= "table" or #value ~= length then error("typed property sequence has an invalid length") end
	for key in pairs(value) do if typeof(key) ~= "number" or key < 1 or key > length or key % 1 ~= 0 then error("typed property sequence has an unexpected field") end end
end

local function colorByte(value: number): number
	local byte = math.floor(value * 255 + 0.5)
	if math.abs(value - byte / 255) > 0.00000001 then error("Color3 channel is not in canonical 8-bit Studio form") end
	return byte
end

local function validateTypedValue(value: any, expected: string, propertyName: string)
	if typeof(value) ~= "table" or value.type ~= expected then error("property type mismatch") end
	if expected == "boolean" or expected == "string" or expected == "number" then
		exactKeys(value, { "type", "value" })
		if typeof(value.value) ~= expected or expected == "number" and not finite(value.value) then error("invalid primitive property value") end
		if propertyName == "Transparency" and (value.value < 0 or value.value > 1) then error("Transparency must be between 0 and 1") end
		if propertyName == "HoldDuration" and (value.value < 0 or value.value > 3600) then error("HoldDuration is outside the Forge bound") end
		if propertyName == "MaxActivationDistance" and (value.value < 0 or value.value > 1000) then error("MaxActivationDistance is outside the Forge bound") end
		if (propertyName == "ActionText" or propertyName == "ObjectText") and #value.value > 200 then error(propertyName .. " exceeds the Forge UTF-8 byte bound") end
		if propertyName == "Material" and not MATERIAL_ENUM_NAMES[value.value] then error("Material is not in the Forge allowlist") end
	elseif expected == "vector3" then
		exactKeys(value, { "type", "x", "y", "z" })
		if not finite(value.x) or not finite(value.y) or not finite(value.z) then error("invalid Vector3 property value") end
		for _, component in ipairs({ value.x, value.y, value.z }) do
			local numeric = component :: number
			if math.abs(numeric) > MAX_ABSOLUTE_VECTOR_COMPONENT then error("Vector3 component exceeds the Forge bound") end
			if propertyName == "Size" and (numeric <= 0 or numeric > MAX_SIZE_COMPONENT) then error("Size components must be greater than 0 and within the Forge bound") end
		end
	elseif expected == "color3" then
		exactKeys(value, { "type", "r", "g", "b" })
		if not finite(value.r) or not finite(value.g) or not finite(value.b) or value.r < 0 or value.r > 1 or value.g < 0 or value.g > 1 or value.b < 0 or value.b > 1 then error("invalid Color3 property value") end
		colorByte(value.r); colorByte(value.g); colorByte(value.b)
	elseif expected == "cframe" then
		exactKeys(value, { "type", "components" }); exactSequence(value.components, 12)
		for index, component in ipairs(value.components) do
			if not finite(component) then error("invalid CFrame component") end
			local numeric = component :: number
			if index <= 3 and math.abs(numeric) > MAX_ABSOLUTE_CFRAME_TRANSLATION then error("CFrame translation exceeds the Forge bound") end
			if index > 3 and math.abs(numeric) > 1.001 then error("CFrame rotation component is out of range") end
		end
	end
	if expected ~= "boolean" and expected ~= "string" and expected ~= "number" and expected ~= "vector3" and expected ~= "color3" and expected ~= "cframe" then error("unsupported typed property value") end
end

local function typedValue(value: any, expected: string, propertyName: string): any
	validateTypedValue(value, expected, propertyName)
	if expected == "boolean" or expected == "string" or expected == "number" then
		if propertyName == "Material" then
			local material = Enum.Material[value.value]
			if material == nil then error("Material is unavailable in this Studio build") end
			return material
		end
		return value.value
	elseif expected == "vector3" then return Vector3.new(value.x, value.y, value.z)
	elseif expected == "color3" then return Color3.fromRGB(colorByte(value.r), colorByte(value.g), colorByte(value.b))
	elseif expected == "cframe" then return CFrame.new(table.unpack(value.components)) end
	error("unsupported typed property value")
end

local function validateName(value: any)
	if typeof(value) ~= "string" or value == "" or #value > 100 or string.find(value, "/", 1, true) or value == "." or value == ".." then error("invalid instance name") end
end

local function validateAttributes(attributes: any)
	if typeof(attributes) ~= "table" then error("attributes must be a table") end
	local count = 0
	for name, value in pairs(attributes) do
		count += 1
		if count > 64 then error("attributes exceed the Forge bound") end
		if typeof(name) ~= "string" or name == "" or #name > 100 or string.sub(name, 1, 6) == "_forge" or typeof(value) ~= "string" and typeof(value) ~= "number" and typeof(value) ~= "boolean" or typeof(value) == "number" and not finite(value) or typeof(value) == "string" and #value > 4096 then error("attribute is not allowlisted") end
	end
end

local function validateRemovedAttributes(attributes: any, sets: any)
	if typeof(attributes) ~= "table" or #attributes > 64 then error("removedAttributes must be a bounded sequence") end
	local seen = {}
	for index, name in ipairs(attributes) do
		if typeof(name) ~= "string" or name == "" or #name > 100 or string.sub(name, 1, 6) == "_forge" or seen[name] or sets[name] ~= nil then error("removed attribute is invalid, duplicated, or also set") end
		seen[name] = true
	end
	for key in pairs(attributes) do if typeof(key) ~= "number" or key < 1 or key > #attributes or key % 1 ~= 0 then error("removedAttributes must be a sequence") end end
end

local function validateProperties(className: string, properties: any)
	if typeof(properties) ~= "table" then error("properties must be a table") end
	local allow = className == "Part" and PART_PROPERTIES or className == "ProximityPrompt" and PROMPT_PROPERTIES or {}
	for name, value in pairs(properties) do
		local expected = allow[name]
		if typeof(expected) ~= "string" then error("property is not allowlisted for " .. className .. ": " .. tostring(name)) end
		validateTypedValue(value, expected :: string, name)
	end
end

-- Constructing the typed values is non-mutating. Do it during prepare so an
-- unavailable Enum item or Studio value conversion cannot surface after a
-- recording begins or after an earlier operation in the batch has mutated.
local function preflightProperties(className: string, properties: any)
	validateProperties(className, properties)
	local allow = className == "Part" and PART_PROPERTIES or className == "ProximityPrompt" and PROMPT_PROPERTIES or {}
	for name, value in pairs(properties) do typedValue(value, allow[name], name) end
end

local function validUtf8(value: string): boolean
	local ok, length = pcall(function() return utf8.len(value) end)
	return ok and length ~= nil
end

local function validateSource(value: any, required: boolean)
	if value == nil then if required then error("script source is required") end; return end
	if typeof(value) ~= "string" then error("script source must be a string") end
	if #value > MAX_SOURCE_UTF8_BYTES or not validUtf8(value) or required and not string.find(value, "%S") then error("script source must be non-empty valid UTF-8 within the Forge byte bound") end
end

local function validateExisting(operation: any, registry)
	local instance = registry:find(operation.stableId)
	if not instance or pathOf(instance) ~= operation.expectedPath or instance.ClassName ~= operation.expectedClass then error("existing target precondition mismatch") end
	if not ALLOWED_CLASSES[instance.ClassName] then error("existing target class is not allowlisted") end
	return instance
end

local function preflightOperation(operation: any, registry)
	if typeof(operation) ~= "table" or typeof(operation.id) ~= "string" or operation.id == "" or typeof(operation.kind) ~= "string" then error("invalid change operation envelope") end
	if operation.kind == "create" then
		if typeof(operation.tempId) ~= "string" or operation.tempId == "" or not ALLOWED_CLASSES[operation.className] then error("invalid create operation") end
		validateName(operation.name)
		local parent = resolvePath(operation.parentPath)
		if not parent then error("create parent is missing or forbidden") end
		if parent:FindFirstChild(operation.name) then error("create target already exists") end
		preflightProperties(operation.className, operation.properties)
		validateAttributes(operation.attributes)
		validateSource(operation.source, SCRIPT_CLASSES[operation.className])
		if not SCRIPT_CLASSES[operation.className] and operation.source ~= nil then error("non-script create cannot carry source") end
	elseif operation.kind == "update" then
		validateExisting(operation, registry); preflightProperties(operation.expectedClass, operation.properties); validateAttributes(operation.attributes); validateRemovedAttributes(operation.removedAttributes, operation.attributes)
	elseif operation.kind == "move" then
		local instance = validateExisting(operation, registry); validateName(operation.name)
		local parent = resolvePath(operation.parentPath); if not parent then error("move parent is missing or forbidden") end
		local collision = parent:FindFirstChild(operation.name); if collision and collision ~= instance then error("move destination already exists") end
		preflightProperties(operation.expectedClass, operation.properties); validateAttributes(operation.attributes); validateRemovedAttributes(operation.removedAttributes, operation.attributes)
	elseif operation.kind == "delete" then
		local instance = validateExisting(operation, registry)
		local descendants = instance:GetDescendants()
		if #descendants > 64 then error("delete subtree exceeds bound") end
		for _, descendant in ipairs(descendants) do if not ALLOWED_CLASSES[descendant.ClassName] then error("delete subtree contains unsupported class") end end
	elseif operation.kind == "write_source" then
		local instance = validateExisting(operation, registry)
		validateSource(operation.source, true)
		validateAttributes(operation.attributes); validateRemovedAttributes(operation.removedAttributes, operation.attributes)
		if not instance:IsA("LuaSourceContainer") or sha256(instance.Source) ~= operation.beforeSourceHash then error("script source precondition mismatch") end
	else error("operation kind is not allowlisted") end
end

local function applyProperties(instance: Instance, properties: any)
	local allow = instance.ClassName == "Part" and PART_PROPERTIES or instance.ClassName == "ProximityPrompt" and PROMPT_PROPERTIES or {}
	for name, value in pairs(properties) do (instance :: any)[name] = typedValue(value, allow[name], name) end
end

local function applyAttributes(instance: Instance, attributes: any, removedAttributes: any?)
	for name, value in pairs(attributes) do instance:SetAttribute(name, value) end
	for _, name in ipairs(removedAttributes or {}) do instance:SetAttribute(name, nil) end
end

local function applyOperation(operation: any, registry)
	if operation.kind == "create" then
		local instance = Instance.new(operation.className)
		instance.Name = operation.name
		applyProperties(instance, operation.properties)
		applyAttributes(instance, operation.attributes)
		if instance:IsA("LuaSourceContainer") then instance.Source = operation.source end
		instance.Parent = resolvePath(operation.parentPath)
		registry:enrollInstance(instance)
	elseif operation.kind == "update" then
		local instance = validateExisting(operation, registry); applyProperties(instance, operation.properties); applyAttributes(instance, operation.attributes, operation.removedAttributes)
	elseif operation.kind == "move" then
		local instance = validateExisting(operation, registry); applyProperties(instance, operation.properties); applyAttributes(instance, operation.attributes, operation.removedAttributes); instance.Name = operation.name; instance.Parent = resolvePath(operation.parentPath)
	elseif operation.kind == "delete" then validateExisting(operation, registry):Destroy()
	elseif operation.kind == "write_source" then
		local instance = validateExisting(operation, registry)
		if not instance:IsA("LuaSourceContainer") then error("source target changed class") end
		applyAttributes(instance, operation.attributes, operation.removedAttributes)
		instance.Source = operation.source
	end
end

-- Pure validation entry point used by the connector module tests. It shares
-- the exact preflight validators above but deliberately does not resolve or
-- mutate a Studio instance.
function StudioAuthoring.validatePayloadForTest(input: any): boolean
	if typeof(input) ~= "table" or typeof(input.className) ~= "string" or typeof(input.kind) ~= "string" then error("invalid validation test payload") end
	validateProperties(input.className, input.properties)
	validateAttributes(input.attributes)
	validateRemovedAttributes(input.removedAttributes or {}, input.attributes)
	validateSource(input.source, input.sourceRequired == true)
	if input.sourceRequired == true and not SCRIPT_CLASSES[input.className] then error("only script classes can require source") end
	if input.sourceRequired ~= true and input.source ~= nil then error("source is forbidden for this test payload") end
	return true
end

function StudioAuthoring.reconcile(plugin: Plugin)
	local recordingId = plugin:GetSetting("forge.creator.activeRecording")
	if typeof(recordingId) == "string" and recordingId ~= "" then
		pcall(function() changeHistoryService():FinishRecording(recordingId, Enum.FinishRecordingOperation.Cancel) end)
		plugin:SetSetting("forge.creator.activeRecording", nil)
	end
end

function StudioAuthoring.new(plugin: Plugin, registry)
	return setmetatable({ plugin = plugin, registry = registry, prepared = nil, active = nil, lastCommitted = nil }, StudioAuthoring)
end

function StudioAuthoring:prepare(payload: any, currentRevision: string)
	if self.active then error("a creator change recording is already active") end
	if typeof(payload.changeSetJson) ~= "string" or typeof(payload.changeSetJsonHash) ~= "string" or sha256(payload.changeSetJson) ~= payload.changeSetJsonHash or payload.expectedRevision ~= currentRevision then error("creator change transport or revision precondition mismatch") end
	local decodedOk, changeSet = pcall(function() return httpService():JSONDecode(payload.changeSetJson) end)
	if not decodedOk or typeof(changeSet) ~= "table" or changeSet.kind ~= "CreatorChangeSet" or changeSet.sessionId ~= payload.creatorSessionId or changeSet.expectedRevisionHash ~= currentRevision or changeSet.localGate.status ~= "eligible" or typeof(changeSet.operations) ~= "table" or #changeSet.operations < 1 or #changeSet.operations > 32 then error("creator change set rejected") end
	local operationIds, planChangeIds, tempIds, createdPaths, existingTargets = {}, {}, {}, {}, {}
	for _, operation in ipairs(changeSet.operations) do
		if operationIds[operation.id] then error("duplicate creator operation ID") end; operationIds[operation.id] = true
		if typeof(operation.planChangeId) ~= "string" or operation.planChangeId == "" or planChangeIds[operation.planChangeId] then error("missing or duplicate plan-change binding") end; planChangeIds[operation.planChangeId] = true
		if operation.kind == "create" then
			local createdPath = operation.parentPath .. "/" .. operation.name
			if tempIds[operation.tempId] or createdPaths[createdPath] then error("duplicate creator temp ID or create path") end
			tempIds[operation.tempId] = true; createdPaths[createdPath] = true
		else
			if existingTargets[operation.stableId] then error("multiple operations target the same existing Studio instance") end
			existingTargets[operation.stableId] = true
		end
		preflightOperation(operation, self.registry)
	end
	self.prepared = { changeSet = changeSet, transportHash = payload.changeSetJsonHash, beforeRevision = currentRevision, requestId = payload.requestId }
	return { creatorSessionId = changeSet.sessionId, changeSetId = changeSet.id, changeSetHash = changeSet.hash, recordingId = "recording_pending_" .. changeSet.id, beforeRevisionHash = currentRevision, status = "prepared" }
end

function StudioAuthoring:apply(changeSetId: string, changeSetHash: string, currentRevision: string)
	local prepared = self.prepared
	if not prepared or prepared.changeSet.id ~= changeSetId or prepared.changeSet.hash ~= changeSetHash or prepared.beforeRevision ~= currentRevision then error("creator change set was not prepared for the current Studio revision") end
	for _, operation in ipairs(prepared.changeSet.operations) do preflightOperation(operation, self.registry) end
	local recording = changeHistoryService():TryBeginRecording("Forge creator change " .. changeSetId)
	if not recording then error("Studio could not begin a creator change recording") end
	self.plugin:SetSetting("forge.creator.activeRecording", recording)
	local applied, failure = pcall(function() for _, operation in ipairs(prepared.changeSet.operations) do applyOperation(operation, self.registry) end end)
	if not applied then
		local cancelled = pcall(function() changeHistoryService():FinishRecording(recording, Enum.FinishRecordingOperation.Cancel) end)
		self.plugin:SetSetting("forge.creator.activeRecording", nil)
		self.prepared = nil
		if not cancelled then error("RECOVERY_REQUIRED: " .. tostring(failure)) end
		error(tostring(failure))
	end
	self.active = { recording = recording, prepared = prepared }
	self.prepared = nil
	return recording
end

function StudioAuthoring:finalize(recordingId: string, action: string)
	local active = self.active
	if not active or active.recording ~= recordingId or action ~= "commit" and action ~= "cancel" then error("creator recording finalization mismatch") end
	local operation = action == "commit" and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
	local ok, failure = pcall(function() changeHistoryService():FinishRecording(active.recording, operation) end)
	self.plugin:SetSetting("forge.creator.activeRecording", nil)
	self.active = nil
	if not ok then error("RECOVERY_REQUIRED: " .. tostring(failure)) end
	if action == "commit" then self.lastCommitted = { changeSetId = active.prepared.changeSet.id, changeSetHash = active.prepared.changeSet.hash, beforeRevision = active.prepared.beforeRevision } end
	return active.prepared
end

function StudioAuthoring:bindCommittedRevision(changeSetId: string, changeSetHash: string, afterRevision: string)
	local committed = self.lastCommitted
	if not committed or committed.changeSetId ~= changeSetId or committed.changeSetHash ~= changeSetHash then error("committed creator change binding mismatch") end
	committed.afterRevision = afterRevision
	self.plugin:SetSetting("forge.creator.lastCommit", committed)
end

function StudioAuthoring:rollback(payload: any, currentRevision: string)
	if self.active then error("cannot roll back while a creator recording is active") end
	local committed = self.plugin:GetSetting("forge.creator.lastCommit")
	if typeof(committed) ~= "table" or committed.changeSetId ~= payload.changeSetId or committed.changeSetHash ~= payload.changeSetHash or committed.afterRevision ~= currentRevision or payload.expectedRevision ~= currentRevision then error("guarded creator rollback precondition mismatch") end
	local ok, failure = pcall(function() changeHistoryService():Undo() end)
	if not ok then error("RECOVERY_REQUIRED: " .. tostring(failure)) end
	self.plugin:SetSetting("forge.creator.lastCommit", nil)
	self.lastCommitted = nil
	return committed
end

function StudioAuthoring:abort()
	if not self.active then self.prepared = nil; return true end
	local ok = pcall(function() changeHistoryService():FinishRecording(self.active.recording, Enum.FinishRecordingOperation.Cancel) end)
	self.plugin:SetSetting("forge.creator.activeRecording", nil)
	self.active = nil; self.prepared = nil
	return ok
end

return StudioAuthoring
