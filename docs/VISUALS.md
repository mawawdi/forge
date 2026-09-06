# Forge Visual Generation

This document owns Forge's visual-world direction, visual authoring contracts,
Cube/CubePart research path, and visual evidence boundary. It separates implemented
compiler behavior from future creator and platform qualification work.
[Architecture](ARCHITECTURE.md) remains authoritative for the
running system, [Roadmap](ROADMAP.md) sequences future work, and
[Research](RESEARCH.md) preserves exact historical runs.

## Blender-backed scene compilation

Forge's implemented contract generates Roblox worlds through a fixed Blender
compiler once its pinned installation is available. It does not treat one opaque
scene mesh as a game. The output is a reviewed scene bundle in which Blender supplies visual massing and Forge keeps
gameplay structure, stable identities, repairability, bounded authority, and
evidence.

```text
Creator request and reference images
  -> strict spatial design
  -> admitted BlenderSceneSpec
  -> fixed Forge-owned Blender compiler
  -> retained .blend source + partitioned .glb exports + manifest
  -> local review and exact artifact approval
  -> bounded native Studio import
  -> readback, collision/route checks, save/reopen, and creator review
```

Roblox documents Blender-authored `.glb/.gltf`, `.fbx`, and `.obj` import, including
multi-object scenes, transforms, hierarchy information, and supported material or
texture data. Those platform features do not by themselves prove that Forge may
invoke an importer, upload an asset, load it in a target universe, or preserve it
across save/reopen. See [Roblox's Blender workflow](https://create.roblox.com/docs/art/blender)
and [DCC import overview](https://create.roblox.com/docs/art/overview-dcc).

The repository now implements strict `BlenderSceneSpec ABI 2`, the deterministic
solver, a fixed Blender worker interface, immutable binary artifacts, GLB inspection,
review and upload authority artifacts, a closed native import operation, and targeted
repair planning. The checksum-matched, signed, and notarized Blender 5.2.1 macOS
arm64 DMG was qualified from a read-only mount on September 7, 2026. It produced the
locally eligible predecessor Last Light revision 14 `.blend`, 12 partitioned GLBs, reports, and named
review renders. An absent or unqualified executable still fails closed as
`incomplete / missing_blender`; the local result supplies no creator approval or
Studio evidence.

### Authority boundary

The model may author only declarative `BlenderSceneDeclaration` data and bounded
generic Blender operation requests. It cannot author revision or project bindings,
compiler hashes, source/license authority, provenance, budgets, or output inventory.
The host binds those fields before solving, and Forge-owned Python interprets the
resulting `BlenderSceneSpec` through a closed, general Blender operation protocol.
Never execute model-authored `bpy`, arbitrary
expressions, callbacks, scripts, paths, URLs, or Blender add-ons.

Forge has no recipe catalog, themed generator IDs, curated visual kits, or
model-facing implementation templates. A recipe is a hidden claim that Forge knows
the content structure before the creator does. It narrows creative expression and
forces the model to fit a world into a host-defined vocabulary. The compiler instead
accepts a general scene graph: objects, collections, geometry, transforms,
materials, lights, curves, instances, constraints, and semantic anchors. Fixed
operations enforce authority and safety; they do not prescribe what a world is.

The specification binds:

- zones, footprints, vertical layers, landmarks, routes, and review cameras;
- resolved asset references, scene nodes, sockets, and repetition rules;
- material roles, palette, lighting intent, and effect anchors;
- walkable regions, collision proxies, hazards, objectives, spawns, and interaction
  anchors;
- stable IDs, pivots, bounds, triangle/texture budgets, and export partitions; and
- compiler/runtime identity plus the hashes of source `.blend`, exported GLBs,
  textures, and the manifest.

Blender owns architecture, terrain dressing, hero props, lighting references,
materials, and composition. Roblox-native instances and ordinary Luau still own
interaction, networking, UI, collision behavior, gameplay state, and runtime
effects. A visual mesh must never become hidden authority for an objective or
trigger location.

### Export partitions

| Partition          | Content and reason                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `WorldStatic`      | Visual architecture and distant scenery that can be reviewed and updated in bounded groups         |
| `WorldCollision`   | Low-complexity collision proxies kept distinct from render geometry                                |
| `GameplayAnchors`  | Spawn, objective, hazard, socket, trigger, and route markers compiled into explicit Forge bindings |
| `InteractiveProps` | Doors, pickups, consoles, containers, and other independently addressable objects                  |
| `Effects`          | Light, particle, fog, sound, and camera/reference positions; not runtime behavior                  |

Every exported object maps back to one admitted stable ID and role. A repair should
replace only affected partitions and recheck their neighboring interfaces, rather
than regenerate an unrelated world.

## Deterministic spatial solver

The model chooses spatial intent; Forge solves and validates placement.
A model directly assigning hundreds of Roblox positions from prose is expensive,
brittle, and hard to repair. The fixed pipeline uses five passes:

1. **Design:** establish zones, landmarks, player route, visual hierarchy, style,
   constraints, and named review views.
2. **Layout:** solve zone placement, footprints, connectors, containment,
   reachability, clearance, and camera framing.
3. **Population:** place bounded repeated props through declared instances,
   controlled variation, sockets, and measured asset bounds; never through named
   thematic templates.
4. **Presentation:** compile materials, lighting, atmosphere, effects, UI language,
   and low-graphics fallbacks.
5. **Review:** render fixed named views and check overlap, dead space, landmark
   visibility, route reachability, scale, contrast, readability, and budgets.

This follows the useful separation in semantic scene graphs, layout-first systems,
coarse-to-fine review, shape grammars, and spatial dataflow. Relevant references
include [Layout2Scene](https://arxiv.org/abs/2501.02519),
[SpatialGen](https://arxiv.org/abs/2509.14981),
[SceneTesis](https://research.nvidia.com/labs/dir/scenethesis/), and
[Unreal's PCG framework](https://dev.epicgames.com/documentation/unreal-engine/procedural-content-generation-framework-in-unreal-engine?lang=en-US).
Roblox [ProceduralModel](https://github.com/Roblox/creator-docs/blob/main/content/en-us/parts/procedural-models.md)
and [Terrain](https://github.com/Roblox/creator-docs/blob/main/content/en-us/parts/terrain.md)
remain useful native alternatives for editable landmarks and large-scale terrain.

NeRFs, Gaussian splats, and a large text-to-3D model should not become Forge's
playable-world authority. They may provide references or individual assets, but
the admitted scene model must remain editable, deterministic at the compiler
boundary, performant, and understandable to Studio reconciliation.

## Implemented visual-world compiler

The present repository supplies the bounded contracts and compiler/import machinery.
Local tests exercise the deterministic and recorded-fixture paths; Blender execution
and authoritative Studio results remain separate evidence.

| Capability                 | Implemented boundary                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BlenderSceneSpec ABI 2`   | Strict model declaration, host authority envelope, host-bound intent, and resolved worker schemas with stable IDs, geometry, materials, instances, native semantics, constraints, provenance, partitions, and expected outputs |
| Spatial solver             | Stable-ID ordering, 0.25-stud lattice, 15-degree yaw defaults, seeded tie-breaking, bounded backtracking, constraint validation, and float32 revalidation                                                                      |
| `forge-blender-compiler@2` | Blender 5.2.1 macOS arm64, exact signed inventory, fixed worker/inspector, Seatbelt confinement, Cycles CPU with four threads, durable lease, independent output inspection, and retained invocation evidence                  |
| Review/import workflow     | Exact proposal, acceptance, bundle review, upload authority, operation response, receipt, detached inspection, plan bindings, and manual packet schemas                                                                        |
| Native scene import        | Closed per-GLB operation, detached validation, executable rejection, stable descendant identity, render collision disablement, and explicit native semantics                                                                   |
| Targeted repair            | Dependency closure, frozen unaffected placement, single-instance geometry fork, neighboring-interface validation, and unchanged-artifact reuse                                                                                 |
| Direct native/UI graphs    | Object edits, collection instancing/reference remapping, lighting, responsive UI, the fixed UI controller, and common component outputs                                                                                        |
| Visual attachments         | Up to four PNG/JPEG/WebP inputs retained as provider-neutral image parts with project/revision provenance                                                                                                                      |
| Asset registry             | Exact Cube/CubePart job, OBJ inspection, local WebGL review, fit, sockets, review, and composition binding for individual-prop research only                                                                                   |

### Scene composition and compilation

The model declaration, host-bound intent, and resolved worker spec are phases of one
scene system. Retained scene handles resolve only through exact immutable canonical
bytes and explicit host-owned approval authority. `forge visual solve`,
`forge visual blender-qualify`, `forge visual blender-status`, and
`forge visual compile` expose the same admission, qualification, fixed worker, and
artifact paths for local operation.
Geometry admits indexed triangles, mathematical solids, polygon profiles, extrusion,
revolution, lofting, curves, profile sweeps, joins, typed modifiers, transforms,
bounded deformation, approved external GLBs, and explicit/linear/radial/curve/seeded
instances. Every operation declares operands, strict typed parameters, dependency
identity, and expansion bounds. Materials are supported PBR values and admitted
texture handles. No themed generator, arbitrary Blender call, authored Python,
expression, callback, shader program, driver, add-on, or Geometry Nodes graph is an
input surface.

The solver resolves frames and geometry dependencies, conservative local envelopes,
objects and instances, sockets/native semantics, and review framing. It enforces
containment, separation, support, route and vertical clearance, reachability,
sightlines, camera bounds, density, negative space, and budgets. Exhausting a finite
search budget is `incomplete`; proving no assignment within that domain is
`rejected`. Roblox Y-up studs map to Blender `(x, -z, y)`.

The worker retains one `.blend`, spatially chunked static GLBs, separately replaceable
interactive GLBs, explicit native semantics, geometry/material/budget reports, named
PNG views, and an exact manifest. Expected inventory precedes compilation; measured
hashes are sealed afterward. Independent GLB inspection reads actual buffers,
accessors, hierarchy, transforms, vertices, materials, textures, bounds, and names.
Primitive geometry remains internal for native collision proxies, simple gameplay
structures, and debugging; it is not a competing generated-world component.

`scene-lighting` creates at most 128 explicit PointLight, SpotLight, or SurfaceLight
fixtures plus one each of Atmosphere, BloomEffect, and ColorCorrectionEffect. It
does not edit the Lighting service. These limits bound authoring; they do not
predict device performance or prescribe an art style.

### Interface and image feedback

`responsive-ui` materializes built-in font family/weight/style, alignment,
wrapping, line height, tokenized surfaces, `UIStroke`, hover/pressed/focused/disabled
states, focus rings, and optional scrolling. Static validation checks references,
token resolution, represented rectangle containment, declared text contrast, and
direct automatic-size/scale cycles. `Controller.Observe` reports current native
geometry, text bounds, font attributes, scrolling, selection, `GuiState`, and user
preferences. It does not wait for layout or certify font availability, composited
contrast, traversal, or device cost.

Creators attach images and describe the requested change in ordinary language.
Forge retains original pixels, hashes, dimensions, and submission context. A
vision-capable model may interpret visible content and suggest an edit, but inferred
image regions never become Studio identities or proof of capture provenance. Named
views remain explicit plan data; authoritative native capture and comparison require
creator-run Studio evidence.

## Cube and CubePart

Cube remains an optional noncommercial research input for individual assets, not
the primary world generator. The inspected source pin is
`3c6d06ddbef3160a1e1950cb13ab63dd12a61e50`; Cube3D model revision is
`8cab4886803e8210f4282aef212c6b6b92f68d16`; CubePart model revision is
`28431d124e77040fcaf34c0a71623ff61d35a6c0`. The repository license is titled
**CUBE3D RESEARCH-ONLY RAIL-MS LICENSE**. Preserve all code, checkpoint,
configuration, and license identities. Nothing here establishes commercial rights.

Cube3D accepts text plus approximate box conditioning and exports OBJ. Its box is
normalized before inference, so final bytes and a shared fitted transform are the
authority. CubePart consumes an existing mesh and up to eight named parts. Returned
parts must remain in the input coordinate frame; fitting each independently would
destroy the assembly. Missing/nonempty part coverage, seams, overlap, silhouette,
collision, sockets, prompts, and gameplay bindings are separate checks.

The asset registry preserves immutable preparation, dispatch, outcome,
reconciliation, source OBJ, measured regions/topology, fit, creator review, and a
`ReviewedAssetCompositionBinding`. Inspection records original face-based object and
group memberships, bounds, index-edge topology, duplicate/unreferenced geometry,
and concrete warnings. It does not weld seams, detect every self-intersection,
render textures, or score quality.

The self-contained WebGL preview replays exact retained OBJ bytes and one shared
fit. It can orbit, select fixed views, isolate regions, show wireframe, explode
display parts, and overlay bounds or sockets without changing source bytes. A
lossless advisory partitions every source triangle once, with at most 20,000
triangles, 60,000 referenced vertices per chunk, 512 chunks, 500,000 total
triangles, and 64 MiB canonical review data. Previewing is not approval or native
installation.

Every reviewed binding currently says `nativeImport.status: "incomplete"` and
`mayInstantiate: false`. It emits no placeholder mesh or Studio operation. This
clean boundary should be reused by Blender scene bundles rather than bypassed.

### Asset commands

```sh
node bin/forge.js creator asset doctor --installation /absolute/path/cube-remote.json
node bin/forge.js creator asset prepare --request-file /absolute/path/asset-request.json --installation /absolute/path/cube-installation.json --store /absolute/path/creator-assets
node bin/forge.js creator asset run JOB_ID --store /absolute/path/creator-assets
node bin/forge.js creator asset status JOB_ID --store /absolute/path/creator-assets
node bin/forge.js creator asset fetch JOB_ID --store /absolute/path/creator-assets
node bin/forge.js creator asset reconcile JOB_ID --output-sha256 SHA256 --store /absolute/path/creator-assets
node bin/forge.js creator asset preview JOB_ID --output /absolute/path/preview.html --store /absolute/path/creator-assets
node bin/forge.js creator asset review JOB_ID --lock-hash LOCK_SHA256 --store /absolute/path/creator-assets
```

`prepare` verifies exact installation/request pins without inference. `run` is the
only local CLI action that starts the selected worker. `status` replays retained
evidence without network access. `fetch` retrieves an already-submitted remote
job and never resubmits it. `reconcile` admits only an exact retained output hash.
`preview` writes a previously absent local HTML file. `review` is the separate
exact creator decision. There is no automatic retry/relaunch endpoint.

### Optional remote worker

The fixed Modal deployment places Cube3D and CubePart on one A100-80GB worker that
scales to zero. The Mac holds only the authenticated client and operator tools.
The A100 is qualification headroom, not a measured CubePart minimum. No GPU
deployment or successful live generation is established by repository tests.

```sh
python3 -m venv .forge/cube-client-venv
.forge/cube-client-venv/bin/python -m pip install -r workers/cube/requirements-deploy.txt
.forge/cube-client-venv/bin/python -m unittest discover -s workers/cube/tests -v
.forge/cube-client-venv/bin/python -m modal setup
.forge/cube-client-venv/bin/python -m modal secret create forge-cube-http-auth FORGE_CUBE_TOKEN="$FORGE_CUBE_TOKEN"
.forge/cube-client-venv/bin/python workers/cube/deploy.py prepare --manifest-out .forge/cube-installation.json
.forge/cube-client-venv/bin/python workers/cube/deploy.py deploy --installation .forge/cube-installation.json
.forge/cube-client-venv/bin/python workers/cube/deploy.py manifest --installation .forge/cube-installation.json --endpoint https://YOUR-DEPLOYED-API.modal.run --token-environment FORGE_CUBE_TOKEN --output .forge/cube-installation-host.json
```

These commands can create billable resources and require explicit operator
authorization. Every route requires the bearer token named by the host config:

| Route                      | Meaning                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `GET /health`              | Installation identity and supported operations; no GPU allocation or readiness claim |
| `POST /jobs`               | Exact job/input submission with durable identity                                     |
| `GET /jobs/{jobId}`        | Existing status and optional final receipt                                           |
| `GET /jobs/{jobId}/output` | Exact rehashed OBJ bytes for a successful retained result                            |

Atomic submission and execution claims plus permanent volume history prevent
duplicate dispatch after platform redelivery. A lost acknowledgement, missing
receipt, or host timeout does not prove that paid GPU work did not run. Stopping
host polling does not cancel the remote job. Do not purge job history or reuse job
IDs. The fixed subprocess deadline is 30 minutes; the host may time out earlier
and require explicit status recovery.

## Reviewed native import bridge

The implemented bridge accepts only an exact reviewed Blender scene bundle, compiles
one closed import operation per visual GLB, and retains stable source-to-Studio
descendant identities. Eligibility requires:

- exact source/export/compiler hashes and target universe ownership;
- triangle, texture, object, partition, and per-part bounds before import;
- imported hierarchy, transforms, pivots, material slots, and stable IDs;
- collision proxy mapping, route clearance, spawn/objective/interaction anchors;
- direct Studio readback, allowed project delta, save/reopen, and update behavior;
- one named rendered view at stated device/graphics settings; and
- no unreviewed upload, fallback provider, placeholder geometry, or hidden script.

The plugin recognizes one fixed platform Model envelope, strips its package link while
detached, rejects scripts and unexpected classes or descendants, and compares the
exact hierarchy, unique names, content/material identities, transforms, pivots, and
bounds. It disables native collision on imported render geometry. Collision proxies,
anchors, wrappers, and effects are created from approved native declarations. Network
loading and moderation finish before recording; the existing transaction machinery
owns publication, readback, reconciliation, finalization, replay, and recovery.

The current [Open Cloud Assets contract](https://create.roblox.com/docs/cloud/guides/usage-assets)
admits Forge GLBs as `Model`
uploads with `model/gltf-binary`, a 20 MB per-file limit, and the platform package
envelope. Forge dispatches only after exact upload authorization, retains intent before
the credential-bearing transport call, bounds the raw response, and polls the returned
operation identity without automatic resubmission. The manual packet remains available
and binds absolute paths to the same reviewed artifact hashes and exact importer
settings. Creator-reported IDs remain declarations until detached native inspection
proves the asset version and content. A manual import is not an upload receipt.

Generation and review must remain outside an open ChangeHistory recording. Only
the already-reviewed immutable bundle enters the bounded Studio transaction.

## Last Light product proof

The ordinary proof starts from the clean seed under `examples/last-light`; no ordinary
creator AgentRun has generated it yet. The disclosed prepared predecessor under
`examples/last-light/predecessor` uses a 192-by-144-stud footprint and seed 42017 with a central reactor,
three distinct cell bays, a recognizable shuttle, three dangerous conduits, and one
readable player route. The semantic scene solves locally to 28 objects in 28 candidates
with no backtracking and binds current scene hash
`f29ea71de5187c5124bdde75dbc0a07d225060f996b820050dcbb4718e1c908b`
at revision 14.

The qualified Blender compiler creates the station's structural silhouette, contrasting heights,
layered reactor, identifiable shuttle, bay identities, restrained dark material
language, cyan power, amber interaction, red shape-and-motion danger, plausible
fixtures, and concentrated detail around play. Export collision, anchors,
interactables, effects, and static scenery separately. Decorative geometry must
preserve route and interaction clearance.

The local revision 14 predecessor bundle is `eligible` under manifest
`d6dc495e6735b433e954f4020a975f26e8edfe16afd5024651de785d9d755f4e`.
It retains one `.blend`, 12 GLBs, native semantics, three reports, and four named
1280×720 PNG renders. An earlier compiler identity retained repair plan
`4c68b536996606634a5317d97d5634f6f98f6fe8c4980b28a920f18d0003e6a9`
which changed only the warning view: all partition outputs and the other three renders use
the exact revision 13 artifacts and were independently revalidated. This is local
compiler and repair evidence. It is not a `SceneBundleReview` or native result.

Ordinary server-authoritative Luau now owns a three-second countdown, 120-second run,
one carried cell, 100 points per deposit, two integrity, conduit timing of 1.5
seconds warning / 2 seconds active / 4.5 seconds rest, and a hit penalty of one
integrity plus eight seconds. Three deposits unlock a three-second shuttle escape.
Timeout or depleted integrity loses. Character loss, departure, single resolution,
validated client requests, and ten consecutive win/loss/replay cycles without stale
callbacks or duplicate subscriptions are required.

The implemented menu, HUD, and result screens show time, cells, integrity, and score. Start and
Play Again must work with touch and gamepad; primary targets are at least 48 pixels
and remain readable on phone and desktop. Carrying, depositing, warning, impact,
power restoration, and extraction need distinct visible states.

The predecessor direct game design names the first playable view, reactor/shuttle
approach, warning interaction, restored reactor, and phone/desktop UI states. The
prepared scene, exact Blender bundle, design, and Luau sources are locally compiled
or tested, but they are excluded from the ordinary proof context. Completion requires
a fresh creator-authored graph and sources, approval of that exact bundle, successful native import and save/reopen,
collision and anchor checks, a full creator transaction with no unresolved recording,
ordinary Play observations for win/loss/replay, and creator review of the named
rendered views. Static eligibility or a declared camera does not complete the slice.

## Visual claim boundary

Counts, primitive expansion, a clean local gate, an OBJ preview, a vision-model critique,
or a successful import do not establish visual quality. Review the same named views
before and after a change, record viewport/device/graphics settings, and keep frame
time, memory, gameplay behavior, and subjective appearance as separate observations.

Historical Cube, scene/UI, image-input, and Last Light speed evidence is consolidated
in [Research](RESEARCH.md). It remains predecessor evidence for the builds that
produced it; none of those runs proves the Blender pipeline exists or that Last
Light is a completed game.
