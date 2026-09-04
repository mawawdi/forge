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

-- Invalidate the same facts that the project index actually captures. Camera
-- navigation and engine-derived UI geometry are not authoring changes.
function StudioInstancePolicy.isIndexedProperty(className: string, propertyName: any): boolean
	if propertyName == "Name" or propertyName == "Parent" or propertyName == "Source" or propertyName == "Tags" then return true end
	for _, property in ipairs(Generated.projectPropertyMetadata(className)) do
		if property.name == propertyName then return true end
	end
	return false
end

return StudioInstancePolicy
