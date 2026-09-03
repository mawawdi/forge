--!strict
-- Converts one potentially-large logical Studio evidence message into a
-- deterministic ordered transfer. Transport hashes bind exact UTF-8 bytes;
-- semantic validation remains exclusively on the host after reassembly.
local Constants = if script ~= nil then require(script.Parent.Constants) else require("./Constants")
local Hash = if script ~= nil then require(script.Parent.Hash) else require("./Hash")
local Canonical = if script ~= nil then require(script.Parent.StudioProjectIndexCanonical) else require("./StudioProjectIndexCanonical")
local Utf8Transport = if script ~= nil then require(script.Parent.Utf8Transport) else require("./Utf8Transport")

local StudioSemanticTransport = {}

local STREAMED_TYPES = {
	StudioEvidenceProduced = true,
	CreatorChangePreflighted = true,
	CreatorMutationProvisional = true,
}

function StudioSemanticTransport.isStreamedType(kind: string): boolean
	return STREAMED_TYPES[kind] == true
end

function StudioSemanticTransport.frames(message: any, cooperate: (() -> ())?): {any}
	if typeof(message) ~= "table"
		or message.kind ~= "StudioProtocolMessage"
		or message.direction ~= "plugin_to_backend"
		or typeof(message.type) ~= "string"
		or not StudioSemanticTransport.isStreamedType(message.type)
		or typeof(message.messageId) ~= "string"
		or message.messageId == ""
	then
		error("semantic transport received an unsupported logical message")
	end
	local encoded = Canonical.transportJson(message, cooperate)
	if #encoded < 1 or #encoded > Constants.MAX_STUDIO_SEMANTIC_DOCUMENT_BYTES then
		error("semantic transport document exceeds its aggregate byte bound")
	end
	local documentHash = Hash.sha256(encoded)
	local transferId = "studio_semantic_transfer_" .. string.sub(documentHash, 1, 24)
	local ends = Utf8Transport.boundaries(encoded, Constants.STUDIO_SEMANTIC_TRANSPORT_CHUNK_BYTES, cooperate)
	if #ends < 1 or #ends > Constants.MAX_STUDIO_SEMANTIC_PIECES then
		error("semantic transport fragment count exceeds its protocol bound")
	end
	local boundary: any = {
		transferId = transferId,
		documentHash = documentHash,
		utf8Bytes = #encoded,
		pieceCount = #ends,
		semanticType = message.type,
		semanticMessageId = message.messageId,
	}
	if message.requestId ~= nil then boundary.semanticRequestId = message.requestId end
	local frames = {
		{
			type = "StudioSemanticMessageStarted",
			messageId = "semantic_start_" .. string.sub(documentHash, 1, 32),
			requestId = message.requestId,
			payload = boundary,
		},
	}
	local startByte = 0
	for index, endByte in ipairs(ends) do
		local sequence = index - 1
		local fragment = string.sub(encoded, startByte + 1, endByte)
		table.insert(frames, {
			type = "StudioSemanticMessageChunk",
			messageId = "semantic_chunk_" .. string.sub(documentHash, 1, 24) .. "_" .. tostring(sequence),
			requestId = message.requestId,
			payload = {
				transferId = transferId,
				documentHash = documentHash,
				sequence = sequence,
				encoding = "json",
				payload = fragment,
				payloadHash = Hash.sha256(fragment),
			},
		})
		startByte = endByte
		if cooperate then cooperate() end
	end
	table.insert(frames, {
		type = "StudioSemanticMessageCompleted",
		messageId = "semantic_complete_" .. string.sub(documentHash, 1, 32),
		requestId = message.requestId,
		payload = boundary,
	})
	return frames
end

function StudioSemanticTransport.deliver(frames: {any}, sender: (any) -> (boolean, any?, number?)): (boolean, any?, number?)
	if typeof(frames) ~= "table" or typeof(sender) ~= "function" then
		error("semantic transport delivery requires frames and a sender")
	end
	for _, frame in ipairs(frames) do
		local sent, failure, status = sender(frame)
		if not sent then return false, failure, status end
	end
	return true, nil, nil
end

return StudioSemanticTransport
