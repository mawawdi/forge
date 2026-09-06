import {
  compositionConfigDataSchema,
  COMPOSITION_ID_SCHEMA,
  COMPOSITION_NAME_SCHEMA,
} from "./config-schema.js";
import { z } from "zod";
import { UI_CONTROLLER_SOURCE } from "./ui-runtime.js";
import { assertUiValid } from "./ui-validation.js";
export { UI_CONTROLLER_SOURCE } from "./ui-runtime.js";
import { contentHash } from "../../contracts/src/index.js";
import { gameRecipeDefinitionLock, type GameRecipeDefinition } from "../../game-ir/src/index.js";
import type { GameInventoryItem } from "../../game-compiler/src/index.js";
import {
  CompositionError,
  bool,
  boundedConfig,
  color,
  createItem,
  engineParent,
  enumeration,
  integer,
  itemId,
  num,
  outputParent,
  str,
  udim2,
  uniqueById,
  vec2,
  type CompositionContext,
  type CompositionOutput,
} from "./common.js";

const finite = z.number().finite();
const rgb = z
  .object({
    r: z.number().int().min(0).max(255),
    g: z.number().int().min(0).max(255),
    b: z.number().int().min(0).max(255),
  })
  .strict();
const colorToken = z
  .object({
    id: COMPOSITION_ID_SCHEMA,
    primitive: COMPOSITION_ID_SCHEMA.describe(
      "Existing primitive color ID from tokens.colors, not an RGB value or semantic color ID.",
    ),
  })
  .strict();
const sizeToken = z
  .object({
    id: COMPOSITION_ID_SCHEMA,
    primitive: COMPOSITION_ID_SCHEMA.describe(
      "Existing primitive size ID from tokens.sizes, not a number or semantic size ID.",
    ),
  })
  .strict();
const semanticColor = COMPOSITION_ID_SCHEMA.describe(
  "Existing semantic color ID from tokens.semanticColors, not a primitive color ID.",
);
const semanticSize = COMPOSITION_ID_SCHEMA.describe(
  "Existing semantic size ID from tokens.semanticSizes, not a primitive size ID.",
);
const layoutFields = {
  xScale: finite,
  xOffset: finite.int(),
  yScale: finite,
  yOffset: finite.int(),
  widthScale: finite.nonnegative(),
  widthOffset: finite.int(),
  heightScale: finite.nonnegative(),
  heightOffset: finite.int(),
  anchorX: finite.min(0).max(1),
  anchorY: finite.min(0).max(1),
  minWidth: finite.nonnegative(),
  minHeight: finite.nonnegative(),
  maxWidth: finite.positive(),
  maxHeight: finite.positive(),
};
const bindingFields = {
  text: COMPOSITION_ID_SCHEMA.optional(),
  visible: COMPOSITION_ID_SCHEMA.optional(),
  enabled: COMPOSITION_ID_SCHEMA.optional(),
  transparency: COMPOSITION_ID_SCHEMA.optional(),
};
const paddingSchema = z
  .object({ top: semanticSize, right: semanticSize, bottom: semanticSize, left: semanticSize })
  .strict();
const listSchema = z
  .object({
    direction: z.enum(["Horizontal", "Vertical"]),
    gap: semanticSize,
    horizontal: z.enum(["Left", "Center", "Right"]),
    vertical: z.enum(["Top", "Center", "Bottom"]),
    wraps: z.boolean().optional(),
    horizontalFlex: z
      .enum(["None", "Fill", "SpaceAround", "SpaceBetween", "SpaceEvenly"])
      .optional(),
    verticalFlex: z.enum(["None", "Fill", "SpaceAround", "SpaceBetween", "SpaceEvenly"]).optional(),
  })
  .strict();
const aspectSchema = z
  .object({ ratio: finite.positive().max(100), axis: z.enum(["Width", "Height"]) })
  .strict();
const gradientSchema = z
  .object({ from: semanticColor, to: semanticColor, rotation: finite.min(-360).max(360) })
  .strict();
const scrollSchema = z.object({ axis: z.enum(["X", "Y", "XY"]), barSize: semanticSize }).strict();
const stateSurfaceSchema = z
  .object({ background: semanticColor, foreground: semanticColor })
  .strict();
const strokeSchema = z
  .object({
    color: semanticColor,
    thickness: semanticSize,
    transparency: finite.min(0).max(1).optional(),
  })
  .strict();
const typographySchema = z
  .object({
    family: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
      .describe(
        "Built-in Roblox font-family basename, for example BuilderSans. Resolves only to rbxasset://fonts/families/<family>.json; uploaded font IDs are not admitted here. Verify the requested family and weight natively.",
      ),
    weight: z.enum([
      "Thin",
      "ExtraLight",
      "Light",
      "Regular",
      "Medium",
      "SemiBold",
      "Bold",
      "ExtraBold",
      "Heavy",
    ]),
    style: z.enum(["Normal", "Italic"]),
    horizontal: z.enum(["Left", "Center", "Right"]),
    vertical: z.enum(["Top", "Center", "Bottom"]),
    wrapped: z.boolean(),
    lineHeight: finite.min(1).max(3),
  })
  .strict();
export const RESPONSIVE_UI_CONFIG_SCHEMA = z
  .object({
    rootName: COMPOSITION_NAME_SCHEMA.describe(
      "Name of the created ScreenGui. Its source-placement output alias is root.",
    ),
    controller: z
      .boolean()
      .optional()
      .describe(
        "Set true when importing this component's controller source export for an otherwise static UI, including Controller.Observe client observations. Scroll nodes, actions or state bindings also materialize the controller automatically; false does not disable those required exports. The library is emitted at ReplicatedStorage/ForgeUI_<componentId>_Controller; import its controller source export from client source and pass the actual PlayerGui screen to Mount. The module never mounts itself or proves native readiness.",
      ),
    tokens: z
      .object({
        colors: z.array(z.object({ id: COMPOSITION_ID_SCHEMA, value: rgb }).strict()).max(128),
        sizes: z
          .array(z.object({ id: COMPOSITION_ID_SCHEMA, value: finite.nonnegative() }).strict())
          .max(128),
        semanticColors: z.array(colorToken).max(128),
        semanticSizes: z.array(sizeToken).max(128),
        styles: z
          .array(
            z
              .object({
                id: COMPOSITION_ID_SCHEMA,
                background: semanticColor,
                foreground: semanticColor,
                textSize: semanticSize,
                cornerRadius: semanticSize,
                backgroundTransparency: finite.min(0).max(1).optional(),
                typography: typographySchema
                  .optional()
                  .describe(
                    "Shared text hierarchy, alignment and wrapping. Omission uses BuilderSans Regular, centered wrapped text with line height 1. Native text preferences are reflected in TextBounds; do not multiply TextSize again.",
                  ),
                stroke: strokeSchema.optional(),
                interaction: z
                  .object({
                    hover: stateSurfaceSchema,
                    pressed: stateSurfaceSchema,
                    focused: stateSurfaceSchema,
                    disabled: stateSurfaceSchema,
                    focusRing: z.object({ color: semanticColor, thickness: semanticSize }).strict(),
                  })
                  .strict()
                  .optional()
                  .describe(
                    "Optional button appearance states driven by native GuiState and selection. Requires all four states and a focus ring. Changes colors and an existing border without shifting layout or constructing runtime instances. Non-button users of the same style ignore these button states.",
                  ),
              })
              .strict(),
          )
          .max(128),
      })
      .strict(),
    nodes: z
      .array(
        z
          .object({
            id: COMPOSITION_ID_SCHEMA.describe(
              "Local UI node ID. Its created output alias is node/<id>, usable as a source placement component_output parent.",
            ),
            parentId: COMPOSITION_ID_SCHEMA.optional(),
            name: COMPOSITION_NAME_SCHEMA,
            kind: z.enum(["panel", "group", "scroll", "text", "button"]),
            style: COMPOSITION_ID_SCHEMA.describe(
              "Existing component style ID from tokens.styles. Styles reference semantic tokens, which reference primitive token values.",
            ),
            text: z.string().max(4096).optional(),
            action: COMPOSITION_ID_SCHEMA.optional(),
            layout: z.object(layoutFields).strict(),
            requireInsideParent: z.boolean(),
            padding: paddingSchema.optional(),
            list: listSchema.optional(),
            aspect: aspectSchema.optional(),
            gradient: gradientSchema.optional(),
            scroll: scrollSchema.optional(),
            order: finite.int().min(-100000).max(100000).optional(),
            automaticSize: z.enum(["None", "X", "Y", "XY"]).optional(),
            bindings: z.object(bindingFields).strict().optional(),
            motionSeconds: finite.min(0).max(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(512),
    viewports: z
      .array(
        z
          .object({
            id: COMPOSITION_ID_SCHEMA,
            width: finite.positive(),
            height: finite.positive(),
            insetLeft: finite.nonnegative(),
            insetTop: finite.nonnegative(),
            insetRight: finite.nonnegative(),
            insetBottom: finite.nonnegative(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type ResponsiveUiConfig = z.infer<typeof RESPONSIVE_UI_CONFIG_SCHEMA>;
export const RESPONSIVE_UI_DEFINITION: GameRecipeDefinition = {
  kind: "GameRecipeDefinition",
  sourceExports: [{ id: "controller", context: "client" }],
  id: "responsive-ui",
  abi: "5",
  configSchema: compositionConfigDataSchema(RESPONSIVE_UI_CONFIG_SCHEMA),
  ports: [],
  obligations: [
    {
      id: "native-ui-fit",
      description:
        "Measure actual TextBounds, safe-area behavior and layout at the requested viewports, larger text settings and input modes.",
      evidence: "studio_play",
    },
    {
      id: "ui-interaction-review",
      description:
        "Inspect visible focus, touch activation, labels, contrast and any caller-supplied action handlers; the binding module does not implement those handlers.",
      evidence: "creator_review",
    },
  ],
};

export function compileResponsiveUi(
  context: CompositionContext,
  input: unknown,
): CompositionOutput {
  boundedConfig(input);
  const config = RESPONSIVE_UI_CONFIG_SCHEMA.parse(input);
  assertUiValid(config, context.componentId);
  const nodes = uniqueById(config.nodes);
  const colors = uniqueById(config.tokens.colors);
  const sizes = uniqueById(config.tokens.sizes);
  const semanticColors = uniqueById(config.tokens.semanticColors);
  const semanticSizes = uniqueById(config.tokens.semanticSizes);
  const styles = uniqueById(config.tokens.styles);
  const resolveColor = (id: string) => {
    const alias = semanticColors.get(id);
    const value = alias && colors.get(alias.primitive)?.value;
    if (!value) throw new CompositionError("invalid_token", `Unknown semantic color: ${id}`);
    return value;
  };
  const resolveSize = (id: string) => {
    const alias = semanticSizes.get(id);
    const value = alias && sizes.get(alias.primitive)?.value;
    if (value === undefined)
      throw new CompositionError("invalid_token", `Unknown semantic size: ${id}`);
    return value;
  };
  const rootItem = createItem(
    context,
    "root",
    config.rootName,
    "ScreenGui",
    engineParent("StarterGui"),
    {
      ScreenInsets: enumeration("CoreUISafeInsets"),
      ClipToDeviceSafeArea: bool(true),
      ResetOnSpawn: bool(false),
    },
  );
  const root = {
    ...rootItem,
    outputId: "root",
    attributes: { UiRecipeAbi: "5", UiComponentId: context.componentId },
  };
  const inventory: GameInventoryItem[] = [root];
  const created = new Map<string, GameInventoryItem>();
  const active = new Set<string>();
  const create = (id: string): GameInventoryItem => {
    const known = created.get(id);
    if (known) return known;
    const node = nodes.get(id);
    if (!node) throw new CompositionError("invalid_reference", `Unknown UI parent: ${id}`);
    if (active.has(id))
      throw new CompositionError("parent_cycle", "UI parent tree contains a cycle");
    active.add(id);
    const parent = node.parentId ? create(node.parentId) : root;
    const style = styles.get(node.style);
    if (!style)
      throw new CompositionError("invalid_token", `Unknown component style: ${node.style}`);
    const background = resolveColor(style.background);
    const foreground = resolveColor(style.foreground);
    const typography = style.typography;
    const layout = node.layout;
    const className =
      node.kind === "panel"
        ? "Frame"
        : node.kind === "group"
          ? "CanvasGroup"
          : node.kind === "scroll"
            ? "ScrollingFrame"
            : node.kind === "text"
              ? "TextLabel"
              : "TextButton";
    const item = createItem(
      context,
      "node-" + id,
      node.name,
      className,
      outputParent(context, parent),
      {
        AnchorPoint: vec2(layout.anchorX, layout.anchorY),
        Position: udim2(layout.xScale, layout.xOffset, layout.yScale, layout.yOffset),
        Size: udim2(layout.widthScale, layout.widthOffset, layout.heightScale, layout.heightOffset),
        BackgroundColor3: color(background),
        BackgroundTransparency: num(style.backgroundTransparency ?? 0),
        LayoutOrder: integer(node.order ?? [...nodes.keys()].sort().indexOf(id)),
        AutomaticSize: enumeration(node.automaticSize ?? "None"),
        ...(node.kind === "group" ? { GroupTransparency: num(0) } : {}),
        ...(node.scroll
          ? {
              AutomaticCanvasSize: enumeration(node.scroll.axis),
              CanvasSize: udim2(0, 0, 0, 0),
              ScrollingDirection: enumeration(node.scroll.axis),
              ScrollingEnabled: bool(true),
              Active: bool(true),
              ClipsDescendants: bool(true),
              ElasticBehavior: enumeration("WhenScrollable"),
              ScrollBarThickness: integer(Math.round(resolveSize(node.scroll.barSize))),
              ScrollBarImageColor3: color(foreground),
              VerticalScrollBarInset: enumeration(node.scroll.axis === "X" ? "None" : "ScrollBar"),
              HorizontalScrollBarInset: enumeration(
                node.scroll.axis === "Y" ? "None" : "ScrollBar",
              ),
            }
          : {}),
        BorderSizePixel: integer(0),
        ...(["panel", "group", "scroll"].includes(node.kind)
          ? {}
          : {
              Text: str(node.text!),
              TextColor3: color(foreground),
              TextSize: num(resolveSize(style.textSize)),
              FontFace: {
                kind: "font",
                family: `rbxasset://fonts/families/${typography?.family ?? "BuilderSans"}.json`,
                weight: typography?.weight ?? "Regular",
                style: typography?.style ?? "Normal",
              },
              TextWrapped: bool(typography?.wrapped ?? true),
              TextScaled: bool(false),
              RichText: bool(false),
              TextXAlignment: enumeration(typography?.horizontal ?? "Center"),
              TextYAlignment: enumeration(typography?.vertical ?? "Center"),
              LineHeight: num(typography?.lineHeight ?? 1),
            }),
        ...(node.kind === "button"
          ? { Selectable: bool(true), AutoButtonColor: bool(!style.interaction) }
          : {}),
      },
      [parent.id],
    );
    if (
      inventory.some(
        (existing) =>
          existing.change.kind === "create" &&
          existing.change.path === outputParent(context, parent).path + "/" + node.name,
      )
    )
      throw new CompositionError("duplicate_path", "UI sibling names must be unique");
    const bound = {
      ...item,
      outputId: "node/" + node.id,
      attributes: {
        UiNodeId: node.id,
        UiRequireInsideParent: node.requireInsideParent,
        UiBackgroundTransparency: style.backgroundTransparency ?? 0,
        ...(node.kind === "button" && style.interaction
          ? {
              UiInteractionStyle: true,
              UiBaseBackground: background.r * 65536 + background.g * 256 + background.b,
              UiBaseForeground: foreground.r * 65536 + foreground.g * 256 + foreground.b,
              ...Object.fromEntries(
                Object.entries(style.interaction).flatMap(([state, surface]) => {
                  if (state === "focusRing" || !("background" in surface)) return [];
                  return (["background", "foreground"] as const).map((role) => {
                    const rgb = resolveColor(surface[role]);
                    return [
                      `Ui${state[0]!.toUpperCase() + state.slice(1)}${role[0]!.toUpperCase() + role.slice(1)}`,
                      rgb.r * 65536 + rgb.g * 256 + rgb.b,
                    ];
                  });
                }),
              ),
            }
          : {}),
        ...(node.action === undefined ? {} : { UiAction: node.action }),
        ...(node.bindings?.text === undefined ? {} : { UiTextState: node.bindings.text }),
        ...(node.bindings?.visible === undefined ? {} : { UiVisibleState: node.bindings.visible }),
        ...(node.bindings?.enabled === undefined ? {} : { UiEnabledState: node.bindings.enabled }),
        ...(node.bindings?.transparency === undefined
          ? {}
          : { UiTransparencyState: node.bindings.transparency }),
        ...(node.motionSeconds === undefined ? {} : { UiMotionSeconds: node.motionSeconds }),
      },
    };
    inventory.push(bound);
    const target = outputParent(context, bound);
    for (const [role, stroke] of [
      ["Stroke", style.stroke],
      ["FocusRing", node.kind === "button" ? style.interaction?.focusRing : undefined],
    ] as const) {
      if (!stroke) continue;
      inventory.push(
        createItem(
          context,
          `${role.toLowerCase()}-${id}`,
          role,
          "UIStroke",
          target,
          {
            Color: color(resolveColor(stroke.color)),
            Thickness: num(resolveSize(stroke.thickness)),
            Transparency: num("transparency" in stroke ? (stroke.transparency ?? 0) : 0),
            ApplyStrokeMode: enumeration("Border"),
            StrokeSizingMode: enumeration("FixedSize"),
            BorderStrokePosition: enumeration("Inner"),
            LineJoinMode: enumeration("Round"),
            Enabled: bool(role !== "FocusRing"),
          },
          [item.id],
        ),
      );
    }
    inventory.push(
      createItem(
        context,
        "size-" + id,
        "Bounds",
        "UISizeConstraint",
        target,
        {
          MinSize: vec2(layout.minWidth, layout.minHeight),
          MaxSize: vec2(layout.maxWidth, layout.maxHeight),
        },
        [item.id],
      ),
    );
    const radius = resolveSize(style.cornerRadius);
    if (radius > 0)
      inventory.push(
        createItem(
          context,
          "corner-" + id,
          "Corner",
          "UICorner",
          target,
          { CornerRadius: { kind: "udim", scale: 0, offset: Math.round(radius) } },
          [item.id],
        ),
      );
    if (node.padding)
      inventory.push(
        createItem(
          context,
          "padding-" + id,
          "Padding",
          "UIPadding",
          target,
          Object.fromEntries(
            Object.entries(node.padding).map(([side, token]) => [
              "Padding" + side[0]!.toUpperCase() + side.slice(1),
              { kind: "udim" as const, scale: 0, offset: Math.round(resolveSize(token)) },
            ]),
          ),
          [item.id],
        ),
      );
    if (node.list)
      inventory.push(
        createItem(
          context,
          "list-" + id,
          "ListLayout",
          "UIListLayout",
          target,
          {
            FillDirection: enumeration(node.list.direction),
            HorizontalAlignment: enumeration(node.list.horizontal),
            VerticalAlignment: enumeration(node.list.vertical),
            SortOrder: enumeration("LayoutOrder"),
            Padding: { kind: "udim", scale: 0, offset: Math.round(resolveSize(node.list.gap)) },
            Wraps: bool(node.list.wraps ?? false),
            HorizontalFlex: enumeration(node.list.horizontalFlex ?? "None"),
            VerticalFlex: enumeration(node.list.verticalFlex ?? "None"),
          },
          [item.id],
        ),
      );
    if (node.aspect)
      inventory.push(
        createItem(
          context,
          "aspect-" + id,
          "AspectRatio",
          "UIAspectRatioConstraint",
          target,
          {
            AspectRatio: num(node.aspect.ratio),
            AspectType: enumeration("FitWithinMaxSize"),
            DominantAxis: enumeration(node.aspect.axis),
          },
          [item.id],
        ),
      );
    if (node.gradient)
      inventory.push(
        createItem(
          context,
          "gradient-" + id,
          "Gradient",
          "UIGradient",
          target,
          {
            Color: {
              kind: "color_sequence",
              keypoints: [
                { time: 0, color: resolveColor(node.gradient.from) },
                { time: 1, color: resolveColor(node.gradient.to) },
              ],
            },
            Rotation: num(node.gradient.rotation),
            Enabled: bool(true),
          },
          [item.id],
        ),
      );
    created.set(id, bound);
    active.delete(id);
    return bound;
  };
  for (const id of [...nodes.keys()].sort()) create(id);
  // Reserve generated child names too; hierarchy ambiguity must fail before compilation.
  const paths = new Set<string>();
  for (const item of inventory) {
    if (item.change.kind !== "create") continue;
    if (paths.has(item.change.path))
      throw new CompositionError(
        "duplicate_path",
        "UI node collides with a generated layout component",
      );
    paths.add(item.change.path);
  }
  const sources: CompositionOutput["sources"] = [];
  if (
    config.controller ||
    config.nodes.some(
      (node) =>
        node.scroll !== undefined ||
        (node.kind === "button" && styles.get(node.style)?.interaction !== undefined) ||
        node.action !== undefined ||
        Object.keys(node.bindings ?? {}).length > 0,
    )
  ) {
    const id = itemId(context, "controller");
    const parent = engineParent("ReplicatedStorage");
    const name = `ForgeUI_${context.componentId}_Controller`;
    inventory.push({
      id,
      componentId: context.componentId,
      outputId: "controller",
      change: {
        id,
        kind: "create",
        path: parent.path + "/" + name,
        parent,
        className: "ModuleScript",
        initialization: "inline_source_required",
      },
      lockedProperties: {},
      valueSlots: [],
      source: {
        fileId: "controller",
        content: {
          kind: "locked",
          sourceHash: contentHash(UI_CONTROLLER_SOURCE),
          utf8Bytes: Buffer.byteLength(UI_CONTROLLER_SOURCE),
        },
      },
      attributes: {},
      removedAttributes: [],
      dependencies: [],
    });
    sources.push({ operationId: id, source: UI_CONTROLLER_SOURCE });
  }
  return {
    inventory,
    sources,
    obligations: RESPONSIVE_UI_DEFINITION.obligations.map((obligation) => ({
      componentId: context.componentId,
      ...obligation,
    })),
    limitations: [
      "Static viewport checks cover only unrotated rectangles outside layout/padding/aspect/automatic-size subtrees. Those subtrees, actual TextBounds, preferred text size and input focus require native evidence.",
      "The Controller library is emitted in ReplicatedStorage as ForgeUI_<componentId>_Controller. The caller passes the actual PlayerGui screen to Mount with complete declared state and synchronous action handlers, updates it, and unmounts it. It owns existing materialized nodes only; future descendants and application state remain caller responsibilities. Group fades are opt-in, cancel previous tweens, and honor reduced motion; no other animations are introduced.",
      "Token contrast checks cover the declared base colors only; gradients, transparency, group compositing and rendered text need native visual review.",
      "Optional scroll regions use native automatic canvas sizing and inset scrollbars; mount the Controller to honor reduced-motion elasticity. Controller.Observe returns a current-frame client observation of native geometry, text fit and scrolling, never authoritative verification or a settled-layout claim. Enable controller for an otherwise static interface to collect observations without mounting it.",
      "Typography uses built-in font-family paths and explicit FontFace, alignment, wrapping and line height. Native font availability, preferred text size, wrapping/flex layout and all composited surface states require viewport review. Optional button states use native GuiState plus selection, with an inner focus ring and no runtime instance construction or layout animation.",
    ],
  };
}

export const RESPONSIVE_UI_EXPANDER = {
  definition: gameRecipeDefinitionLock(RESPONSIVE_UI_DEFINITION),
  expand: (input: CompositionContext & { config: unknown }) =>
    compileResponsiveUi(input, input.config).inventory,
};
