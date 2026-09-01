# Studio capability completeness

Date: 2026-09-01

This note records the rationale and official-source pin behind Forge's exhaustive
Roblox capability accounting. It is research context, not schema authority;
current contracts live in `packages/studio-evidence`, and demonstrated status
lives in `docs/ROADMAP.md`.

## Official source pin

Roblox's current [Engine API reference](https://create.roblox.com/docs/reference/engine)
states that it documents the classes, datatypes, enums, functions, events,
callbacks, and properties available to creators. Forge pins the generated YAML
in Roblox's official [creator-docs repository](https://github.com/Roblox/creator-docs)
rather than scraping rendered pages.

The source was freshly resolved on 2026-09-01:

- repository: `https://github.com/Roblox/creator-docs.git`;
- commit: `d025c96bdb1c81570221997092fbe0ad94b5337c`;
- engine reference root: `content/en-us/reference/engine`;
- tagged sorted-path-and-bytes SHA-256:
  `6df2b67ba4e5fdc4d24f245ee159a64a6575d7eea37f0819107141dfc9716d04`;
- 638 class files, 48 datatype files, 518 enum files, 2 global-scope files,
  and 11 standard-library files;
- 2,864 class properties, 1,562 class methods, 393 class events, 13 class
  callbacks, 410 datatype member occurrences, 3,003 enum items, 50 globals,
  and 175 standard-library members.

The checked-in source descriptor, normalized catalog, and content hashes make
this an inspectable input. Ordinary generation and tests are offline. Updating
the pin is an explicit operation that must update the source identity, catalog,
coverage report, manifest, generated dispatch, tests, and documentation
together.

## Implemented identities and coverage

The normalized catalog has content hash
`142406530e50b9c65fee0d7792e48aa22001e8697399820b43382dc5fdfe490e`.
It contains 1,215 class/datatype/enum/library entries and 8,470 member/global
occurrences. The generated coverage report classifies all 9,685 exactly once
and has content hash
`0edebaf18174ae59ef01595340d0c461021084a3cc0b281de61ec23af39cdd5e`.
Its current proof-closed manifest has hash
`6a190dc414c6ed537e462118c46ae3f3e146494c75599f3578ca32a2ff47636f`
and enables 33 classes with 183 distinct writable properties. Inherited
applicability produces 209 authorable coverage rows; it does not create 209
separate manifest grants.

The exhaustive partition is 209 `authorable`, 16 `observable_only`, 7,986
`source_only`, and 1,474 `unsupported`. Source-only rows are nondeprecated and
script-accessible according to the pinned official metadata; creator agents can
query their exact signature, security/capability context, and YAML provenance
for bounded Luau authoring. This does not create a typed Studio writer or an
engine-behavior proof. Unsupported rows are retained and searchable with
specific deprecated, hidden/NotScriptable, or security-gated reasons.
For classes specifically, the partition is 33 proof-closed direct-authoring
classes, 554 current source-API classes, and 51 classes that Roblox marks
deprecated. Abstract classes and service roots are source APIs rather than being
misreported as unsupported merely because Forge cannot create them with a
transactional `Instance.new` operation.

The current policy groups containers, scripts, remotes, value objects, 3D
instances, UI, and effects/audio. It adds bounded compound codecs and stable
Instance references, including an explicit class-bound nil value, while deliberately leaving content-bearing identifiers
disabled. Five fixed runtime capabilities cover resolution, point position,
position series, manifest-property observation, and manifest-property series.
The CLI and dashboard expose the full accountability record without turning it
into an alternate authoring interface.

Capacity is deliberately generic rather than curated per class, fixture, or
mechanic. The tracked policy sets one Studio ceiling for every creator run,
registered evaluation, canary, evidence collection, and fixed runner: 128
operations, 16,384 projected facts, 64 runtime targets, 128 runtime calls,
five minutes, 512 KiB of runtime results, 128 samples per series, 2,048
project-state instances, and 8 MiB of state evidence. The creator product
reserves 90 seconds within that ceiling when human interaction is required.
These bounds contain the trust boundary; they are not a claim-specific
capability allowlist or a fixture-selected budget.

Offline checks recompute the catalog, coverage, manifest, generated
TypeScript/Luau dispatch, and canonical vectors. Refresh is a distinct explicit
networked operation; ordinary generation does not consult the network.

The final closure audit found and removed a namespace collision between official
`Datatype.Font` and `Enum.Font`; neither is authorable until a bounded Font
family policy exists. It also closed the valid nil state for Instance-valued
properties so nil is compared as an observed canonical value, never confused
with absent or unavailable evidence. The connector identity now includes the
generator and TypeScript evidence-contract sources, preventing changed codec
semantics from pairing under an unchanged build hash.

## Four separate questions

An official API entry is not automatically a safe Forge mutation. Capability
completeness separates four authorities:

1. `RobloxApiCatalog` answers what the pinned official source documents.
2. `StudioCapabilityCoverageReport` assigns every catalog entry exactly one
   disposition and an explicit reason.
3. `StudioCapabilityManifest` grants authoring authority only to rows whose
   complete proof algebra exists.
4. A manifest-bound `StudioEvidenceEnvelope` records what the paired engine
   actually observed for one projection.

This distinction is necessary because the official metadata contains
non-creatable classes, services, hidden and deprecated members, read-only and
security-gated properties, unsaved projections, content-bearing values, object
references, and APIs whose behavior depends on runtime or external authority.
For example, attachment properties on constraints are serialized writable
Instance references with graph constraints, while a constraint's `Active`
property is read-only runtime state. Treating both as ordinary JSON properties
would erase important semantics.

Roblox's
[`ReflectionService`](https://create.roblox.com/docs/reference/engine/classes/ReflectionService)
can report classes and inherited members under an explicit security context.
Forge uses that facility to attest that the installed Studio build exposes the
curated name, type, serialization, and permission shape. Reflection remains an
availability check: it neither enables a catalog row nor proves a successful
write.

### Reflection type domains and the consumed rejection

`ReflectionService` exposes more than one type identity for a property. Its
`ReflectionType` has an engine/storage `EngineType` spelling and separate
Luau-facing `ScriptType`, `EnumType`, and `InstanceType` dimensions. These
fields are not interchangeable namespaces. The official catalog is a fifth
source namespace: it may retain numeric storage subtypes such as `float`,
`double`, `int`, and `int64` even though Luau exposes all four as `number`.
Class references, enums, and datatypes likewise use distinct engine and script
spellings.

A live current-build pairing on 2026-09-01 exposed the consequence of treating
those fields as one string. The connector and manifest hashes matched, and the
attestation returned all 183 required reflection facts, but the old plugin-side
grader converted eight readable facts into `unavailable /
reflection_type_mismatch`: `Beam.Attachment0`, `Beam.Attachment1`,
`Trail.Attachment0`, `Trail.Attachment1`, `WeldConstraint.Part0`,
`WeldConstraint.Part1`, `ObjectValue.Value`, and `ImageLabel.SliceCenter`.
The first seven cross a class-reference namespace; `SliceCenter` crosses a
datatype/internal-engine-name boundary. The generic completeness rejection did
not mean those properties were absent or unwritable. No creator session,
provider call, recording, mutation, or Studio verdict occurred.

The first correction moved all grading to the backend and retained the raw
dimensions, but it still collapsed catalog type and script type into one
expected value. A second live pairing on 2026-09-01 used connector build
`cf1f156360fa5d1528c49e35381c51b09c283bcadf92bcab222a73703b41a994`
and manifest
`0ad95481e1de63effc944fa80c7464b82f71a75ae9bc0ffa89c9710ecb29c2b8`.
Studio returned all 183 required facts as `observed`; there were no missing,
unavailable, or read-error facts. The backend nevertheless rejected 69 rows as
`reflection_script_type_mismatch`: 52 catalog `float`, 15 catalog `int`, one
`double`, and one `int64`, all correctly reported by ReflectionService with
`ScriptType = number`. The retained raw envelope is
`e3465e3a2ce81fbf33317af0a30253976ac25b800c581c5dcef79f2eaaab7c73`
and its projection is
`b52eef399c76c7f73e768de9fc9d402f7b7727eabc50d22462842ee1a1709d04`.
No creator session, provider call, recording, mutation, verification, or
gameplay claim occurred.

The final boundary is deliberately general:

1. the official catalog generates each manifest row's catalog type category,
   name, and declaring class;
2. the plugin serializes the raw reflection owner, inheritance, serialization,
   permissions, and every available type dimension without grading them;
3. generation derives an exact reflection expectation for every writable row:
   required `EngineType` and `ScriptType`, plus required `EnumType` or
   `InstanceType` where applicable;
4. one pure backend verifier compares every dimension independently. Numeric
   catalog subtypes retain their exact engine spelling while requiring the
   common Luau spelling `number`; class references require
   `RefType`/`Instance`, enums require `Enum`/`EnumItem`, and datatype aliases
   remain explicit;
5. a missing expected dimension is `incomplete`, while a present contradictory
   dimension is `rejected`; the dashboard exposes the exact bounded findings
   and the raw evidence artifact.

As a provider-free root-cause check, the exact 183 raw facts from the second
pairing were rebound in memory to the corrected generated manifest and
projection. The pure grader returned `verified`, with 183 observed and zero
missing, unavailable, read-error, or mismatched facts. That replay is diagnostic
confirmation of the contract fix; it is not persisted as a new Studio
attestation and does not rewrite the consumed artifact.

Generation carries this obligation for every enabled manifest property, so a
new class, datatype, enum, or primitive capability cannot bypass the same
catalog-to-reflection proof route. Reflection remains a compatibility gate for
the curated manifest, never a capability discovery or expansion mechanism.

## Exhaustive accountability

Completeness means that every catalog type and member occurrence is classified;
it does not mean that every entry is authorable. The allowed dispositions are:

- `authorable`: enabled by the proof-closed manifest;
- `observable_only`: a fixed Forge projection may read it but cannot write it;
- `source_only`: creator code may refer to the API, but Forge has no typed
  mutation or behavioral proof for the member itself;
- `creator_reviewed`: the relevant outcome belongs to creator judgment;
- `unsupported`: excluded with a precise policy, security, codec, placement, or
  authority reason.

Generation must fail if a catalog entry is missing or classified more than
once. It must also fail if an authorable row lacks any leg of:

```text
canonicalize -> validate -> preflight -> write -> read -> project -> compare
```

Inheritance is resolved from the pinned class graph. A property declared by an
ancestor remains one catalog member with explicit inherited applicability; it
is not copied into unrelated hand-maintained tables.

## Values and references

Cross-language codecs represent Roblox's storage domain rather than incidental
JavaScript or JSON formatting. Numeric values use explicit float or integer
normalization, compound datatypes use fixed ordered fields, enums bind their
official enum type and item names, sequences are bounded and sorted, and all
hashes use tagged length-delimited material.

Instance-valued properties require more than a path string. A reference binds
the observed stable ID, canonical path, exact observed class, and expected class
constraint. Preflight resolves the same graph, direct readback returns the same
reference form, and comparison checks identity and class compatibility. Missing
or unresolvable reference evidence is incomplete, never `nil` by implication.

Content-bearing properties remain disabled until Forge has an explicit asset
authority, canonical identifier, permission, moderation, and availability
policy. An official `ContentId` or `Content` type alone is insufficient.

## Runtime evidence

Methods, events, physics, client input, networking, persistence, moderation,
and external services cannot be made universally true by catalog generation.
Forge may add bounded fixed observations such as instance resolution, manifest
property samples, property series, selected event counts, and diagnostics. Each
primitive must have fixed runner implementation, explicit bounds, dependency
ordering, visible charter semantics, and complete evidence presence.

Arbitrary callbacks, generated assertions, generic method invocation, or model
code do not cross the Studio evidence boundary. Unsupported behavior remains a
creator-review prompt or a dedicated future proof primitive.

## Relationship to accepted Door Control evidence

Door Control session
`creator_session_fa375f4e-00ad-481e-af8c-ddd502d6d0a2` established that the
closed manifest, attestation, preflight, provisional apply, direct readback,
state reconciliation, commit, bounded runtime verification, creator report, and
provider-free replay can operate together in the real product flow. Capability
expansion extends that algebra. It does not replace it with reflection-driven
generic writes or reinterpret the creator's report as machine evidence.

The accepted attempt also exposed an evidence-lifetime invariant during this
milestone: replay must validate and recompile against the manifest and build
policy sealed into the attempt, not a later global capability set. The first
expanded build correctly failed old-global comparisons, after which the replay
path was rooted in its immutable manifest artifact. Mutation and verification
then again returned `exact_match` with exit `0`, without rewriting the accepted
store. That local store was later deleted at the creator's explicit direction;
the identifiers here are now documentary rather than retrievable replay input.
Live authoring remains restricted to the current generated manifest.
