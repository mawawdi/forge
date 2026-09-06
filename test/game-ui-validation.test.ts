import assert from "node:assert/strict";
import test from "node:test";
import { CompositionError } from "../packages/game-composition/src/common.js";
import {
  compileResponsiveUi,
  RESPONSIVE_UI_DEFINITION,
  RESPONSIVE_UI_EXPANDER,
  type ResponsiveUiConfig,
} from "../packages/game-composition/src/ui.js";
import {
  assertUiValid,
  collectUiReferenceIssues,
  collectUiValidationIssues,
} from "../packages/game-composition/src/ui-validation.js";
import { CreatorDesignDraft } from "../packages/creator-session/src/design-draft.js";
import { validateCreatorGameComponent } from "../packages/creator-session/src/game-authoring.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameJsonValue,
} from "../packages/game-ir/src/index.js";

function fixture(): ResponsiveUiConfig {
  const layout = {
    xScale: 0,
    xOffset: 0,
    yScale: 0,
    yOffset: 0,
    widthScale: 0,
    widthOffset: 300,
    heightScale: 0,
    heightOffset: 200,
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
        id: "child",
        parentId: "container",
        name: "Child",
        kind: "panel",
        style: "plain",
        layout: { ...layout, widthOffset: 100, heightOffset: 100 },
        requireInsideParent: true,
      },
      {
        id: "container",
        name: "Container",
        kind: "scroll",
        style: "plain",
        layout,
        requireInsideParent: true,
        padding: { top: "gap", right: "gap", bottom: "gap", left: "gap" },
        list: { direction: "Vertical", gap: "gap", horizontal: "Left", vertical: "Top" },
        gradient: { from: "surface", to: "content", rotation: 90 },
        scroll: { axis: "Y", barSize: "gap" },
      },
    ],
    viewports: [],
  };
}

test("UI reference pass accepts forward parents and all optional token uses without mutation", () => {
  const config = fixture();
  const before = structuredClone(config);
  const result = collectUiReferenceIssues(config);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.validIds.semanticSizes, ["gap", "label", "square"]);
  assert.doesNotThrow(() => assertUiValid(config, "interface"));
  assert.deepEqual(config, before);
});

test("one UI diagnostic includes all token layers and optional layout reference paths", () => {
  const config = fixture();
  config.tokens.semanticColors[0]!.primitive = "missing-color";
  config.tokens.semanticSizes[0]!.primitive = "missing-size";
  Object.assign(config.tokens.styles[0]!, {
    background: "black",
    foreground: "white",
    textSize: "body",
    cornerRadius: "zero",
  });
  const node = config.nodes[1]!;
  node.parentId = "missing-parent";
  node.style = "missing-style";
  node.padding = { top: "space", right: "space", bottom: "space", left: "space" };
  node.list!.gap = "space";
  node.gradient = { from: "black", to: "white", rotation: 90 };
  node.scroll!.barSize = "space";
  const result = collectUiReferenceIssues(config);
  assert.deepEqual(
    result.issues.map((issue) => issue.path),
    [
      "tokens.semanticColors[0].primitive",
      "tokens.semanticSizes[0].primitive",
      "tokens.styles[0].background",
      "tokens.styles[0].foreground",
      "tokens.styles[0].textSize",
      "tokens.styles[0].cornerRadius",
      "nodes[1].parentId",
      "nodes[1].style",
      "nodes[1].padding.top",
      "nodes[1].padding.right",
      "nodes[1].padding.bottom",
      "nodes[1].padding.left",
      "nodes[1].list.gap",
      "nodes[1].gradient.from",
      "nodes[1].gradient.to",
      "nodes[1].scroll.barSize",
    ],
  );
  assert.ok(result.issues.every((issue) => issue.code === "unknown_reference"));
  assert.deepEqual(result.validIds.colors, ["black", "white"]);
  assert.deepEqual(result.validIds.semanticColors, ["content", "surface"]);
  assert.deepEqual(result.validIds.styles, ["plain"]);
  assert.deepEqual(result.validIds.nodes, ["child", "container"]);
  assert.throws(
    () => assertUiValid(config, "interface"),
    (error: unknown) => {
      assert.ok(error instanceof CompositionError);
      assert.equal(error.code, "invalid_ui");
      assert.deepEqual(JSON.parse(error.message), collectUiValidationIssues(config, "interface"));
      return true;
    },
  );
});

test("archived planner primitive-for-semantic mistakes report colors and sizes together", () => {
  // Narrow token-reference corpus from failed run agent_run_9d2a7131-1bc8-411a-95cb-a88073d6baab,
  // turn 18 checkpoint d711d494402f3119308ab932c41240aac34b99784c70bcffc46bfb1a07474fb1.
  // No creator brief, generated code, scene, or repair solution is imported into the harness.
  const config = fixture();
  config.tokens.colors = [
    { id: "panel", value: { r: 31, g: 31, b: 41 } },
    { id: "text", value: { r: 242, g: 242, b: 250 } },
  ];
  config.tokens.sizes = [
    { id: "px8", value: 8 },
    { id: "px16", value: 16 },
    { id: "px24", value: 24 },
    { id: "px48", value: 48 },
  ];
  config.tokens.semanticColors = [
    { id: "sem-surface", primitive: "panel" },
    { id: "sem-text", primitive: "text" },
  ];
  config.tokens.semanticSizes = [
    { id: "sem-gap", primitive: "px8" },
    { id: "sem-pad", primitive: "px16" },
    { id: "sem-touch", primitive: "px48" },
  ];
  config.tokens.styles = [
    {
      id: "st-panel",
      background: "panel",
      foreground: "text",
      textSize: "px24",
      cornerRadius: "px16",
    },
  ];
  config.nodes = [{ ...config.nodes[0]!, style: "st-panel" }];
  delete config.nodes[0]!.parentId;
  const result = collectUiReferenceIssues(config);
  assert.equal(result.issues.length, 4);
  assert.deepEqual(
    result.issues.map(({ path, value, namespace }) => ({ path, value, namespace })),
    [
      { path: "tokens.styles[0].background", value: "panel", namespace: "semanticColors" },
      { path: "tokens.styles[0].foreground", value: "text", namespace: "semanticColors" },
      { path: "tokens.styles[0].textSize", value: "px24", namespace: "semanticSizes" },
      { path: "tokens.styles[0].cornerRadius", value: "px16", namespace: "semanticSizes" },
    ],
  );
  assert.deepEqual(result.validIds.semanticColors, ["sem-surface", "sem-text"]);
  assert.deepEqual(result.validIds.semanticSizes, ["sem-gap", "sem-pad", "sem-touch"]);
});

test("duplicate declarations cannot silently choose a reference target", () => {
  const config = fixture();
  config.tokens.colors.push({ id: "black", value: { r: 1, g: 1, b: 1 } });
  config.tokens.styles.push({ ...config.tokens.styles[0]! });
  const result = collectUiReferenceIssues(config);
  assert.deepEqual(
    result.issues.filter((issue) => issue.code === "duplicate_id").map((issue) => issue.path),
    ["tokens.colors[0].id", "tokens.colors[2].id", "tokens.styles[0].id", "tokens.styles[1].id"],
  );
  assert.deepEqual(
    result.issues
      .filter((issue) => issue.code === "ambiguous_reference")
      .map((issue) => issue.path),
    ["tokens.semanticColors[0].primitive", "nodes[0].style", "nodes[1].style"],
  );
  assert.deepEqual(result.validIds.colors, ["white"]);
  assert.deepEqual(result.validIds.styles, []);
});

test("all parent-cycle edges are reported, with unrelated descendants and missing parents separate", () => {
  const config = fixture();
  const base = config.nodes[0]!;
  config.nodes = [
    { ...base, id: "descendant", parentId: "first" },
    { ...base, id: "first", parentId: "second" },
    { ...base, id: "second", parentId: "first" },
    { ...base, id: "self", parentId: "self" },
    { ...base, id: "missing", parentId: "absent" },
  ];
  const result = collectUiReferenceIssues(config);
  assert.deepEqual(
    result.issues.filter((issue) => issue.code === "parent_cycle").map((issue) => issue.path),
    ["nodes[1].parentId", "nodes[2].parentId", "nodes[3].parentId"],
  );
  assert.deepEqual(
    result.issues.filter((issue) => issue.code === "unknown_reference").map((issue) => issue.path),
    ["nodes[4].parentId"],
  );
});

test("compiler surfaces aggregate UI references before inventory construction", () => {
  const config = fixture();
  const context = {
    componentId: "interface",
    projectId: "reference-test",
    designHash: "a".repeat(64),
  };
  const valid = compileResponsiveUi(context, config);
  assert.ok(valid.inventory.length > 0);
  assert.ok(valid.obligations.some((obligation) => obligation.evidence === "studio_play"));
  config.tokens.styles[0]!.background = "black";
  config.tokens.styles[0]!.textSize = "body";
  assert.throws(
    () => compileResponsiveUi(context, config),
    (error: unknown) => {
      assert.ok(error instanceof CompositionError);
      assert.equal(error.code, "invalid_ui");
      assert.deepEqual(
        JSON.parse(error.message),
        collectUiValidationIssues(config, context.componentId),
      );
      return true;
    },
  );
});

test("large invalid graphs share valid IDs once instead of multiplying the diagnostic payload", () => {
  const config = fixture();
  config.nodes = Array.from({ length: 512 }, (_, index) => ({
    ...config.nodes[0]!,
    id: `node-${index}`,
    parentId: "absent",
  }));
  const result = collectUiReferenceIssues(config);
  assert.equal(result.issues.length, 512);
  assert.equal(result.validIds.nodes.length, 512);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 150_000);
  assert.ok(result.issues.every((issue) => !Object.hasOwn(issue, "validIds")));
});

const viewport = (id: string, width: number, height: number) => ({
  id,
  width,
  height,
  insetTop: 0,
  insetRight: 0,
  insetBottom: 0,
  insetLeft: 0,
});

test("one pre-expansion UI report identifies independent contrast, label, token and viewport failures", () => {
  const config = fixture();
  config.nodes = ["first", "second"].map((id) => ({
    ...config.nodes[0]!,
    id,
    name: id,
    kind: "button",
    text: id === "first" ? "Visible" : " ",
    layout: { ...config.nodes[0]!.layout, xOffset: 110, minHeight: 24 },
  }));
  for (const node of config.nodes) delete node.parentId;
  config.tokens.styles[0]!.foreground = "surface";
  config.tokens.sizes[0]!.value = 11;
  config.tokens.sizes[1]!.value = 129;
  config.viewports = [
    viewport("narrow", 200, 180),
    viewport("short", 200, 90),
    { ...viewport("consumed", 100, 100), insetLeft: 100 },
  ];
  const before = structuredClone(config);
  const result = collectUiValidationIssues(config, "project-interface");
  assert.equal(result.componentId, "project-interface");
  assert.equal(result.referenceIssues.length, 0);
  assert.equal(result.issues.filter((issue) => issue.code === "invalid_token").length, 2);
  assert.equal(result.issues.filter((issue) => issue.code === "touch_target").length, 2);
  const contrast = result.issues.filter((issue) => issue.code === "insufficient_contrast");
  assert.deepEqual(
    contrast.map((issue) => issue.nodeId),
    ["first", "second"],
  );
  assert.deepEqual(contrast[0]!.actual, {
    background: {
      semanticTokenId: "surface",
      primitiveTokenId: "black",
      value: { r: 0, g: 0, b: 0 },
    },
    foreground: {
      semanticTokenId: "surface",
      primitiveTokenId: "black",
      value: { r: 0, g: 0, b: 0 },
    },
    contrastRatio: 1,
  });
  assert.deepEqual(contrast[0]!.expected, {
    minimumContrastRatio: 4.5,
    scope: "declared_base_colors",
  });
  assert.equal(contrast[0]!.styleId, "plain");
  assert.equal(contrast[0]!.path, "nodes[0].style");
  assert.equal(result.issues.find((issue) => issue.code === "unreadable_label")!.nodeId, "second");
  const bounds = result.issues.filter((issue) => issue.nodeId && issue.viewportId);
  assert.equal(bounds.length, 4);
  assert.deepEqual(bounds[0]!.actual, {
    parentId: null,
    x: 110,
    y: 0,
    width: 100,
    height: 100,
    right: 210,
    bottom: 100,
    parentWidth: 200,
    parentHeight: 180,
  });
  assert.deepEqual(bounds[0]!.expected, {
    finite: true,
    insideParent: true,
    tolerancePixels: 0.001,
  });
  assert.ok(
    result.issues.some((issue) => issue.viewportId === "consumed" && issue.path === "viewports[2]"),
  );
  assert.deepEqual(config, before);
  // Reading project identity for generated parents would enter expansion; diagnostics win first.
  assert.throws(
    () =>
      compileResponsiveUi(
        {
          componentId: "project-interface",
          get projectId(): string {
            throw new Error("Expansion must not run");
          },
          designHash: "a".repeat(64),
        },
        config,
      ),
    (error) => {
      assert.ok(error instanceof CompositionError);
      assert.equal(error.code, "invalid_ui");
      assert.deepEqual(JSON.parse(error.message), result);
      return true;
    },
  );
});

test("unresolved references do not hide unrelated numeric errors or invent dependent contrast and bounds", () => {
  const config = fixture();
  config.nodes[0]!.parentId = "absent";
  config.nodes[0]!.kind = "text";
  config.nodes[0]!.text = "Label";
  config.nodes[0]!.style = "absent";
  config.nodes[1]!.layout.minWidth = 900;
  config.tokens.sizes[0]!.value = 10;
  config.viewports = [viewport("small", 50, 50)];
  const result = collectUiValidationIssues(config, "interface");
  assert.deepEqual(
    result.referenceIssues.map((issue) => issue.path),
    ["nodes[0].parentId", "nodes[0].style"],
  );
  assert.ok(result.issues.some((issue) => issue.code === "invalid_token"));
  assert.ok(result.issues.some((issue) => issue.code === "unsatisfiable_layout"));
  assert.ok(
    result.issues.every(
      (issue) => issue.code !== "insufficient_contrast" && issue.viewportId === undefined,
    ),
  );
  assert.deepEqual(result.layout.unresolvedNodeIds, ["child", "container"]);
  config.nodes[0]!.parentId = "container";
  config.nodes[1]!.parentId = "child";
  assert.equal(
    collectUiValidationIssues(config, "interface").referenceIssues.filter(
      (issue) => issue.code === "parent_cycle",
    ).length,
    2,
  );
});

test("static layout keeps float32 arithmetic, nested parent bounds, tolerance and native exclusions", () => {
  const config = fixture();
  config.nodes[1]!.kind = "panel";
  delete config.nodes[1]!.padding;
  delete config.nodes[1]!.list;
  delete config.nodes[1]!.scroll;
  config.nodes[1]!.layout.widthOffset = 300;
  config.nodes[0]!.layout.xScale = 0.7000001;
  config.viewports = [viewport("screen", 900, 600)];
  const result = collectUiValidationIssues(config, "interface");
  const overflow = result.issues.find((issue) => issue.nodeId === "child")!;
  assert.ok(overflow);
  const actual = overflow.actual as Record<string, unknown>;
  assert.equal(actual.x, 300 * Math.fround(0.7000001));
  assert.equal(actual.parentWidth, 300);
  config.nodes[0]!.layout.xScale = 2 / 3;
  assert.equal(
    collectUiValidationIssues(config, "interface").issues.length,
    0,
    "float32 rounding within 0.001px tolerance",
  );
  config.nodes[0]!.layout.xOffset = 500;
  for (const variant of ["padding", "list", "scroll", "aspect", "automaticSize"] as const) {
    const excluded = structuredClone(config);
    const parent = excluded.nodes[1]!;
    if (variant === "padding")
      parent.padding = { top: "gap", right: "gap", bottom: "gap", left: "gap" };
    if (variant === "list")
      parent.list = { direction: "Vertical", gap: "gap", horizontal: "Left", vertical: "Top" };
    if (variant === "scroll") {
      parent.kind = "scroll";
      parent.scroll = { axis: "Y", barSize: "gap" };
    }
    if (variant === "aspect") parent.aspect = { ratio: 2, axis: "Width" };
    if (variant === "automaticSize") parent.automaticSize = "XY";
    const report = collectUiValidationIssues(excluded, "interface");
    assert.equal(report.issues.length, 0, variant);
    assert.ok(report.layout.excludedNodeIds.includes("child"), variant);
  }
});

test("UI semantic diagnostics aggregate binding conflicts, scroll limits and multi-byte labels", () => {
  const config = fixture();
  config.nodes[0]!.kind = "text";
  config.nodes[0]!.text = "😀".repeat(1100);
  config.nodes[0]!.bindings = { text: "same", enabled: "active" };
  config.nodes[0]!.motionSeconds = 0.2;
  config.nodes[0]!.action = "go";
  config.nodes[1]!.bindings = { visible: "same" };
  config.tokens.sizes[2]!.value = 33;
  const report = collectUiValidationIssues(config, "interface");
  for (const code of [
    "invalid_binding",
    "invalid_motion",
    "invalid_action",
    "invalid_scroll",
    "unreadable_label",
  ])
    assert.ok(
      report.issues.some((issue) => issue.code === code),
      code,
    );
  assert.deepEqual(report.issues.find((issue) => issue.code === "unreadable_label")!.actual, {
    visibleLabel: true,
    utf8Bytes: 4400,
  });
  assert.ok(report.issues.some((issue) => issue.detail.includes("types conflict")));
});

test("draft component semantic admission rejects UI errors before saving or replacing a valid declaration", () => {
  const draft = new CreatorDesignDraft({
    definitions: [RESPONSIVE_UI_DEFINITION],
    registry: createGameDefinitionRegistry([RESPONSIVE_UI_DEFINITION]),
    expanders: [RESPONSIVE_UI_EXPANDER],
    lockedSources: new Map(),
    validateComponent: validateCreatorGameComponent,
  });
  const make = (config: ResponsiveUiConfig) => ({
    kind: "recipe_instance" as const,
    id: "interface",
    definition: gameRecipeDefinitionLock(RESPONSIVE_UI_DEFINITION),
    config: config as unknown as GameJsonValue,
  });
  const bad = fixture();
  bad.tokens.sizes[0]!.value = 10;
  bad.nodes[0]!.layout.minWidth = 900;
  const emptyHash = draft.hash;
  assert.throws(
    () => draft.define({ component: make(bad) }),
    (error) => error instanceof CompositionError && error.code === "invalid_ui",
  );
  assert.equal(draft.hash, emptyHash);
  assert.deepEqual(draft.read().refs, []);
  const accepted = draft.define({ component: make(fixture()) });
  const before = draft.read({ componentIds: ["interface"] });
  const hash = draft.hash;
  assert.throws(
    () => draft.define({ component: make(bad) }),
    (error) => error instanceof CompositionError && error.code === "invalid_ui",
  );
  assert.equal(draft.hash, hash);
  assert.deepEqual(draft.read({ componentIds: ["interface"] }), before);
  const repaired = fixture();
  repaired.rootName = "Repaired";
  assert.notEqual(
    draft.define({ component: make(repaired) }).componentHash,
    accepted.componentHash,
  );
});
