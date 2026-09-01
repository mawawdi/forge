--!strict

-- Stable identity applies only to generated-manifest instances in generated
-- manifest roots. There is intentionally no second discovery class table.
local StudioInstancePolicy = {}
local Generated = if script ~= nil then require(script.Parent.GeneratedStudioEvidence) else require("./GeneratedStudioEvidence")

function StudioInstancePolicy.isEvidenceRelevant(instance): boolean
	return Generated.classMetadata(instance.ClassName) ~= nil
end

function StudioInstancePolicy.rootNames(): {string}
	return table.clone(Generated.authoringRoots)
end

function StudioInstancePolicy.isWithinEvidenceRoot(instance): boolean
	local cursor = instance
	while cursor.Parent and cursor.Parent ~= game do cursor = cursor.Parent end
	return cursor.Parent == game and Generated.isAllowedRoot(cursor.Name)
end

function StudioInstancePolicy.shouldHaveStableIdentity(instance): boolean
	return StudioInstancePolicy.isWithinEvidenceRoot(instance)
		and StudioInstancePolicy.isEvidenceRelevant(instance)
end

return StudioInstancePolicy
