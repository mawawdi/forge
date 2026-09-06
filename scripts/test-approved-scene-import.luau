local ApprovedSceneImport = require("../plugin/src/Forge/ApprovedSceneImport")

local hash = string.rep("a", 64)
local binding = {
	kind = "import_approved_scene", abi = "import_approved_scene@2",
	scene = { sceneId = "fixture-scene", revision = 1, hash = hash },
	bundleManifestHash = hash, sceneReviewHash = hash, uploadAuthorizationHash = hash,
	capabilityProfileHash = hash, inspectionHash = hash, sourceArtifactHash = hash,
	receiptHash = hash, contentHash = hash, platformEnvelopeHash = hash,
	partitionId = "static-chunk", partitionRole = "WorldStatic", assetId = "1234", versionNumber = 1,
	descendants = {
		{ stableId = "imported-mesh", relativePath = "ImportedMesh", name = "ImportedMesh", className = "MeshPart", pivotHash = hash, transformHash = hash, boundsHash = hash },
	},
}

assert(ApprovedSceneImport.validateBinding(binding), "an exact approved scene import binding must validate")

local executable = table.clone(binding)
executable.descendants = { table.clone(binding.descendants[1]) }
executable.descendants[1].className = "Script"
assert(not pcall(function() ApprovedSceneImport.validateBinding(executable) end), "approved scene imports must reject executable descendants")

local duplicate = table.clone(binding)
duplicate.descendants = { binding.descendants[1], table.clone(binding.descendants[1]) }
assert(not pcall(function() ApprovedSceneImport.validateBinding(duplicate) end), "approved scene imports must reject ambiguous stable identities and paths")

local nestedRoot = table.clone(binding)
nestedRoot.descendants = { table.clone(binding.descendants[1]) }
nestedRoot.descendants[1].relativePath = "Unexpected/ImportedMesh"
assert(not pcall(function() ApprovedSceneImport.validateBinding(nestedRoot) end), "a root descendant cannot claim an unresolved parent path")

local nextBinding = table.clone(binding)
nextBinding.scene = table.clone(binding.scene)
nextBinding.scene.revision = 2
nextBinding.scene.hash = string.rep("b", 64)
nextBinding.assetId = "5678"
nextBinding.sourceArtifactHash = string.rep("b", 64)
nextBinding.receiptHash = string.rep("b", 64)
nextBinding.contentHash = string.rep("b", 64)
local replacement = {
	kind = "replace_approved_scene", abi = "replace_approved_scene@2",
	previous = binding, next = nextBinding,
	previousTarget = { kind = "instance", identity = { kind = "forge_attribute", stableId = "old-static-chunk" }, path = "Workspace/VisualRoot/static-chunk", className = "Model" },
	previousBeforeHash = hash, repairDeltaHash = string.rep("c", 64),
}
assert(ApprovedSceneImport.validateReplacement(replacement), "an exact replacement binding must validate")
assert(ApprovedSceneImport.replacementAsset(replacement) == nextBinding, "replacement loading must select only the next approved asset")
local staleReplacement = table.clone(replacement)
staleReplacement.next = table.clone(binding)
assert(not pcall(function() ApprovedSceneImport.validateReplacement(staleReplacement) end), "a replacement must advance one retained scene identity")

print("approved scene import tests passed")
