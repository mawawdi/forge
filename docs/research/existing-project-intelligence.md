# Existing-project intelligence and refresh

Forge treats the document that is open in Studio as the default source of
project truth. A static place file is an import/export boundary, not evidence
that a filesystem tree remains authoritative after Studio opens it. Roblox's
[place-file documentation](https://create.roblox.com/docs/projects/place-files)
defines `.rbxl` and `.rbxlx` as the local place formats and Studio's Save to
File operation as the export path. Forge therefore commits an accepted
`studio_document` transaction in Studio and tells the creator to use **File →
Save to File** for the resulting `.rbxlx`; it does not invent a host file
receipt.

## Current editor truth

Persisted `Script.Source` is not sufficient while a creator has unsaved editor
text. Roblox exposes the current editor document through
[`ScriptEditorService`](https://create.roblox.com/docs/reference/engine/classes/ScriptEditorService),
including `GetEditorSource`, `UpdateSourceAsync`, and document-change events.
The project index reads the editor document when one is open, falling back to
the persisted source only when no document exists. An approved edit uses
`UpdateSourceAsync`; its callback checks the exact before hash and returns the
patched text. Direct readback uses the same reader. This makes the visible
editor buffer—not an older serialization—the concurrency boundary.

Source analysis is host-side, read-only, and explicitly labelled
`static_analysis`. It validates every body against its evidence hash before
indexing and never executes project code. Only the verified pinned Rojo 7.7.0
and Luau LSP 1.63.0 releases participate. One LSP session is bounded to 30
seconds, each request to five seconds, each message to 1 MiB, symbol collection
to 200 entries, references to 200 per symbol and 1,024 rows overall. Search,
paged reads, symbols, references, and require-graph queries are cursor-bound to
the exact source index root and query hash. Require traversal is static: a
dynamic or unresolved `require` remains unresolved evidence, never a guessed
dependency. A host-derived consultation record binds precisely which source
ranges and dependency closure the planner received. The model can request those
reads but cannot forge the resulting authority.

## Identity without pre-enrolment

An arbitrary place cannot be required to contain Forge metadata. Existing
objects therefore use an opaque pairing-epoch identity derived inside the
plugin from `Instance:GetDebugId`; the raw debug ID is never transported.
Roblox marks
[`GetDebugId`](https://create.roblox.com/docs/reference/engine/classes/Instance#GetDebugId)
as plugin-security data, which is appropriate for an ephemeral connector
handle but not a durable project identifier. A connector epoch change
invalidates those handles and requires a refresh. When an approved transaction
first targets an ephemeral object, Forge enrolls `_forgeStableId` inside the
same visible ChangeHistory recording. Cancellation consequently removes the
metadata with the proposed mutation.

Duplicate names are valid in Roblox. Display paths remain review aids, but
opaque identities—not name lookup—authorize mutation. An opted-in Rojo source
may instead use an exact `rojo_sourcemap` identity.

## Complete project revisions

A single inventory body creates both memory ceilings and ambiguous partial
success. The project index instead emits bounded, content-addressed leaves and
separate source chunks. A revision exists only after Forge validates the root
enumeration, shard order, shard sizes, record order, hashes, source manifests,
and every referenced chunk. The Merkle root binds:

- all indexed structure, class, parent identity, attributes, tags, and covered
  manifest properties;
- the manifest-defined coverage domain, so unsupported properties never become
  implicit preservation facts;
- the current source hash and complete chunk manifest for each script;
- the connector identity epoch and project identity.

Missing, duplicate, reordered, extra, unavailable, truncated, or tampered
material is incomplete evidence and cannot yield a revision. Resource policy
is persisted evidence. Its default caps—1,048,576 instances, 1 GiB canonical
index material, 128 MiB for one source body, and ten minutes—are safety limits,
not claims that a prefix describes the complete project.

## Manual edits and refresh

Project-change events are dirty notifications only. They never claim a new
revision. A hierarchy/property/attribute/editor/undo/redo notification blocks
approval and Apply until an explicit **Refresh project** action obtains another
complete index. An unchanged Merkle root clears the advisory notification. A
changed root produces an immutable delta, terminates the old session as
`superseded`, and creates a successor with the same creator request but no
plan, approval, change set, source consultation, or action authority.

This is intentionally not a merge or silent provider retry. Stale worker output
is retained as evidence but cannot become a candidate. Pre-Apply still performs
an authoritative index comparison; the event monitor is only an earlier and
more usable warning. Activity while a Forge recording might exist enters
recovery instead of refreshing or finalizing automatically.

The detector epoch fences reads, not immutable evidence delivery. Forge takes
one stable cut of the project: if an event arrives while objects are being
read, it restarts the complete collection under the original resource bound.
After that cut is hashed, sending its shards is merely transport. A delayed
Studio callback during transport may revoke the connector's current-action
gate, but it cannot erase the completed capture. The host keeps the callback as
a durable barrier and compares a fresh stable capture with the exact
post-Apply, finalization, or recovery baseline once that baseline exists. This
avoids both failure modes of timing-based invalidation: large indexes no longer
fail because they stream longer, and a notification arriving before the
post-Apply receipt is never misgraded against pre-Apply state.

## Optional Rojo source authority

Rojo is opt-in through one private `ProjectAuthorityManifest`; Forge never
infers it from an opened place. Mappings come only from the pinned `rojo
sourcemap` output and `$path` project configuration described by the
[Rojo project format](https://rojo.space/docs/v7/project-format/). Rojo's own
[sync details](https://rojo.space/docs/v7/sync-details/) explain why filesystem
source does not cover every Roblox property. The first authority adapter is
therefore restricted to mapped existing Luau files and representable new script
files.

A change set has exactly one writer. Studio changes use a ChangeHistory
transaction. Rojo changes use component-by-component symlink checks, exact
hash/absence guards, private temporary files, atomic rename, and immutable
receipts. A later complete Studio index must prove the expected mapped hashes
and allowed delta. Forge starts only the verified pinned Rojo 7.7.0 `sourcemap`
command at service startup to generate that mapping. It never starts `rojo
serve`, guesses that synchronization occurred, or calls a multi-writer operation
atomic. Sync timeout remains `awaiting_source_sync`; reversal is a separate,
creator-authorized, hash-guarded filesystem transaction followed by reverse
Studio proof.

## Claim boundary

The index proves only the facts it completely observed. Static analysis proves
only facts about the analyzed text and toolchain result. A mutation receipt
proves only its writer and postconditions. Runtime evidence and creator review
remain separate authorities. Existing-project intelligence improves context
without collapsing these boundaries.
