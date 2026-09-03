--!strict
return {
	BRIDGE_URL = "http://127.0.0.1:8787",
	-- Every physical HTTP request shares the host's one-MiB wire ceiling.
	-- Potentially larger semantic documents use the ordered stream below.
	MAX_MESSAGE_BYTES = 1024 * 1024,
	MAX_STUDIO_SEMANTIC_DOCUMENT_BYTES = 16 * 1024 * 1024,
	STUDIO_SEMANTIC_TRANSPORT_CHUNK_BYTES = 256 * 1024,
	MAX_STUDIO_SEMANTIC_PIECES = 65,
	PROJECT_INDEX_MAXIMUM_INSTANCES = 1048576,
	PROJECT_INDEX_MAXIMUM_CANONICAL_BYTES = 1073741824,
	PROJECT_INDEX_MAXIMUM_SOURCE_BLOB_BYTES = 134217728,
	PROJECT_INDEX_MAXIMUM_DURATION_MS = 600000,
	PROJECT_INDEX_MAXIMUM_NODES_PER_SHARD = 512,
	PROJECT_INDEX_MAXIMUM_SHARD_BYTES = 4194304,
	PROJECT_INDEX_TRANSPORT_CHUNK_BYTES = 262144,
	-- Prepare fragments pass through two enclosing JSON string values before a
	-- /poll response. 192 KiB remains below the one-MiB host response bound even
	-- when every byte requires escaping at both layers.
	BACKEND_COMMAND_TRANSPORT_CHUNK_BYTES = 192 * 1024,
	MAX_PROJECT_INDEX_PIECES = 4194304,
	-- Every object admitted by the complete project-index policy must also be
	-- observed for external edits. A smaller hidden monitor ceiling would make
	-- a policy-valid project appear indexable while silently losing freshness
	-- detection. Listener allocation failure still produces monitoring_failure
	-- before the connector may publish a usable revision.
	PROJECT_CHANGE_MONITOR_MAXIMUM_INSTANCES = 1048576,
	MAX_DIAGNOSTIC_CHARS = 4 * 1024,
	IDENTITY_ATTRIBUTE = "_forgeStableId",
	PROJECT_IDENTITY_ATTRIBUTE = "_forgeProjectId",
}
