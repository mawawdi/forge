--!strict
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local TransactionManager = {}
TransactionManager.__index = TransactionManager

function TransactionManager.new(snapshot)
	return setmetatable({ snapshot = snapshot, active = nil }, TransactionManager)
end

function TransactionManager:begin(transactionId: string, expectedRevision: string)
	if self.active then error("transaction already active") end
	if self.snapshot() ~= expectedRevision then error("transaction revision is stale") end
	local recording = ChangeHistoryService:TryBeginRecording("Forge " .. transactionId)
	if not recording then error("Studio refused ChangeHistory recording") end
	self.active = { id = transactionId, recording = recording, inverse = {}, beforeRevision = expectedRevision }
	return self.active
end

function TransactionManager:requireActive(transactionId: string, expectedRevision: string)
	if not self.active or self.active.id ~= transactionId then error("transaction mismatch") end
	if self.snapshot() ~= expectedRevision then error("transaction revision is stale") end
	return self.active
end

function TransactionManager:recordInverse(inverse)
	if not self.active then error("transaction missing") end
	table.insert(self.active.inverse, inverse)
end

function TransactionManager:commit(transactionId: string, expectedRevision: string)
	local active = self:requireActive(transactionId, expectedRevision)
	ChangeHistoryService:FinishRecording(active.recording, Enum.FinishRecordingOperation.Commit)
	self.active = nil
end

function TransactionManager:rollback(transactionId: string)
	if not self.active or self.active.id ~= transactionId then return false, "transaction mismatch" end
	local active = self.active
	self.active = nil
	local cancelled = pcall(function()
		ChangeHistoryService:FinishRecording(active.recording, Enum.FinishRecordingOperation.Cancel)
	end)
	-- ScriptEditorService source edits are not reliably reverted by a successful
	-- ChangeHistory cancellation. Always replay the typed inverse journal; every
	-- allowed inverse is idempotent if cancellation already restored the object.
	local inverseOk, inverseError = pcall(function()
		for index = #active.inverse, 1, -1 do active.inverse[index]() end
	end)
	if not inverseOk then return false, (cancelled and "change history cancelled; " or "change history cancellation failed; ") .. "inverse journal failed: " .. tostring(inverseError), active.beforeRevision end
	return true, cancelled and "change_history_cancelled_and_inverse_applied" or "inverse_journal_applied", active.beforeRevision
end

return TransactionManager
