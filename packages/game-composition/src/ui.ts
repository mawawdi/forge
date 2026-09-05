import { z } from "zod";
import { contentHash } from "../../contracts/src/index.js";
import { gameRecipeDefinitionLock, type GameRecipeDefinition } from "../../game-ir/src/index.js";
import type { GameInventoryItem } from "../../game-compiler/src/index.js";
import {
  CompositionError,
  arraySchema,
  booleanSchema,
  bool,
  boundedConfig,
  color,
  colorSchema,
  createItem,
  engineParent,
  enumeration,
  idSchema,
  integer,
  itemId,
  num,
  numberSchema,
  objectSchema,
  outputParent,
  str,
  textSchema,
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
const token = z.object({ id: z.string(), primitive: z.string() }).strict();
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
const configSchema = z
  .object({
    rootName: z.string(),
    tokens: z
      .object({
        colors: z.array(z.object({ id: z.string(), value: rgb }).strict()).max(128),
        sizes: z.array(z.object({ id: z.string(), value: finite.nonnegative() }).strict()).max(128),
        semanticColors: z.array(token).max(128),
        semanticSizes: z.array(token).max(128),
        styles: z
          .array(
            z
              .object({
                id: z.string(),
                background: z.string(),
                foreground: z.string(),
                textSize: z.string(),
                cornerRadius: z.string(),
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
            id: z.string(),
            parentId: z.string().optional(),
            name: z.string(),
            kind: z.enum(["panel", "text", "button"]),
            style: z.string(),
            text: z.string().max(4096).optional(),
            action: z.string().optional(),
            layout: z.object(layoutFields).strict(),
            requireInsideParent: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(512),
    viewports: z
      .array(
        z
          .object({
            id: z.string(),
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
export type ResponsiveUiConfig = z.infer<typeof configSchema>;
const aliasSchema = objectSchema({ id: idSchema, primitive: idSchema });
const layoutSchema = objectSchema(
  Object.fromEntries(Object.keys(layoutFields).map((key) => [key, numberSchema])),
);

export const RESPONSIVE_UI_DEFINITION: GameRecipeDefinition = {
  kind: "GameRecipeDefinition",
  sourceExports: [{ id: "action-bindings", context: "client" }],
  id: "responsive-ui",
  abi: "1",
  configSchema: objectSchema({
    rootName: idSchema,
    tokens: objectSchema({
      colors: arraySchema(objectSchema({ id: idSchema, value: colorSchema }), 128),
      sizes: arraySchema(objectSchema({ id: idSchema, value: numberSchema }), 128),
      semanticColors: arraySchema(aliasSchema, 128),
      semanticSizes: arraySchema(aliasSchema, 128),
      styles: arraySchema(
        objectSchema({
          id: idSchema,
          background: idSchema,
          foreground: idSchema,
          textSize: idSchema,
          cornerRadius: idSchema,
        }),
        128,
      ),
    }),
    nodes: arraySchema(
      objectSchema(
        {
          id: idSchema,
          parentId: idSchema,
          name: idSchema,
          kind: { type: "string", maxLength: 16, enum: ["panel", "text", "button"] },
          style: idSchema,
          text: textSchema,
          action: idSchema,
          layout: layoutSchema,
          requireInsideParent: booleanSchema,
        },
        ["id", "name", "kind", "style", "layout", "requireInsideParent"],
      ),
      512,
    ),
    viewports: arraySchema(
      objectSchema({
        id: idSchema,
        width: numberSchema,
        height: numberSchema,
        insetLeft: numberSchema,
        insetTop: numberSchema,
        insetRight: numberSchema,
        insetBottom: numberSchema,
      }),
      32,
    ),
  }),
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

/** Explicitly invoked by caller source; it creates no automatic lifecycle or screen controller. */
export const UI_ACTION_BINDINGS_SOURCE = `--!strict
type Handler = (GuiButton) -> ()
return function(root: Instance, handlers: {[string]: Handler}): () -> ()
  local connections: {RBXScriptConnection} = {}
  for _, instance in root:GetDescendants() do
    if instance:IsA("GuiButton") then
      local action = instance:GetAttribute("ActionId")
      if typeof(action) == "string" then
        local handler = handlers[action]
        if handler then
          table.insert(connections, instance.Activated:Connect(function() handler(instance) end))
        end
      end
    end
  end
  local disposed = false
  return function()
    if disposed then return end
    disposed = true
    for _, connection in connections do connection:Disconnect() end
    table.clear(connections)
  end
end
`;

export function compileResponsiveUi(
  context: CompositionContext,
  input: unknown,
): CompositionOutput {
  boundedConfig(input);
  const config = configSchema.parse(input);
  const nodes = uniqueById(config.nodes);
  uniqueById(config.viewports);
  const colors = uniqueById(config.tokens.colors);
  const sizes = uniqueById(config.tokens.sizes);
  const semanticColors = uniqueById(config.tokens.semanticColors);
  const semanticSizes = uniqueById(config.tokens.semanticSizes);
  const styles = uniqueById(config.tokens.styles);
  for (const alias of semanticColors.values())
    if (!colors.has(alias.primitive))
      throw new CompositionError("invalid_token", "Semantic color references an unknown primitive");
  for (const alias of semanticSizes.values())
    if (!sizes.has(alias.primitive))
      throw new CompositionError("invalid_token", "Semantic size references an unknown primitive");
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
  for (const style of styles.values()) {
    resolveColor(style.background);
    resolveColor(style.foreground);
    if (
      resolveSize(style.textSize) < 12 ||
      resolveSize(style.textSize) > 100 ||
      resolveSize(style.cornerRadius) > 128
    )
      throw new CompositionError(
        "invalid_token",
        "This UI recipe admits text sizes 12–100 and corner radii 0–128",
      );
  }
  const root = createItem(
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
    if (node.kind !== "panel" && (!node.text?.trim() || contrast(background, foreground) < 4.5))
      throw new CompositionError(
        "unreadable_ui",
        "Text and buttons require a visible label and token contrast of at least 4.5:1",
      );
    if (node.kind !== "button" && node.action !== undefined)
      throw new CompositionError("invalid_action", "Only buttons admit an action binding");
    if (node.action !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(node.action))
      throw new CompositionError("invalid_action", "Action IDs must be bounded plain identifiers");
    const layout = node.layout;
    if (layout.minWidth > layout.maxWidth || layout.minHeight > layout.maxHeight)
      throw new CompositionError("unsatisfiable_layout", "Minimum layout size exceeds maximum");
    if (node.kind === "button" && (layout.minWidth < 48 || layout.minHeight < 48))
      throw new CompositionError(
        "touch_target",
        "This optional UI recipe requires a 48 by 48 minimum button target",
      );
    const className =
      node.kind === "panel" ? "Frame" : node.kind === "text" ? "TextLabel" : "TextButton";
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
        BackgroundTransparency: num(0),
        BorderSizePixel: integer(0),
        ...(node.kind === "panel"
          ? {}
          : {
              Text: str(node.text!),
              TextColor3: color(foreground),
              TextSize: num(resolveSize(style.textSize)),
              TextWrapped: bool(true),
              TextScaled: bool(false),
              RichText: bool(false),
              TextXAlignment: enumeration("Center"),
              TextYAlignment: enumeration("Center"),
            }),
        ...(node.kind === "button" ? { Selectable: bool(true), AutoButtonColor: bool(true) } : {}),
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
    const bound =
      node.action === undefined ? item : { ...item, attributes: { ActionId: node.action } };
    inventory.push(bound);
    const target = outputParent(context, bound);
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
    created.set(id, bound);
    active.delete(id);
    return bound;
  };
  for (const id of [...nodes.keys()].sort()) create(id);
  for (const viewport of config.viewports) {
    const width = viewport.width - viewport.insetLeft - viewport.insetRight;
    const height = viewport.height - viewport.insetTop - viewport.insetBottom;
    if (width <= 0 || height <= 0)
      throw new CompositionError(
        "unsatisfiable_layout",
        "Viewport insets consume the entire available area",
      );
    const boxes = new Map<string, { width: number; height: number }>();
    const measure = (id: string): { width: number; height: number } => {
      const known = boxes.get(id);
      if (known) return known;
      const node = nodes.get(id)!;
      const parent = node.parentId ? measure(node.parentId) : { width, height };
      const l = node.layout;
      const w = Math.min(
        l.maxWidth,
        Math.max(l.minWidth, parent.width * Math.fround(l.widthScale) + l.widthOffset),
      );
      const h = Math.min(
        l.maxHeight,
        Math.max(l.minHeight, parent.height * Math.fround(l.heightScale) + l.heightOffset),
      );
      const x = parent.width * Math.fround(l.xScale) + l.xOffset - w * Math.fround(l.anchorX);
      const y = parent.height * Math.fround(l.yScale) + l.yOffset - h * Math.fround(l.anchorY);
      if (
        node.requireInsideParent &&
        (x < -0.001 || y < -0.001 || x + w > parent.width + 0.001 || y + h > parent.height + 0.001)
      )
        throw new CompositionError(
          "unsatisfiable_layout",
          `Node ${id} exceeds its parent at viewport ${viewport.id}`,
        );
      const result = { width: w, height: h };
      boxes.set(id, result);
      return result;
    };
    for (const id of nodes.keys()) measure(id);
  }
  const sources: CompositionOutput["sources"] = [];
  if (config.nodes.some((node) => node.action !== undefined)) {
    const id = itemId(context, "bindings");
    inventory.push({
      id,
      componentId: context.componentId,
      change: {
        id,
        kind: "create",
        path: outputParent(context, root).path + "/ActionBindings",
        parent: outputParent(context, root),
        className: "ModuleScript",
        initialization: "inline_source_required",
      },
      lockedProperties: {},
      valueSlots: [],
      source: {
        fileId: "action-bindings",
        content: {
          kind: "locked",
          sourceHash: contentHash(UI_ACTION_BINDINGS_SOURCE),
          utf8Bytes: Buffer.byteLength(UI_ACTION_BINDINGS_SOURCE),
        },
      },
      attributes: {},
      removedAttributes: [],
      dependencies: [root.id],
    });
    sources.push({ operationId: id, source: UI_ACTION_BINDINGS_SOURCE });
  }
  return {
    inventory,
    sources,
    obligations: RESPONSIVE_UI_DEFINITION.obligations.map((obligation) => ({
      componentId: context.componentId,
      ...obligation,
    })),
    limitations: [
      "Viewport checks predict unrotated scale/offset rectangles with supplied insets. Actual Roblox layout, text fitting, preferred text size and input focus require native evidence.",
      "The optional action module binds existing buttons only when caller source invokes it; handlers, future descendants and lifecycle ownership remain the caller's responsibility. No animations are introduced.",
    ],
  };
}

function contrast(a: z.infer<typeof rgb>, b: z.infer<typeof rgb>): number {
  const luminance = (value: z.infer<typeof rgb>) => {
    const linear = (channel: number) => {
      const s = channel / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return linear(value.r) * 0.2126 + linear(value.g) * 0.7152 + linear(value.b) * 0.0722;
  };
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export const RESPONSIVE_UI_EXPANDER = {
  definition: gameRecipeDefinitionLock(RESPONSIVE_UI_DEFINITION),
  expand: (input: CompositionContext & { config: unknown }) =>
    compileResponsiveUi(input, input.config).inventory,
};
