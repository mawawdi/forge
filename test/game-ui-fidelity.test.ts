import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { stableJson } from "../packages/contracts/src/index.js";
import {
  compileResponsiveUi,
  RESPONSIVE_UI_CONFIG_SCHEMA,
  type ResponsiveUiConfig,
} from "../packages/game-composition/src/index.js";
import { collectUiValidationIssues } from "../packages/game-composition/src/ui-validation.js";

const context = {
  componentId: "interface",
  projectId: "fidelity-project",
  designHash: "a".repeat(64),
};
function fixture(): ResponsiveUiConfig {
  const surface = { background: "surface", foreground: "content" };
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
    maxWidth: 1200,
    maxHeight: 900,
  };
  return {
    rootName: "Interface",
    tokens: {
      colors: [
        { id: "ink", value: { r: 8, g: 12, b: 20 } },
        { id: "paper", value: { r: 248, g: 244, b: 236 } },
      ],
      sizes: [
        { id: "body", value: 18 },
        { id: "radius", value: 8 },
        { id: "border", value: 2 },
      ],
      semanticColors: [
        { id: "surface", primitive: "ink" },
        { id: "content", primitive: "paper" },
      ],
      semanticSizes: [
        { id: "label", primitive: "body" },
        { id: "rounding", primitive: "radius" },
        { id: "outline", primitive: "border" },
      ],
      styles: [
        {
          id: "action",
          ...surface,
          textSize: "label",
          cornerRadius: "rounding",
          typography: {
            family: "BuilderSans",
            weight: "SemiBold",
            style: "Normal",
            horizontal: "Left",
            vertical: "Top",
            wrapped: true,
            lineHeight: 1.3,
          },
          stroke: { color: "content", thickness: "outline", transparency: 0.2 },
          interaction: {
            hover: { ...surface },
            pressed: { ...surface },
            focused: { ...surface },
            disabled: { ...surface },
            focusRing: { color: "content", thickness: "outline" },
          },
        },
      ],
    },
    nodes: [
      {
        id: "panel",
        name: "Panel",
        kind: "group",
        style: "action",
        layout: { ...layout, heightOffset: 300 },
        requireInsideParent: true,
        list: {
          direction: "Horizontal",
          horizontal: "Left",
          vertical: "Top",
          gap: "outline",
          wraps: true,
          horizontalFlex: "Fill",
          verticalFlex: "None",
        },
      },
      {
        id: "action",
        name: "Action",
        parentId: "panel",
        kind: "button",
        style: "action",
        text: "Explore",
        layout,
        requireInsideParent: true,
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

test("typography, inner surface strokes and native state surfaces compile into exact authored UI", () => {
  const config = fixture();
  const output = compileResponsiveUi(context, config);
  const button = output.inventory.find((item) => item.outputId === "node/action")!;
  assert.deepEqual(button.lockedProperties.FontFace, {
    kind: "font",
    family: "rbxasset://fonts/families/BuilderSans.json",
    weight: "SemiBold",
    style: "Normal",
  });
  assert.deepEqual(button.lockedProperties.LineHeight, {
    kind: "number_f32",
    value: Math.fround(1.3),
  });
  assert.deepEqual(button.lockedProperties.TextXAlignment, { kind: "enum_name", value: "Left" });
  assert.deepEqual(button.lockedProperties.TextYAlignment, { kind: "enum_name", value: "Top" });
  assert.deepEqual(button.lockedProperties.AutoButtonColor, { kind: "boolean", value: false });
  assert.equal(button.attributes.UiHoverBackground, 8 * 65536 + 12 * 256 + 20);
  assert.equal(button.attributes.UiInteractionStyle, true);
  assert.equal(
    output.inventory.find((item) => item.outputId === "node/panel")!.attributes.UiInteractionStyle,
    undefined,
  );
  const strokes = output.inventory.filter(
    (item) => item.change.kind === "create" && item.change.className === "UIStroke",
  );
  assert.equal(strokes.length, 3, "Two surface borders and exactly one button focus ring");
  const ring = strokes.find(
    (item) => item.change.kind === "create" && item.change.path.endsWith("/FocusRing"),
  )!;
  assert.deepEqual(ring.lockedProperties.BorderStrokePosition, {
    kind: "enum_name",
    value: "Inner",
  });
  assert.deepEqual(ring.lockedProperties.Enabled, { kind: "boolean", value: false });
  const list = output.inventory.find(
    (item) => item.change.kind === "create" && item.change.className === "UIListLayout",
  )!;
  assert.deepEqual(list.lockedProperties.Wraps, { kind: "boolean", value: true });
  assert.deepEqual(list.lockedProperties.HorizontalFlex, { kind: "enum_name", value: "Fill" });
  assert.equal(
    output.sources.length,
    1,
    "Appearance states require their fixed controller even without handlers",
  );
  config.nodes.reverse();
  assert.equal(stableJson(compileResponsiveUi(context, config)), stableJson(output));
});

test("button state labels and visible focus geometry have independent semantic diagnostics", () => {
  const config = fixture();
  config.tokens.styles[0]!.interaction!.pressed.foreground = "surface";
  config.tokens.styles[0]!.interaction!.focusRing.color = "surface";
  config.tokens.sizes[2]!.value = 1;
  const issues = collectUiValidationIssues(config, context.componentId).issues;
  assert.ok(
    issues.some(
      (issue) =>
        issue.code === "insufficient_contrast" &&
        typeof issue.actual === "object" &&
        issue.actual !== null &&
        "state" in issue.actual &&
        issue.actual.state === "pressed",
    ),
  );
  assert.ok(issues.some((issue) => issue.code === "insufficient_focus_contrast"));
  assert.ok(
    issues.some((issue) => issue.path === "tokens.styles[0].interaction.focusRing.thickness"),
  );
  assert.throws(() => compileResponsiveUi(context, config), /insufficient_focus_contrast/);
});

test("style reference diagnostics enumerate missing surface tokens and auto-size dependencies reject", () => {
  const config = fixture();
  config.tokens.styles[0]!.stroke!.color = "missing-outline";
  config.tokens.styles[0]!.interaction!.hover.background = "missing-hover";
  config.nodes[0]!.automaticSize = "Y";
  config.nodes[1]!.layout.heightScale = 0.5;
  const diagnostics = collectUiValidationIssues(config, context.componentId);
  assert.ok(
    diagnostics.referenceIssues.some((issue) => issue.path === "tokens.styles[0].stroke.color"),
  );
  assert.ok(
    diagnostics.referenceIssues.some(
      (issue) => issue.path === "tokens.styles[0].interaction.hover.background",
    ),
  );
  assert.ok(diagnostics.issues.some((issue) => issue.code === "automatic_size_cycle"));
  assert.throws(() => compileResponsiveUi(context, config), /automatic_size_cycle/);
});

test("typography keeps one published model schema and cannot inject external font content", () => {
  const config = fixture();
  assert.ok(RESPONSIVE_UI_CONFIG_SCHEMA.safeParse(config).success);
  const schema = z.toJSONSchema(RESPONSIVE_UI_CONFIG_SCHEMA);
  assert.match(JSON.stringify(schema), /Built-in Roblox font-family basename/);
  for (const family of [
    "../BuilderSans",
    "rbxassetid://123",
    "https://example.com/font",
    "BuilderSans.json",
  ]) {
    config.tokens.styles[0]!.typography!.family = family;
    assert.equal(RESPONSIVE_UI_CONFIG_SCHEMA.safeParse(config).success, false, family);
  }
});
