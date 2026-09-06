import { creatorGameCatalog } from "../../packages/creator-session/src/game-authoring.js";
import {
  assertBoundedGameJson,
  DEFAULT_GAME_ADMISSION_POLICY,
} from "../../packages/game-ir/src/primitives.js";
import {
  gameRecipeDefinitionLock,
  type GameDesignSpec,
  type GameSourceFile,
} from "../../packages/game-ir/src/index.js";
import {
  SCENE_PRIMITIVES_DEFINITION,
  RESPONSIVE_UI_DEFINITION,
  type ScenePrimitivesConfig,
  type ResponsiveUiConfig,
} from "../../packages/game-composition/src/index.js";

/** Creator-visible design material only. Every gameplay source remains an approved empty slot. */
export async function createLastLightFixture() {
  const catalog = await creatorGameCatalog();
  const runtime = catalog.definitions.find((definition) => definition.id === "forge-runtime")!;
  const scene: ScenePrimitivesConfig = {
    rootName: "LastLightStation",
    parentPath: "Workspace",
    constraints: [],
    nodes: [
      {
        id: "deck",
        name: "Deck",
        x: 0,
        z: 0,
        size: { x: 192, y: 2, z: 144 },
        color: { r: 28, g: 34, b: 45 },
      },
      {
        id: "reactor",
        name: "Reactor",
        x: 0,
        z: 0,
        size: { x: 12, y: 10, z: 12 },
        color: { r: 40, g: 210, b: 210 },
      },
      {
        id: "cell-a",
        name: "CellBayA",
        x: -56,
        z: -36,
        size: { x: 12, y: 6, z: 12 },
        color: { r: 230, g: 175, b: 70 },
      },
      {
        id: "cell-b",
        name: "CellBayB",
        x: 56,
        z: -36,
        size: { x: 12, y: 6, z: 12 },
        color: { r: 230, g: 175, b: 70 },
      },
      {
        id: "cell-c",
        name: "CellBayC",
        x: -56,
        z: 36,
        size: { x: 12, y: 6, z: 12 },
        color: { r: 230, g: 175, b: 70 },
      },
      {
        id: "shuttle",
        name: "Shuttle",
        x: 56,
        z: 40,
        size: { x: 24, y: 8, z: 18 },
        color: { r: 150, g: 180, b: 220 },
      },
      {
        id: "conduit-a",
        name: "ConduitA",
        x: -28,
        z: -18,
        size: { x: 4, y: 2, z: 18 },
        color: { r: 230, g: 65, b: 70 },
      },
      {
        id: "conduit-b",
        name: "ConduitB",
        x: 28,
        z: -18,
        size: { x: 4, y: 2, z: 18 },
        color: { r: 230, g: 65, b: 70 },
      },
      {
        id: "conduit-c",
        name: "ConduitC",
        x: -28,
        z: 18,
        size: { x: 4, y: 2, z: 18 },
        color: { r: 230, g: 65, b: 70 },
      },
    ].map(({ x, z, ...node }) => ({
      ...node,
      shape: "Block",
      placement: { offset: { x, y: node.id === "deck" ? -1 : node.size.y / 2, z } },
      material: "Metal",
      anchored: true,
      collidable: true,
    })),
  };
  const layout = {
    xScale: 0.5,
    xOffset: 0,
    yScale: 0,
    yOffset: 16,
    widthScale: 1,
    widthOffset: -32,
    heightScale: 0,
    heightOffset: 48,
    anchorX: 0.5,
    anchorY: 0,
    minWidth: 48,
    minHeight: 48,
    maxWidth: 480,
    maxHeight: 48,
  };
  const ui: ResponsiveUiConfig = {
    rootName: "LastLightUI",
    tokens: {
      colors: [
        { id: "ink", value: { r: 18, g: 24, b: 36 } },
        { id: "paper", value: { r: 245, g: 248, b: 255 } },
      ],
      sizes: [
        { id: "body", value: 18 },
        { id: "rounded", value: 8 },
      ],
      semanticColors: [
        { id: "surface", primitive: "ink" },
        { id: "content", primitive: "paper" },
      ],
      semanticSizes: [
        { id: "label", primitive: "body" },
        { id: "curve", primitive: "rounded" },
      ],
      styles: [
        {
          id: "control",
          background: "surface",
          foreground: "content",
          textSize: "label",
          cornerRadius: "curve",
        },
      ],
    },
    nodes: [
      {
        id: "menu",
        name: "Start",
        kind: "button",
        style: "control",
        text: "Start rescue",
        action: "start",
        layout,
        requireInsideParent: true,
      },
      {
        id: "hud",
        name: "Status",
        kind: "text",
        style: "control",
        text: "Cells 0/3 · Integrity 2 · Time 120",
        layout: { ...layout, yOffset: 80 },
        requireInsideParent: true,
      },
      {
        id: "results",
        name: "Replay",
        kind: "button",
        style: "control",
        text: "Play again",
        action: "replay",
        layout: { ...layout, yOffset: 144 },
        requireInsideParent: true,
      },
    ],
    viewports: [
      {
        id: "phone",
        width: 360,
        height: 640,
        insetLeft: 0,
        insetTop: 24,
        insetRight: 0,
        insetBottom: 16,
      },
      {
        id: "desktop",
        width: 1280,
        height: 720,
        insetLeft: 16,
        insetTop: 36,
        insetRight: 16,
        insetBottom: 0,
      },
    ],
  };
  const source = (
    id: string,
    context: GameSourceFile["context"],
    role: GameSourceFile["role"],
    parentPath: string,
    className: "ModuleScript" | "Script" | "LocalScript",
    imports: GameSourceFile["imports"],
  ): GameSourceFile => ({
    id,
    path: id + ".luau",
    context,
    role,
    imports,
    content: { kind: "slot", maximumUtf8Bytes: role === "entrypoint" ? 8192 : 32768 },
    placement: {
      kind: "create",
      operationId: "last-light-" + id,
      name:
        "LastLight" +
        id
          .split("-")
          .map((part) => part[0]!.toUpperCase() + part.slice(1))
          .join(""),
      className,
      parent: {
        kind: "engine_container",
        path: parentPath,
        className: parentPath.split("/").at(-1)!,
      },
    },
  });
  assertBoundedGameJson(scene, DEFAULT_GAME_ADMISSION_POLICY);
  assertBoundedGameJson(ui, DEFAULT_GAME_ADMISSION_POLICY);
  const spec: GameDesignSpec = {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "persistent", roots: ["Workspace/LastLightStation"] },
    id: "last-light",
    intent:
      "Build a replayable rescue game: recover three power cells from a failing orbital station and escape before it goes dark.",
    architecture: {
      name: "Last Light",
      nodes: [
        {
          id: "rescue",
          name: "Rescue mission",
          description:
            "Recover the station's power cells and reach the shuttle before power fails.",
          componentIds: [],
        },
        {
          id: "station-space",
          parentId: "rescue",
          name: "Orbital station",
          description:
            "A readable traversal space with three cell bays, a central reactor, hazardous conduits and an escape shuttle.",
          componentIds: ["station"],
        },
        {
          id: "mission-rules",
          parentId: "rescue",
          name: "Mission rules",
          description:
            "Server-owned cell collection, countdown, hazard damage, win and loss rules, and repeatable mission reset; these are Last Light requirements for the unfilled gameplay sources.",
          componentIds: ["game-code"],
        },
        {
          id: "player-feedback",
          parentId: "rescue",
          name: "Player feedback",
          description:
            "Menu, mission status and result screens with desktop and touch actions bound by the client gameplay source.",
          componentIds: ["screens", "game-code"],
        },
        {
          id: "scoped-lifecycle",
          parentId: "rescue",
          name: "Resource lifetime",
          description:
            "Optional pinned Scope, Event, Task and StateMachine utilities for releasing mission resources and safely restarting play.",
          componentIds: ["runtime", "game-code"],
        },
      ],
      relationships: [
        {
          id: "rules-space",
          from: "mission-rules",
          to: "station-space",
          label: "Controls cell, reactor, hazard and shuttle interactions",
        },
        {
          id: "rules-feedback",
          from: "mission-rules",
          to: "player-feedback",
          label: "Publishes mission status and outcome",
        },
        {
          id: "feedback-rules",
          from: "player-feedback",
          to: "mission-rules",
          label: "Requests start and replay actions",
        },
        {
          id: "rules-lifetime",
          from: "mission-rules",
          to: "scoped-lifecycle",
          label: "Owns and releases each mission's resources",
        },
      ],
    },
    components: [
      {
        kind: "recipe_instance",
        id: "station",
        definition: gameRecipeDefinitionLock(SCENE_PRIMITIVES_DEFINITION),
        config: scene,
      },
      {
        kind: "recipe_instance",
        id: "screens",
        definition: gameRecipeDefinitionLock(RESPONSIVE_UI_DEFINITION),
        config: ui,
      },
      {
        kind: "recipe_instance",
        id: "runtime",
        definition: gameRecipeDefinitionLock(runtime),
        config: {},
      },
      {
        kind: "source_package",
        id: "game-code",
        ports: [],
        files: [
          source("contract", "shared", "module", "ReplicatedStorage", "ModuleScript", []),
          source("server-game", "server", "module", "ServerScriptService", "ModuleScript", [
            { componentId: "game-code", fileId: "contract" },
            ...["scope", "event", "task", "state-machine"].map((fileId) => ({
              componentId: "runtime",
              fileId,
            })),
          ]),
          source(
            "client-game",
            "client",
            "module",
            "StarterPlayer/StarterPlayerScripts",
            "ModuleScript",
            [
              { componentId: "game-code", fileId: "contract" },
              { componentId: "runtime", fileId: "scope" },
              { componentId: "runtime", fileId: "event" },
              { componentId: "screens", fileId: "controller" },
            ],
          ),
          source("server-main", "server", "entrypoint", "ServerScriptService", "Script", [
            { componentId: "game-code", fileId: "server-game" },
          ]),
          source(
            "client-main",
            "client",
            "entrypoint",
            "StarterPlayer/StarterPlayerScripts",
            "LocalScript",
            [{ componentId: "game-code", fileId: "client-game" }],
          ),
        ],
        obligations: [
          {
            id: "countdown",
            description:
              "Start a 120-second rescue round after a three-second countdown, using seed 42017 for reproducible layout decisions.",
            evidence: "studio_play",
          },
          {
            id: "power-cells",
            description:
              "Carry one cell at a time from three bays to the reactor. Each deposit awards 100 points.",
            evidence: "studio_play",
          },
          {
            id: "hazards",
            description:
              "Three conduits warn for 1.5 seconds, activate for 2 seconds, rest for 4.5 seconds. Begin with two integrity; a hit also removes eight seconds.",
            evidence: "studio_play",
          },
          {
            id: "round-win",
            description:
              "After three deposits, hold the shuttle interaction for three seconds to escape and display the result.",
            evidence: "studio_play",
          },
          {
            id: "round-loss",
            description:
              "Exercise deadline expiry, integrity depletion, character loss and player departure. Resolve each started round exactly once.",
            evidence: "studio_play",
          },
          {
            id: "round-replay",
            description:
              "Complete ten win/loss/replay cycles without stale callbacks or leftover transient objects.",
            evidence: "studio_play",
          },
          {
            id: "readable-ui",
            description:
              "Keep menu, HUD and results readable on phone and desktop. Primary actions work with touch and gamepad and have at least 48-pixel targets.",
            evidence: "creator_review",
          },
          {
            id: "source-analysis",
            description:
              "Check every filled source slot and resolved import with the pinned Luau parser, analyzer and source policy.",
            evidence: "source_analysis",
          },
        ],
      },
    ],
    connections: [],
    artifactDependencies: [
      { from: "game-code", to: "station" },
      { from: "game-code", to: "screens" },
      { from: "game-code", to: "runtime" },
    ],
  };
  return { spec, catalog };
}
