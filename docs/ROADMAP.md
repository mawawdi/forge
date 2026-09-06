# Forge Roadmap

This document lists only future work and its acceptance boundary.
[Architecture](ARCHITECTURE.md) describes what exists,
[Visual generation](VISUALS.md) owns the Blender/Cube/visual design, and
[Research](RESEARCH.md) preserves historical runs.

## 1. Complete the creator-facing visual workflow

Strict ABI 2 scene admission, deterministic solving, the qualified native Blender
worker, immutable artifacts, GLB inspection, workflow journal, OAuth/API-key/manual
asset transports, detached inspection protocol, native operations, persistence
ingestion, and selective repair contracts are implemented and locally tested. Draft,
read, revise, solve, and propose actions use the ordinary coordinator; the CLI and
authenticated API share those action identities, and the dashboard shows current
workflow cards. The current native qualification bundle is scene
`f29ea71de5187c5124bdde75dbc0a07d225060f996b820050dcbb4718e1c908b`
under manifest
`d6dc495e6735b433e954f4020a975f26e8edfe16afd5024651de785d9d755f4e`.

Finish the creator controls after proposal publication. Acceptance, compilation
progress, exact bundle review, account/target selection, upload authorization,
moderation, detached inspection, native-plan review, and repair review must each
materialize from the current immutable artifact and action instance. They must call
the existing durable services rather than accept caller-supplied status or hashes.
Restart and compaction tests must cover each integrated boundary.

Qualify the Keychain helper, OAuth PKCE callback, token rotation/revocation, exact
asset-version delivery, API-key scopes, group permissions, and upload polling against
a creator-registered Roblox OAuth application and creator-owned test universe. An
unsupported or unverified platform capability remains `incomplete`.

## 2. Produce native visual-world evidence

Run the generated native conformance packet in Studio before enabling a product
import. It must cover an asymmetric pivot, off-origin chunk, hierarchy and package
envelope, PBR conversion, changed latest version, rejection, detached cleanup, and
zero writes on failure. Then start a fresh ordinary creator conversation from the
empty Last Light seed. Review and authorize its newly generated bundle, inspect and
apply it in Studio, save and fully close/reopen the place, and retain ten Play cycles.
Keep ownership, moderation, dependency, asset-version/content, mutation,
persistence, performance, input-device, gameplay, and subjective visual evidence
separate. Complete one evidence-driven selective repair through the same workflow.
Until those creator-owned artifacts exist, Last Light remains incomplete; the
prepared revision 14 scene remains disclosed predecessor material.

## 3. Validate continuity and recovery

Exercise reopen, rename, saved copy, explicit fork, publication continuity,
connector replacement, delayed acknowledgement, Apply-time edits, interrupted
provider responses, malformed tool arguments, unknown worker jobs, and
multiple automatic conversation compactions.

Completion requires usable continuation without duplicate outcomes, invented
approval, lost source authority, hidden automatic retries, or repeated
completed work. Every recovery option must derive from exact current evidence and
retain the original failure classification.

## 4. Measure and reduce generation latency

Collect repeated like-for-like runs with identical prompt, seed, model, reasoning,
compiler, and response deadline. Separate creator review, provider turns, local
tools, external compilation/review, source analysis, Studio transport, Apply, and
publication. Record request sizes, request count, tokens, reported reasoning and
cache use, cost, resource measurements, and preserved run identities.

Prioritize redundant context, unnecessary model turns, repeated reads, oversized
schemas, and full-component restatement. Accept an optimization only when exact
authority, output quality, source quality, recovery, and transaction evidence remain
intact. Report distributions; do not present an interrupted or failed pilot as a
speed win.

## 5. Broaden capabilities deliberately

Add Studio classes, properties, source tools, compiler operations, and artifact
formats only when validation, writing, reading, canonicalization,
preflight, comparison, replay, and rights/provenance agree. Catalog coverage is not
write permission. Curated libraries, automatic Rojo ownership discovery, cloud
identity, shared projects, and multi-user collaboration remain later product work.

## Definition of done

No roadmap item is complete until its implementation is reflected in
[Architecture](ARCHITECTURE.md), its claims satisfy [Evaluation policy](EVALS.md),
automated gates pass, the final connector is installed with `npm run plugin:build`,
and required Studio evidence has been produced by the user. Offline fixtures,
declarations, previews, or model prose never substitute for that native evidence.
