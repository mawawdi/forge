import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { z } from "zod";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  compileResponsiveUi,
  CompositionError,
  RESPONSIVE_UI_DEFINITION,
  RESPONSIVE_UI_CONFIG_SCHEMA,
  UI_CONTROLLER_SOURCE,
  type ResponsiveUiConfig,
} from "../packages/game-composition/src/index.js";
import {
  compileGamePlan,
  materializeGameBuildGraph,
  expandGameDesign,
} from "../packages/game-compiler/src/index.js";
import { createGameSourceContextReader } from "../packages/creator-session/src/game-source-context.js";
import { RESPONSIVE_UI_EXPANDER } from "../packages/game-composition/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameJsonValue,
  type GameDesignSpec,
} from "../packages/game-ir/src/index.js";

const context = { componentId: "interface", projectId: "ui-project", designHash: "a".repeat(64) };
function fixture(): ResponsiveUiConfig {
  const layout = {
    xScale: 0,
    xOffset: 0,
    yScale: 0,
    yOffset: 0,
    widthScale: 1,
    widthOffset: 0,
    heightScale: 0,
    heightOffset: 64,
    anchorX: 0,
    anchorY: 0,
    minWidth: 48,
    minHeight: 48,
    maxWidth: 800,
    maxHeight: 800,
  };
  return {
    rootName: "Interface",
    tokens: {
      colors: [
        { id: "black", value: { r: 0, g: 0, b: 0 } },
        { id: "white", value: { r: 255, g: 255, b: 255 } },
      ],
      sizes: [
        { id: "body", value: 18 },
        { id: "zero", value: 0 },
        { id: "space", value: 12 },
      ],
      semanticColors: [
        { id: "surface", primitive: "black" },
        { id: "content", primitive: "white" },
      ],
      semanticSizes: [
        { id: "label", primitive: "body" },
        { id: "square", primitive: "zero" },
        { id: "gap", primitive: "space" },
      ],
      styles: [
        {
          id: "plain",
          background: "surface",
          foreground: "content",
          textSize: "label",
          cornerRadius: "square",
        },
      ],
    },
    nodes: [
      {
        id: "container",
        name: "Container",
        kind: "group",
        style: "plain",
        layout: { ...layout, heightOffset: 300 },
        requireInsideParent: true,
        padding: { top: "gap", right: "gap", bottom: "gap", left: "gap" },
        list: { direction: "Vertical", gap: "gap", horizontal: "Left", vertical: "Top" },
        bindings: { transparency: "opacity" },
        motionSeconds: 0.15,
      },
      {
        id: "label",
        parentId: "container",
        name: "Label",
        kind: "text",
        style: "plain",
        text: "Status",
        layout: { ...layout },
        requireInsideParent: true,
        bindings: { text: "status" },
        automaticSize: "Y",
      },
      {
        id: "action",
        parentId: "container",
        name: "Action",
        kind: "button",
        style: "plain",
        text: "Continue",
        layout: { ...layout },
        requireInsideParent: true,
        action: "continue",
        bindings: { enabled: "enabled", visible: "visible" },
      },
    ],
    viewports: [
      {
        id: "phone",
        width: 390,
        height: 844,
        insetLeft: 0,
        insetRight: 0,
        insetTop: 30,
        insetBottom: 20,
      },
    ],
  };
}

test("UI layout and declared bindings seal into exact ordinary editor inventory", () => {
  const config = fixture();
  config.nodes[0]!.kind = "scroll";
  config.nodes[0]!.scroll = { axis: "Y", barSize: "gap" };
  delete config.nodes[0]!.bindings;
  delete config.nodes[0]!.motionSeconds;
  config.nodes[2]!.aspect = { ratio: 2, axis: "Width" };
  config.nodes[0]!.gradient = { from: "surface", to: "content", rotation: 90 };
  const output = compileResponsiveUi(context, config);
  const classes: string[] = output.inventory.flatMap((item) =>
    item.change.kind === "create" ? [item.change.className] : [],
  );
  for (const name of [
    "ScrollingFrame",
    "UIPadding",
    "UIListLayout",
    "UIAspectRatioConstraint",
    "UIGradient",
    "ModuleScript",
  ])
    assert.ok(classes.includes(name), name);
  assert.ok(!classes.includes("UICorner"), "Zero radius does not introduce decoration");
  const controller = output.inventory.find((item) => item.source?.fileId === "controller")!;
  assert.equal(controller.source?.content.kind, "locked");
  assert.equal(
    controller.change.kind === "create" && controller.change.path,
    "ReplicatedStorage/ForgeUI_interface_Controller",
  );
  assert.deepEqual(controller.dependencies, []);
  assert.equal(controller.outputId, "controller");
  assert.equal(RESPONSIVE_UI_DEFINITION.abi, "5");
  assert.equal(
    output.inventory.find((item) => item.outputId === "root")!.attributes.UiRecipeAbi,
    "5",
  );
  assert.equal(output.sources[0]?.source, UI_CONTROLLER_SOURCE);
  const design = {
    kind: "GameDesignSpec" as const,
    worldAuthoring: { mode: "none" } as const,
    id: "ui-contract",
    intent: "Materialize a project-authored interface.",
    components: [
      {
        kind: "recipe_instance" as const,
        id: context.componentId,
        definition: gameRecipeDefinitionLock(RESPONSIVE_UI_DEFINITION),
        config: config as unknown as GameJsonValue,
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
  const plan = compileGamePlan({
    design,
    registry: createGameDefinitionRegistry([RESPONSIVE_UI_DEFINITION]),
    projectId: context.projectId,
    project: { name: "UI", placeId: 0, universeId: 0 },
    sessionId: "ui-session",
    observedRevisionHash: "b".repeat(64),
    inventory: output.inventory,
    initialTopology: [
      {
        identity: { kind: "forge_attribute", stableId: "starter-gui" },
        name: "StarterGui",
        path: "StarterGui",
        className: "StarterGui",
        engineContainer: { path: "StarterGui", className: "StarterGui" },
      },
      {
        identity: { kind: "forge_attribute", stableId: "replicated-storage" },
        name: "ReplicatedStorage",
        path: "ReplicatedStorage",
        className: "ReplicatedStorage",
        engineContainer: { path: "ReplicatedStorage", className: "ReplicatedStorage" },
      },
    ],
  });
  const built = materializeGameBuildGraph({
    plan,
    acceptanceHash: "c".repeat(64),
    values: [],
    sources: output.sources.map((source) => ({
      slotId: source.operationId,
      source: source.source,
    })),
    checks: { status: "incomplete", artifactHashes: [] },
  });
  assert.equal(built.graph.operations.length, output.inventory.length);
  assert.equal(
    controller.source?.content.kind === "locked" && controller.source.content.sourceHash,
    contentHash(UI_CONTROLLER_SOURCE),
  );
  assert.match(output.limitations.join(" "), /TextBounds/);
  assert.match(output.limitations.join(" "), /outside layout\/padding\/aspect/);
  assert.ok(output.obligations.some((obligation) => obligation.evidence === "studio_play"));
  const region = output.inventory.find(
    (item) => item.change.kind === "create" && item.change.className === "ScrollingFrame",
  )!;
  assert.deepEqual(region.lockedProperties.AutomaticCanvasSize, { kind: "enum_name", value: "Y" });
  assert.deepEqual(region.lockedProperties.CanvasSize, {
    kind: "udim2",
    x: { scale: 0, offset: 0 },
    y: { scale: 0, offset: 0 },
  });
  assert.deepEqual(region.lockedProperties.VerticalScrollBarInset, {
    kind: "enum_name",
    value: "ScrollBar",
  });
  assert.equal(region.attributes.UiRequireInsideParent, true);
  assert.match(output.limitations.join(" "), /current-frame client observation/);
});

test("static UI can request observation source and scroll canvas children require native layout evidence", () => {
  const schema = z.toJSONSchema(RESPONSIVE_UI_CONFIG_SCHEMA);
  const controller = schema.properties?.controller;
  assert.ok(controller && typeof controller === "object");
  assert.match(controller.description ?? "", /Set true when importing.*otherwise static UI/);
  assert.match(controller.description ?? "", /never mounts itself or proves native readiness/);
  const config = fixture();
  for (const node of config.nodes) {
    delete node.action;
    delete node.bindings;
    delete node.motionSeconds;
    delete node.padding;
    delete node.list;
    delete node.automaticSize;
  }
  config.controller = true;
  const staticOutput = compileResponsiveUi(context, config);
  assert.equal(staticOutput.sources.length, 1);
  assert.equal(staticOutput.sources[0]!.source, UI_CONTROLLER_SOURCE);
  config.controller = false;
  config.nodes[0]!.kind = "scroll";
  config.nodes[0]!.scroll = { axis: "Y", barSize: "gap" };
  config.nodes[1]!.layout.yOffset = 700;
  const scrolled = compileResponsiveUi(context, config);
  assert.equal(scrolled.sources.length, 1);
  assert.ok(scrolled.obligations.some((entry) => entry.id === "native-ui-fit"));
  delete config.nodes[0]!.scroll;
  assert.throws(() => compileResponsiveUi(context, config), /require an explicit axis/);
  config.nodes[0]!.kind = "group";
  config.nodes[0]!.scroll = { axis: "Y", barSize: "gap" };
  assert.throws(() => compileResponsiveUi(context, config), /cannot declare scrolling/);
  config.nodes[0]!.kind = "scroll";
  config.nodes[0]!.scroll.barSize = "square";
  assert.throws(() => compileResponsiveUi(context, config), /1–32 pixels/);
});

test("UI composition order is stable and decoration is optional", () => {
  const config = fixture();
  const first = compileResponsiveUi(context, config);
  config.nodes.reverse();
  assert.equal(stableJson(first), stableJson(compileResponsiveUi(context, config)));
  const plain = fixture();
  for (const node of plain.nodes) {
    delete node.action;
    delete node.bindings;
    delete node.motionSeconds;
    delete node.padding;
    delete node.list;
    delete node.automaticSize;
  }
  const output = compileResponsiveUi(context, plain);
  assert.equal(output.sources.length, 0);
  assert.ok(
    output.inventory.every(
      (item) =>
        item.change.kind !== "create" ||
        !["UIGradient", "UIPadding", "UIListLayout", "UICorner"].includes(item.change.className),
    ),
  );
});

test("UI bindings reject incompatible nodes, ambiguous state types and motion without a target", () => {
  const wrongKind = fixture();
  wrongKind.nodes[1]!.bindings = { enabled: "enabled" };
  assert.throws(() => compileResponsiveUi(context, wrongKind), /incompatible/);
  const mixed = fixture();
  mixed.nodes[1]!.bindings = { text: "enabled" };
  assert.throws(() => compileResponsiveUi(context, mixed), /types conflict/);
  const injected = fixture();
  injected.nodes[1]!.bindings = { text: "state.value; error()" };
  assert.throws(() => compileResponsiveUi(context, injected), /identifiers/i);
  const motion = fixture();
  delete motion.nodes[0]!.bindings;
  assert.throws(() => compileResponsiveUi(context, motion), /Motion requires/);
  const gradient = fixture();
  gradient.nodes[0]!.gradient = { from: "unknown", to: "content", rotation: 0 };
  assert.throws(
    () => compileResponsiveUi(context, gradient),
    (error) => {
      assert.ok(error instanceof CompositionError);
      assert.equal(error.code, "invalid_ui");
      const report = JSON.parse(error.message) as {
        referenceIssues: Array<{ path: string; namespace: string }>;
      };
      assert.ok(
        report.referenceIssues.some(
          (issue) =>
            issue.path === "nodes[0].gradient.from" && issue.namespace === "semanticColors",
        ),
      );
      return true;
    },
  );
});

test("UI authored Controller name is independent of the shared library, while layout child collisions reject", () => {
  const controller = fixture();
  controller.nodes[0]!.name = "Controller";
  const output = compileResponsiveUi(context, controller);
  assert.ok(
    output.inventory.some(
      (item) =>
        item.change.kind === "create" && item.change.path === "StarterGui/Interface/Controller",
    ),
  );
  assert.ok(
    output.inventory.some(
      (item) =>
        item.change.kind === "create" &&
        item.change.path === "ReplicatedStorage/ForgeUI_interface_Controller",
    ),
  );
  const padding = fixture();
  padding.nodes[1]!.name = "Padding";
  assert.throws(
    () => compileResponsiveUi(context, padding),
    (error) => error instanceof CompositionError && error.code === "duplicate_path",
  );
});

test("client entrypoints import component-scoped UI libraries without crossing GUI copy roots", () => {
  const design: GameDesignSpec = {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "ui-libraries",
    intent: "Wire separate project-authored interfaces.",
    components: [
      ...["first", "second"].map((id) => ({
        kind: "recipe_instance" as const,
        id,
        definition: gameRecipeDefinitionLock(RESPONSIVE_UI_DEFINITION),
        config: { ...fixture(), rootName: id } as unknown as GameJsonValue,
      })),
      {
        kind: "source_package",
        id: "client",
        ports: [],
        obligations: [],
        files: [
          {
            id: "entry",
            path: "Client.luau",
            role: "entrypoint",
            context: "client",
            imports: ["first", "second"].map((componentId) => ({
              componentId,
              fileId: "controller",
            })),
            content: { kind: "slot", maximumUtf8Bytes: 4096 },
            placement: {
              kind: "create",
              operationId: "client-entry",
              name: "Client",
              className: "LocalScript",
              parent: {
                kind: "engine_container",
                path: "StarterPlayer/StarterPlayerScripts",
                className: "StarterPlayerScripts",
              },
            },
          },
        ],
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
  const input = {
    design,
    registry: createGameDefinitionRegistry([RESPONSIVE_UI_DEFINITION]),
    recipeExpanders: [RESPONSIVE_UI_EXPANDER],
    projectId: context.projectId,
    project: { name: "UI imports", placeId: 0, universeId: 0 },
    initialTopology: [
      "StarterGui",
      "ReplicatedStorage",
      "StarterPlayer",
      "StarterPlayer/StarterPlayerScripts",
    ].map((path) => ({
      identity: { kind: "forge_attribute" as const, stableId: path },
      path,
      name: path.split("/").at(-1)!,
      className: path.split("/").at(-1)!,
      ...(path.includes("/")
        ? { parentIdentity: { kind: "forge_attribute" as const, stableId: "StarterPlayer" } }
        : {}),
      engineContainer: { path, className: path.split("/").at(-1)! },
    })),
  };
  const plan = compileGamePlan({
    ...input,
    ...expandGameDesign(input),
    sessionId: "ui-imports",
    observedRevisionHash: "b".repeat(64),
  });
  const page = createGameSourceContextReader(plan)({
    planHash: plan.hash,
    operationId: "client-entry",
    offset: 0,
  });
  assert.equal(page.imports.length, 2);
  assert.deepEqual(
    page.imports.map((entry) => entry.path),
    ["ReplicatedStorage/ForgeUI_first_Controller", "ReplicatedStorage/ForgeUI_second_Controller"],
  );
  for (const entry of page.imports) {
    assert.equal(entry.unresolved, undefined);
    assert.equal(
      entry.requireExpression,
      `require(game:GetService("ReplicatedStorage"):WaitForChild("ForgeUI_${entry.componentId}_Controller"))`,
    );
  }
  assert.ok(
    plan.inventory.some(
      (item) => item.change.kind === "create" && item.change.path === "StarterGui/first",
    ),
  );
  assert.ok(
    plan.inventory.some(
      (item) => item.change.kind === "create" && item.change.path === "StarterGui/second",
    ),
  );
});

test("fixed UI controller passes pinned Roblox type analysis and real Luau contract tests", async () => {
  const temp = await mkdtemp(join(tmpdir(), "forge-ui-controller-"));
  try {
    const nativeSource = join(temp, "NativeController.luau");
    await writeFile(nativeSource, UI_CONTROLLER_SOURCE);
    const analyzed = spawnSync(
      "luau-lsp",
      [
        "analyze",
        "--no-strict-dm-types",
        "--definitions",
        resolve("packages/luau-toolchain/roblox/globalTypes.d.luau"),
        nativeSource,
      ],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(analyzed.error, undefined);
    assert.equal(analyzed.status, 0, analyzed.stdout + analyzed.stderr);
    await writeFile(
      join(temp, "UiEnvironment.luau"),
      await readFile("test/ui-controller-environment.luau"),
    );
    await writeFile(
      join(temp, "Controller.luau"),
      'local environment = require("./UiEnvironment")\nlocal game = environment.game\nlocal TweenInfo = environment.TweenInfo\nlocal Enum = environment.Enum\nlocal Color3 = environment.Color3\n' +
        UI_CONTROLLER_SOURCE,
    );
    await writeFile(join(temp, "Fixture.luau"), await readFile("test/ui-controller-runtime.luau"));
    const result = spawnSync("luau", [join(temp, "Fixture.luau")], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /22 UI controller contract cases passed/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
