# Last Light local Blender proof — September 6–7, 2026

This record preserves local compiler evidence. It does not assert creator approval,
Roblox upload or ownership, native import, Studio persistence, Play behavior, or
subjective visual acceptance.

## Current ABI 2 qualification — September 7

The current native compiler completed a full Last Light predecessor build inside the
qualified Seatbelt profile with Cycles CPU, four worker threads, 64 samples, fixed
color management, and the fixed Forge worker and `.blend` inspector. Forge inspected
all GLB buffers, accessors, hierarchy, transforms, actual vertices, normals and UVs,
materials, extension payloads, names, bounds, and aggregate budgets before sealing.
It then reopened the retained `.blend` through the fixed inspector. The review packet
is materialized at
`.forge/last-light/qualification-abi2-attempt-12/review`.

| Identity                          | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| Installation qualification        | `08409634ba8cee7ddc424633ed1ff23429ff2cc03c17a881c943b35ddb5162c8` |
| Fixed Forge worker                | `ef9ab25d07e6fcafdbda75a3a4a9b989dcf6aa9a99051bbe1e11f0366b1026ec` |
| Fixed `.blend` inspector          | `44a7de2c35e9dde1c2f106cade73eeaaae95247b8cd58591786771619dc66d64` |
| Operation and host-validation set | `9565ec12f9165ab41bb8b72c5ff16b1bc7b43dc39ef57d76ae5da16505739af9` |
| Export/render profile             | `d1aa3a1cdc173bf84c94eb7fcd9e274a9cfda6622548b43f332fb2028a8652bf` |
| Scene revision 14                 | `f29ea71de5187c5124bdde75dbc0a07d225060f996b820050dcbb4718e1c908b` |
| Manifest identity                 | `d6dc495e6735b433e954f4020a975f26e8edfe16afd5024651de785d9d755f4e` |
| Manifest artifact bytes           | `d4f6aedcdde41175537244080b850d58f2889d7703c500a5e90c8cd90019632f` |
| Compiler invocation               | `bb6b26d972158c8ea68afdd0e46b10bcc6c5cc48c12fefef8404f3a74aeb6922` |
| Retained `.blend`                 | `4296e25c7bf569b387f0f98375fb4cd6fe3567ce348733554c999de134230a6f` |

The bundle contains 12 independently replaceable GLBs, explicit native semantics,
three reports, and four 1280×720 renders. Their render hashes are opening
`c4cf93a52f5ded24e66fedea078f7a849ab25f1a3025d03f799e5408da1db8e0`,
reactor restored
`5e03061b40401b46ca117d58b6da340480ab553748ad7ba79e43d3494bdb5762`,
reactor/shuttle approach
`3c6a18f0a9adaf3b6e7c79e7d197c1fcdf4231f8949b1e265f8bf0ad53d4e1e9`,
and warning interaction
`a80f3da7e71d3b0763074ec3dbc662de5b9581686a752b2d2b5a65492e3c8246`.

Four early isolation attempts exited before compilation because the first Seatbelt
policy omitted dynamic-loader, root metadata, or IOKit reads required by Blender's
headless Metal initialization. macOS surfaced those worker failures as Blender crash
dialogs. Forge added only the required qualified reads; there is no unrestricted
fallback. The final qualification and full compile completed without a crash.

The sections below preserve the earlier compiler identity and targeted repair exactly
as historical evidence. Those hashes are not current approvals and cannot enter the
ABI 2 workflow.

## Qualified compiler

The repository-root `blender-5.2.1-macos-arm64.dmg` was mounted read-only at
`/Volumes/Blender`; Blender was not installed. The distribution SHA-256 matches the
official Blender 5.2.1 macOS arm64 checksum. `codesign --verify --deep --strict`
passed, and Gatekeeper reported a notarized Developer ID signed by Blender
Foundation. The executable reported Blender 5.2.1 LTS, build hash `9e2066aef7ef`.

| Identity               | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| Blender DMG            | `6409e21de80994db5f4c4a34486b6fd43cea21085b912f7491c53e923acb65a3` |
| Blender executable     | `ea651e507c6b197df0e234bfa04e5ed43e7f4d498267a7df93fcb38f21928a5c` |
| Fixed Forge worker     | `29a62a6ba8a49ae76727a12b6452770690e497471f8a6a72efdc52bb69fe2ce5` |
| Operation set          | `38a59e61a4089198ffa8cc41701793098abe83d31a5f0492746d6a052392a47e` |
| Export/render profile  | `14682b3cbb373291991646fc3d8669e74fbbda09fd0e733df8ce45a0960bc410` |
| Installation inventory | `27677003c41f44e78325960789a883f804671db9cb392e3911dc6178f33bf454` |

## Revision 14 bundle

The deterministic solver admitted 28 fixed objects after 28 candidates and zero
backtracks. Independent output inspection parsed GLB buffers, accessors, hierarchy,
materials, transforms, vertices, bounds, inventory, and budgets before the bundle
was sealed.

| Identity            | Value                                                                           |
| ------------------- | ------------------------------------------------------------------------------- |
| Scene               | revision 14, `dc79e0cd6f51d1f9833111eae4e43c5919f74082aa8c4451ebb50f9a6baada9e` |
| Bundle manifest     | `075422007e3c99a88226f2b1651683ff470ae198a66c831d47be384277d90b52`              |
| Manifest artifact   | `1ae4fa37f7cde2311aa675f820d2644faf0732b6fa6871b70c7a04833a8b2c06`              |
| Compiler invocation | `a3879599d94efff9eb2a49033785973bb264b222c165b4cbb39ffcbb7f1d9df3`              |
| Retained `.blend`   | `9a2bb3be84b3b853103b169e31701eb5e39c1fd3878cb8a4aee6163d77925e64`              |

The review packet is materialized at
`.forge/last-light/review/revision-14`. Its visual outputs are:

| Output                                 | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `glb/interactive-visual.glb`           | `185efc5d17929093c707a02c6f6bed7f873684e81fe7bd4393cf02fff366fd72` |
| `glb/static-core.glb`                  | `1fb6b285c0424931cd5d55cda196952199d268bad7a2c97589afd36393ecb6e0` |
| `glb/static-east.glb`                  | `e6865caf2566b683cb2fba82d0b5f6f688d8cded0c658e19021d5ffaf1fa9839` |
| `glb/static-north.glb`                 | `04bc38faf1ac736dba61b1ce35b1bc7f2b699bacea354506d5c0e7ac6ccb7f52` |
| `glb/static-south.glb`                 | `031a4c0abc32a1e573a8edd74ed2da07c1ce477b6949b65c09635a4d4bbc1d9f` |
| `glb/static-west.glb`                  | `47f5acb7ead001a61404108c0a44e252f90675ebaa1e8555f44898a6eea4dd7b` |
| `renders/opening-view.png`             | `cd2bf406c8cb1a87dc76b265e0e12fba34534fa45f6f15c13f799807e71def93` |
| `renders/reactor-shuttle-approach.png` | `548af7ae05c9dff94b433b1256278c2444377735d3a3067147f651ff558fb01e` |
| `renders/reactor-restored.png`         | `cb78c2cd41114e783940736f848d619818122d23d436928992efc0d931caa9c5` |
| `renders/warning-interaction.png`      | `2dba28346754462fc1ce9fe0198f0e6972ae9fcba4dba5b7dd8942055341c12a` |

## Targeted repair evidence

Repair plan `4c68b536996606634a5317d97d5634f6f98f6fe8c4980b28a920f18d0003e6a9`
binds revision 13 scene
`5f10fe24bb11187c43d604c80c6e3d3e90339a863eabc74a4644f56225a5f9c0`
to revision 14. The sole direct change is `warning-interaction`, with
`frame-warning-interaction` as its neighboring interface. The compiler generated
the new warning render, `.blend`, and revision reports. It omitted all GLB exports
and the other three renders, loaded their exact revision 13 bytes from immutable
storage, and revalidated them against revision 14 before sealing the manifest.

The proposal artifact is
`97f6c034f03cb3c3252d9f8967c1efe297365c8ef304d68742eaf428712a1656`;
the plan artifact is
`89789eac458aa9abe50236ee55e3ce4963b01c7391233b8602740a07da696937`.
No `SceneBundleReview`, upload authorization, asset receipt, or Studio evidence was
created.
