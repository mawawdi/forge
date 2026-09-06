--!strict
-- Fixed verifier for retained, reviewed scene assets. The operation carries no
-- path, URL, argument or executable surface: LoadAssetAsync receives only the
-- exact numeric asset identity retained by the host.
local Canonical = if script ~= nil then require(script.Parent.StudioProjectIndexCanonical) else require("./StudioProjectIndexCanonical")
local Hash = if script ~= nil then require(script.Parent.Hash) else require("./Hash")

local ApprovedSceneImport = {}

local function exactHash(value: any): boolean
	return typeof(value) == "string" and #value == 64 and string.match(value, "^[0-9a-f]+$") ~= nil
end

local function validSegment(value: any): boolean
	return typeof(value) == "string" and value ~= "" and #value <= 100 and not string.find(value, "/", 1, true) and value ~= "." and value ~= ".."
end

local function validRelativePath(value: any): boolean
	if typeof(value) ~= "string" or value == "" or #value > 2048 or string.sub(value, 1, 1) == "/" or string.sub(value, -1) == "/" then return false end
	for _, segment in ipairs(string.split(value, "/")) do if not validSegment(segment) then return false end end
	return true
end

local function executableClass(className: string): boolean
	return string.sub(className, -6) == "Script" or className == "PackageLink"
end

function ApprovedSceneImport.validateBinding(binding: any): boolean
	if typeof(binding) ~= "table" or binding.kind ~= "import_approved_scene" or binding.abi ~= "import_approved_scene@2" then error("approved scene import ABI mismatch") end
	if typeof(binding.scene) ~= "table" or typeof(binding.scene.sceneId) ~= "string" or binding.scene.sceneId == "" or typeof(binding.scene.revision) ~= "number" or binding.scene.revision % 1 ~= 0 or binding.scene.revision < 1 or not exactHash(binding.scene.hash) then error("approved scene import scene handle is malformed") end
	for _, field in ipairs({ "bundleManifestHash", "sceneReviewHash", "uploadAuthorizationHash", "capabilityProfileHash", "inspectionHash", "sourceArtifactHash", "receiptHash", "contentHash", "platformEnvelopeHash" }) do
		if not exactHash(binding[field]) then error("approved scene import hash binding is malformed: " .. field) end
	end
	if typeof(binding.partitionId) ~= "string" or binding.partitionId == "" or not table.find({ "WorldStatic", "WorldCollision", "GameplayAnchors", "InteractiveProps", "Effects" }, binding.partitionRole) then error("approved scene import partition is malformed") end
	if typeof(binding.assetId) ~= "string" or string.match(binding.assetId, "^[1-9][0-9]*$") == nil or #binding.assetId > 15 then error("approved scene import asset identity is malformed") end
	if typeof(binding.versionNumber) ~= "number" or binding.versionNumber % 1 ~= 0 or binding.versionNumber < 1 then error("approved scene import version is malformed") end
	if typeof(binding.descendants) ~= "table" or #binding.descendants > 65536 then error("approved scene import descendant inventory is malformed") end
	local byStableId, byPath, names = {}, {}, {}
	for _, node in ipairs(binding.descendants) do
		if typeof(node) ~= "table" or typeof(node.stableId) ~= "string" or node.stableId == "" or #node.stableId > 512 or not validRelativePath(node.relativePath) or not validSegment(node.name) or typeof(node.className) ~= "string" or node.className == "" or executableClass(node.className) then error("approved scene import descendant is malformed or executable") end
		if node.name ~= string.split(node.relativePath, "/")[#string.split(node.relativePath, "/")] then error("approved scene import descendant path/name mismatch") end
		if byStableId[node.stableId] or byPath[node.relativePath] or names[node.name] then error("approved scene import descendant identity, path, or name is ambiguous") end
		for _, field in ipairs({ "pivotHash", "transformHash", "boundsHash" }) do if not exactHash(node[field]) then error("approved scene import descendant geometry binding is malformed") end end
		if node.contentIdentity ~= nil and (typeof(node.contentIdentity) ~= "string" or #node.contentIdentity > 4096) then error("approved scene import content identity is malformed") end
		if node.materialIdentity ~= nil and (typeof(node.materialIdentity) ~= "string" or #node.materialIdentity > 4096) then error("approved scene import material identity is malformed") end
		byStableId[node.stableId] = node
		byPath[node.relativePath] = node
		names[node.name] = true
	end
	for _, node in ipairs(binding.descendants) do
		if node.parentStableId == nil then
			if string.find(node.relativePath, "/", 1, true) then error("approved scene import root child has a nested path") end
		else
			local parent = byStableId[node.parentStableId]
			if parent == nil or node.relativePath ~= parent.relativePath .. "/" .. node.name then error("approved scene import descendant parent/path mismatch") end
		end
	end
	return true
end

function ApprovedSceneImport.validateReplacement(binding: any): boolean
	if typeof(binding) ~= "table" or binding.kind ~= "replace_approved_scene" or binding.abi ~= "replace_approved_scene@2" then error("approved scene replacement ABI mismatch") end
	ApprovedSceneImport.validateBinding(binding.previous)
	ApprovedSceneImport.validateBinding(binding.next)
	if binding.previous.partitionId ~= binding.next.partitionId or binding.previous.partitionRole ~= binding.next.partitionRole then error("approved scene replacement changed partition identity") end
	if binding.previous.scene.sceneId ~= binding.next.scene.sceneId or binding.previous.scene.revision >= binding.next.scene.revision then error("approved scene replacement revision is invalid") end
	if typeof(binding.previousTarget) ~= "table" or binding.previousTarget.kind ~= "instance" or typeof(binding.previousTarget.identity) ~= "table" or binding.previousTarget.identity.kind ~= "forge_attribute" or typeof(binding.previousTarget.identity.stableId) ~= "string" or binding.previousTarget.identity.stableId == "" or typeof(binding.previousTarget.path) ~= "string" or binding.previousTarget.path == "" or binding.previousTarget.className ~= "Model" then error("approved scene replacement target is malformed") end
	if not exactHash(binding.previousBeforeHash) or not exactHash(binding.repairDeltaHash) then error("approved scene replacement prior-state binding is malformed") end
	return true
end

function ApprovedSceneImport.replacementAsset(binding: any): any
	ApprovedSceneImport.validateReplacement(binding)
	return binding.next
end

function ApprovedSceneImport.validateInspectionBinding(binding: any): boolean
	if typeof(binding) ~= "table" or binding.kind ~= "inspect_approved_scene_asset" or binding.abi ~= "inspect_approved_scene_asset@2" or not exactHash(binding.challengeHash) then error("approved scene inspection ABI mismatch") end
	if binding.inspectionHash ~= nil then error("approved scene inspection cannot claim its future inspection hash") end
	local projected = {}
	for key, value in pairs(binding) do projected[key] = value end
	projected.kind = "import_approved_scene"
	projected.abi = "import_approved_scene@2"
	projected.inspectionHash = binding.challengeHash
	projected.challengeHash = nil
	return ApprovedSceneImport.validateBinding(projected)
end

local function pathFrom(root: Instance, instance: Instance): string
	local segments = {}
	local cursor: Instance? = instance
	while cursor ~= nil and cursor ~= root do table.insert(segments, 1, cursor.Name); cursor = cursor.Parent end
	if cursor ~= root then error("approved scene import descendant escaped its root") end
	return table.concat(segments, "/")
end

local function cframeValue(value: CFrame): {number}
	return { value:GetComponents() }
end

local function vectorValue(value: Vector3): {number}
	return { value.X, value.Y, value.Z }
end

local function taggedHash(value: any): string
	return Hash.sha256(Canonical.transportJson(value))
end

local function transformMaterial(instance: Instance): any
	if instance:IsA("BasePart") then return { kind = "cframe", components = cframeValue(instance.CFrame) } end
	if instance:IsA("Model") then return { kind = "cframe", components = cframeValue(instance:GetPivot()) } end
	if instance:IsA("Attachment") then return { kind = "cframe", components = cframeValue(instance.CFrame) } end
	return { kind = "none" }
end

local function boundsMaterial(instance: Instance): any
	if instance:IsA("BasePart") then return { cframe = cframeValue(instance.CFrame), size = vectorValue(instance.Size) } end
	if instance:IsA("Model") then local at, size = instance:GetBoundingBox(); return { cframe = cframeValue(at), size = vectorValue(size) } end
	return { kind = "none" }
end

local function contentIdentity(instance: Instance): string?
	if instance:IsA("MeshPart") then return Canonical.transportJson({ meshId = instance.MeshId, textureId = instance.TextureID }) end
	if instance:IsA("SurfaceAppearance") then return Canonical.transportJson({ colorMap = instance.ColorMap, metalnessMap = instance.MetalnessMap, normalMap = instance.NormalMap, roughnessMap = instance.RoughnessMap }) end
	return nil
end

local function materialIdentity(instance: Instance): string?
	if instance:IsA("BasePart") then return instance.Material.Name end
	return nil
end

local function inspectValidated(root: Instance, binding: any): ({any}, {[string]: Instance})
	if root.ClassName ~= "Model" then error("approved scene import platform envelope is not a Model") end
	local packageLink: Instance? = nil
	for _, descendant in ipairs(root:GetDescendants()) do
		if descendant.ClassName == "PackageLink" then
			if packageLink ~= nil or descendant.Parent ~= root then error("approved scene import has an unexpected package envelope") end
			packageLink = descendant
		elseif descendant:IsA("LuaSourceContainer") or executableClass(descendant.ClassName) then
			error("approved scene import contains executable content")
		end
	end
	if packageLink == nil then error("approved scene import is missing its package envelope") end
	packageLink:Destroy()
	local envelopeHash = taggedHash({ className = "Model", packageLinks = { { className = "PackageLink", placement = "direct_child" } }, packageLinkRemoved = true })
	if envelopeHash ~= binding.platformEnvelopeHash then error("approved scene import platform envelope identity mismatch") end
	local actual, instancesByStableId, byPath = {}, {}, {}
	for _, instance in ipairs(root:GetDescendants()) do
		local relativePath = pathFrom(root, instance)
		if relativePath == "" or byPath[relativePath] ~= nil then error("approved scene import has an ambiguous hierarchy") end
		if instance:IsA("LuaSourceContainer") or executableClass(instance.ClassName) then error("approved scene import contains executable content") end
		byPath[relativePath] = instance
	end
	if #root:GetDescendants() ~= #binding.descendants then error("approved scene import descendant inventory changed") end
	local expectedByPath = {}
	for _, expected in ipairs(binding.descendants) do expectedByPath[expected.relativePath] = expected end
	for relativePath, instance in pairs(byPath) do
		local expected = expectedByPath[relativePath]
		if expected == nil or instance.Name ~= expected.name or instance.ClassName ~= expected.className then error("approved scene import hierarchy, name, or class changed") end
		local content = contentIdentity(instance)
		local material = materialIdentity(instance)
		local observed: any = {
			stableId = expected.stableId,
			relativePath = relativePath,
			name = instance.Name,
			className = instance.ClassName,
			pivotHash = taggedHash(transformMaterial(instance)),
			transformHash = taggedHash(transformMaterial(instance)),
			boundsHash = taggedHash(boundsMaterial(instance)),
		}
		if expected.parentStableId ~= nil then observed.parentStableId = expected.parentStableId end
		if content ~= nil then observed.contentIdentity = content end
		if material ~= nil then observed.materialIdentity = material end
		if Canonical.transportJson(observed) ~= Canonical.transportJson(expected) then error("approved scene import content, material, pivot, transform, or bounds changed") end
		table.insert(actual, observed)
		instancesByStableId[expected.stableId] = instance
	end
	table.sort(actual, function(left, right) return left.relativePath < right.relativePath end)
	if taggedHash(actual) ~= binding.contentHash then error("LoadAssetAsync returned a different latest asset version or content") end
	for _, instance in pairs(instancesByStableId) do
		if instance:IsA("BasePart") then instance.CanCollide = false; instance.CanTouch = false; instance.CanQuery = false end
	end
	return actual, instancesByStableId
end

local function inspect(root: Instance, binding: any): ({any}, {[string]: Instance})
	ApprovedSceneImport.validateBinding(binding)
	return inspectValidated(root, binding)
end

function ApprovedSceneImport.loadDetached(binding: any): (Model, {[string]: Instance})
	ApprovedSceneImport.validateBinding(binding)
	if game == nil then error("approved scene import requires Roblox Studio") end
	local assetId = tonumber(binding.assetId)
	if assetId == nil or assetId < 1 or assetId % 1 ~= 0 then error("approved scene import asset identity is not exactly numeric") end
	local root = game:GetService("AssetService"):LoadAssetAsync(assetId)
	if not root:IsA("Model") then root:Destroy(); error("approved scene import loader returned a non-Model envelope") end
	local ok, observedOrFailure, instances = pcall(function() local observed, indexed = inspect(root, binding); return observed, indexed end)
	if not ok then root:Destroy(); error(observedOrFailure) end
	return root, instances
end

function ApprovedSceneImport.inspectApprovedAsset(binding: any): any
	ApprovedSceneImport.validateInspectionBinding(binding)
	if game == nil then error("approved scene inspection requires Roblox Studio") end
	local assetId = tonumber(binding.assetId)
	if assetId == nil or assetId < 1 or assetId % 1 ~= 0 then error("approved scene inspection asset identity is not exactly numeric") end
	local loaded, rootOrFailure = pcall(function() return game:GetService("AssetService"):LoadAssetAsync(assetId) end)
	if not loaded then
		return { status = "incomplete", diagnostic = string.sub("LoadAssetAsync failed: " .. tostring(rootOrFailure), 1, 1024) }
	end
	local root = rootOrFailure :: Instance
	if not root:IsA("Model") then root:Destroy(); return { status = "rejected", diagnostic = "LoadAssetAsync returned a non-Model envelope" } end
	local inspected, observedOrFailure = pcall(function()
		local observed = inspectValidated(root, binding)
		return observed
	end)
	root:Destroy()
	if not inspected then return { status = "rejected", diagnostic = string.sub(tostring(observedOrFailure), 1, 1024) } end
	local nodes = {}
	for _, node in ipairs(observedOrFailure) do
		local enriched = {}
		for key, value in pairs(node) do enriched[key] = value end
		enriched.assetId = binding.assetId
		enriched.sourceArtifactHash = binding.sourceArtifactHash
		enriched.executable = false
		table.insert(nodes, enriched)
	end
	return {
		status = "eligible",
		partitionId = binding.partitionId,
		assetId = binding.assetId,
		versionNumber = binding.versionNumber,
		receiptHash = binding.receiptHash,
		sourceArtifactHash = binding.sourceArtifactHash,
		contentHash = binding.contentHash,
		platformEnvelopeHash = binding.platformEnvelopeHash,
		observedNodes = nodes,
	}
end

function ApprovedSceneImport.inspectDetachedForTest(root: Instance, binding: any): {any}
	local observed = inspect(root, binding)
	return observed
end

return ApprovedSceneImport
