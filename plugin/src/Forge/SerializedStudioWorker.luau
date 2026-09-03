--!strict
-- Studio invokes plugin UI, engine-signal, and HTTP callbacks on independent
-- coroutines. Keep expensive Forge work behind one FIFO so callbacks only
-- enqueue intent; exactly one job may touch connector/transaction state at a
-- time. A keyed job is de-duplicated while queued or running, which is
-- essential because the bridge redelivers its command head until settlement.
local SerializedStudioWorker = {}
SerializedStudioWorker.__index = SerializedStudioWorker

function SerializedStudioWorker.new(dependencies: any?)
	local supplied = dependencies or {}
	-- Defer the drain until the originating Studio callback has unwound. The
	-- worker still cooperates within expensive jobs, but no enqueue call may
	-- immediately inherit UI/signal callback execution.
	local spawnJob = supplied.spawn or function(callback: () -> ()) task.defer(callback) end
	local yieldBetween = supplied.yieldBetween or function() task.wait() end
	if typeof(spawnJob) ~= "function" or typeof(yieldBetween) ~= "function" then error("serialized Studio worker dependencies are malformed") end
	return setmetatable({
		spawnJob = spawnJob,
		yieldBetween = yieldBetween,
		onError = supplied.onError,
		queue = {} :: {[number]: any},
		head = 1,
		tail = 0,
		pendingKeys = {} :: {[string]: boolean},
		draining = false,
		closed = false,
	}, SerializedStudioWorker)
end

function SerializedStudioWorker._start(self: any)
	if self.draining or self.closed or self.head > self.tail then return end
	self.draining = true
	self.spawnJob(function()
		while not self.closed and self.head <= self.tail do
			local item = self.queue[self.head]
			self.queue[self.head] = nil
			self.head += 1
			local ok, failure = pcall(item.work)
			self.pendingKeys[item.key] = nil
			if not ok and typeof(self.onError) == "function" then pcall(self.onError, failure, item.key) end
			if not self.closed and self.head <= self.tail then self.yieldBetween() end
		end
		if self.head > self.tail then
			self.head = 1
			self.tail = 0
		end
		self.draining = false
		-- enqueue() can run from another callback while the worker is yielding.
		-- Recheck after dropping the active flag so no accepted job is stranded.
		self:_start()
	end)
end

function SerializedStudioWorker.enqueue(self: any, key: string, work: () -> ()): boolean
	if self.closed then return false end
	if typeof(key) ~= "string" or key == "" or typeof(work) ~= "function" then error("serialized Studio worker job is malformed") end
	if self.pendingKeys[key] then return false end
	self.pendingKeys[key] = true
	self.tail += 1
	self.queue[self.tail] = { key = key, work = work }
	self:_start()
	return true
end

function SerializedStudioWorker.isBusy(self: any): boolean
	return self.draining or self.head <= self.tail
end

function SerializedStudioWorker.close(self: any)
	if self.closed then return end
	self.closed = true
	for index = self.head, self.tail do
		local item = self.queue[index]
		if item then self.pendingKeys[item.key] = nil end
		self.queue[index] = nil
	end
	self.head = 1
	self.tail = 0
end

return SerializedStudioWorker
