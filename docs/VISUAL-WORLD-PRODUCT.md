# Forge Visual World Compiler — Product Blueprint

This is the target product experience for Forge visual-world creation. It is a
forward-looking product document, not a claim that every capability exists today.
[Visual generation](VISUALS.md) owns the authoring and asset contracts;
[Architecture](ARCHITECTURE.md) remains the source of truth for implemented behavior.

## The product to build

Forge should let a creator turn a game idea into a visually coherent, playable
Roblox world without reducing world building to an unreliable wall of prompted
coordinates.

The creator describes a game, its intended feeling, and optionally provides
reference images. Forge proposes a small, understandable world: its player route,
landmarks, visual hierarchy, interactions, and review views. Once the creator
approves it, Forge compiles the visual world through a fixed Blender pipeline,
binds it to Roblox-native gameplay, and uses creator-run play evidence to make
targeted repairs.

The outcome is not merely a rendered scene. It is an editable Roblox game where
visual geometry, collision, interaction, UI, networking, and runtime state have
separate responsibilities and can be changed without destroying each other.

## Creator experience

### 1. Describe the game

The creator begins with ordinary language, references, and constraints:

> Build a lonely storm-battered relay station. The player crosses a cargo yard,
> restores a central reactor, and escapes. The reactor must be visible from the
> opening view. Use deep structural blues, emergency amber, and cyan energy.

Forge turns this into a concise proposal rather than exposing internal schemas.
The proposal explains:

- the player’s immediate goal and complete loop;
- the world’s zones, route, and major landmark;
- the visual language and material/lighting hierarchy;
- the interactions and feedback that will make the game feel alive; and
- the named viewpoints used to review the result.

The creator can accept, revise, or reject that proposal before any visual world is
compiled or imported.

### 2. Review a world, not a pile of objects

After approval, Forge presents a scene-bundle review with a few useful questions:

- Does the opening view establish where to go?
- Is the primary landmark visible at the moments it matters?
- Does the route have enough visual variation without becoming cluttered?
- Do materials, light, atmosphere, and effects support the intended feeling?
- Can a player read the objective and interact with the world at normal play speed?

The creator reviews named views, artifact provenance, known limits, and any pending
asset/moderation state. They do not have to inspect raw Blender files, hashes, or
collision manifests unless they open Details.

### 3. Bring the approved world into Studio

Forge prepares an exact reviewed scene bundle. The creator explicitly initiates
the Studio import and retains authority over their Roblox assets and place.

The fixed Forge plugin imports only approved, owned content, reconciles every
expected object, creates native gameplay/collision bindings, and returns concrete
readback. A pending moderation result, missing ownership, changed hierarchy, bad
scale, or ambiguous mapping is shown as an incomplete import—not disguised as a
successful build.

### 4. Make it playable

Forge builds the gameplay around explicit semantic anchors: spawns, routes,
objectives, hazards, interactions, doors, pickups, UI, and effects. The world mesh
does not secretly define gameplay behavior. Ordinary reviewed Luau implements
runtime mechanics; fixed Studio operations install the approved source and data.

### 5. Play, observe, and repair

The creator runs Play in Studio. Forge listens for the evidence the plugin can
authoritatively observe and asks focused follow-ups when subjective judgment is
needed. A repair changes a specific scene partition, material role, anchor,
collision proxy, UI component, or source package. It does not regenerate the
entire game because one lamp, route, or interaction was wrong.

## What the finished system produces

Each visual-world build yields a durable scene bundle:

```text
Visual request + references
  -> semantic scene graph and visual plan
  -> approved BlenderSceneSpec
  -> retained Blender source and reviewed exports
  -> approved Roblox-native scene assembly
  -> gameplay source and interaction bindings
  -> Studio readback, save/reopen, Play, and visual-review evidence
```

The bundle contains:

- a retained `.blend` source file;
- partitioned GLB scene assets;
- an exact manifest with stable scene identities and hashes;
- source and license provenance for every supplied asset;
- visual review renders and named camera definitions;
- collision proxies, routes, sockets, and gameplay-anchor declarations;
- imported Studio object mappings and post-import readback; and
- the evidence needed to reproduce, inspect, repair, or reject the result.

## Visual-world architecture

The final product has four layers with clear ownership.

| Layer                | Forge owns                                                                                                           | It must not own                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Scene intent         | Zones, landmarks, routes, visual hierarchy, constraints, review views                                                | Arbitrary object-by-object geometry decisions from prose          |
| Visual compilation   | A strict `BlenderSceneSpec`, fixed Blender compiler, source artifacts, GLB exports, material and geometry validation | Model-authored Python, add-ons, shaders, file paths, or callbacks |
| Roblox assembly      | Approved asset identity, imported-object reconciliation, native collision, anchors, effects, interaction wrappers    | Unreviewed asset uploads or arbitrary Studio writes               |
| Runtime and evidence | Reviewed Luau, player interaction, authoritative Studio readback, play observations, targeted repairs                | Claims of visual quality or gameplay that lack evidence           |

## Scene composition model

The model chooses intent. Forge solves placement. Blender materializes visual
geometry. Roblox renders and runs the game.

The composition model contains:

- **Zones:** coherent areas with a purpose, density, style, and local frame.
- **Landmarks:** dominant visual objects that orient the player and structure views.
- **Routes:** playable paths with clearance, pacing, sightline, and connection rules.
- **Assets and motifs:** reusable, licensed visual modules or fixed parametric recipes.
- **Objects and instances:** stable logical identities, measured bounds, pivots,
  transforms, material roles, and controlled variation.
- **Sockets:** explicit connection points for props, cables, doors, lights, and
  interaction components.
- **Gameplay anchors:** spawns, objectives, hazards, triggers, and route points
  declared independently from render geometry.
- **Review views:** fixed cameras that make visual evaluation repeatable.
- **Constraints and budgets:** collision, containment, spacing, reachability,
  framing, triangle/texture/material budgets, and device-performance policy.

## How worlds stay editable

Forge never exports an entire world as one giant opaque mesh. It partitions each
world into independently addressable parts:

| Partition          | Product role                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `WorldStatic`      | Architecture, terrain dressing, distant scenery, and visual clusters.                            |
| `WorldCollision`   | Simplified native collision shapes that preserve movement and performance.                       |
| `GameplayAnchors`  | Explicit spawn, objective, hazard, route, trigger, and socket bindings.                          |
| `InteractiveProps` | Doors, pickups, consoles, containers, and machinery that can be repaired alone.                  |
| `Effects`          | Lights, particles, fog, sound, and camera positions controlled through bounded native templates. |

This enables a repair such as “make the reactor visible sooner” to adjust a
landmark, route sightline, and lights without reauthoring the cargo yard or
rewriting gameplay source.

## Visual quality bar

A good Forge world is not one with the most meshes, lights, particles, or visual
noise. It has:

- a readable first view and a memorable landmark;
- a clear hierarchy of shape, light, color, and density;
- variation along the player route;
- controlled negative space rather than indiscriminate dressing;
- materials and atmosphere that reinforce the game’s mood;
- responsive feedback when the player changes the world; and
- acceptable readability and performance at the named device settings.

Reference images and vision-capable models can guide taste and identify a weak
frame, but they are not authority for world identity or native mutation. Creator
judgment remains explicit for visual appeal and emotional impact.

## Cube and CubePart

Cube and CubePart are optional inputs for individual hero props or small modular
sets after rights, quality, and native-import requirements are established. They
are not the visual-world generator. A world should remain coherent if no generated
mesh is available.

Every generated asset remains traceable from its request through exact source bytes,
geometry review, fit, creator decision, import, and native mapping. If a source,
license, moderation result, or mapping is missing, the asset remains incomplete.

## What Forge must prove before it claims success

Forge must be able to show, separately:

1. The creator approved the exact visual plan and scene bundle.
2. Each asset has rights/provenance and an exact imported identity.
3. Studio imported the expected hierarchy at the expected scale and transform.
4. Collision, routes, anchors, and interactions map to the intended scene objects.
5. The saved place reopens with the expected state.
6. The creator ran Play and observed the claimed loop, including success, failure,
   and replay where those apply.
7. Named review views satisfy the creator’s visual judgment without hiding known
   limitations.

Local compilation and a Blender render are useful evidence. They are not proof of
a playable or visually successful Roblox game.

## First product proof

The first proof should be a small visually rich game, not a generic world editor.
It should demonstrate one coherent environment, a clear route, an interaction
loop, responsive UI, a meaningful visual state change, and a targeted repair after
play evidence.

The proof is complete when a creator can explain, in one sentence, why Forge made
the game better than a code-only agent:

> It planned the world as a game, compiled the visual scene without giving the
> model unchecked Studio access, and kept every visual and gameplay change
> reviewable and repairable.

## Non-goals

The product does not promise:

- a zero-shot finished game from an unconstrained sentence;
- arbitrary Blender automation or model-authored scripts;
- a universal fixed genre, kit catalog, or mechanic vocabulary;
- automatic proof that a scene is artistically good;
- hidden uploads, moderation bypasses, or unchecked Studio mutation;
- whole-world Cube generation; or
- NeRF, Gaussian-splat, or other view-synthesis representations as playable-world
  authority.

## Delivery sequence

The final system should arrive in this order:

1. Strict scene specification, fixed Blender compiler, retained artifacts, and
   offline validation.
2. Approved GLB upload/import bridge, imported-object reconciliation, native
   collision/anchor/effect assembly, and save/reopen evidence.
3. Named native visual reviews, device/performance checks, partition-level repair,
   and one complete Forge-generated game world.
4. Optional visual critics, richer fixed procedural recipes, and qualified
   Cube/CubePart assets only after the core evidence loop is working.
