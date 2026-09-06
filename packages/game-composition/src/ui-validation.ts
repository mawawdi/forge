import { CompositionError } from "./config-schema.js";
import type { ResponsiveUiConfig } from "./ui.js";

export type UiReferenceNamespace =
  "colors" | "sizes" | "semanticColors" | "semanticSizes" | "styles" | "nodes" | "viewports";

export interface UiReferenceIssue {
  code: "duplicate_id" | "unknown_reference" | "ambiguous_reference" | "parent_cycle";
  /** Exact path relative to the parsed UI graph. */
  path: string;
  value: string;
  namespace: UiReferenceNamespace;
  detail: string;
}

export interface UiReferenceDiagnostics {
  issues: UiReferenceIssue[];
  /** Unique declared IDs, shared once per namespace instead of repeated for each issue. */
  validIds: Record<UiReferenceNamespace, string[]>;
}

/**
 * Resolve references after schema parsing without constructing editor objects.
 */
export function collectUiReferenceIssues(config: ResponsiveUiConfig): UiReferenceDiagnostics {
  const declarations: Record<
    UiReferenceNamespace,
    { path: string; entries: readonly { id: string }[] }
  > = {
    colors: { path: "tokens.colors", entries: config.tokens.colors },
    sizes: { path: "tokens.sizes", entries: config.tokens.sizes },
    semanticColors: { path: "tokens.semanticColors", entries: config.tokens.semanticColors },
    semanticSizes: { path: "tokens.semanticSizes", entries: config.tokens.semanticSizes },
    styles: { path: "tokens.styles", entries: config.tokens.styles },
    nodes: { path: "nodes", entries: config.nodes },
    viewports: { path: "viewports", entries: config.viewports },
  };
  const namespaces = Object.keys(declarations) as UiReferenceNamespace[];
  const counts = new Map<UiReferenceNamespace, Map<string, number>>();
  const validIds = {} as Record<UiReferenceNamespace, string[]>;
  const issues: UiReferenceIssue[] = [];
  for (const namespace of namespaces) {
    const { path, entries } = declarations[namespace];
    const count = new Map<string, number>();
    for (const entry of entries) count.set(entry.id, (count.get(entry.id) ?? 0) + 1);
    counts.set(namespace, count);
    validIds[namespace] = [...count.keys()].filter((id) => count.get(id) === 1).sort();
    entries.forEach((entry, index) => {
      if (count.get(entry.id)! > 1)
        issues.push({
          code: "duplicate_id",
          path: `${path}[${index}].id`,
          value: entry.id,
          namespace,
          detail: `ID must be unique within ${namespace}.`,
        });
    });
  }
  const reference = (namespace: UiReferenceNamespace, value: string, path: string): void => {
    const count = counts.get(namespace)!.get(value) ?? 0;
    if (count !== 1)
      issues.push({
        code: count === 0 ? "unknown_reference" : "ambiguous_reference",
        path,
        value,
        namespace,
        detail:
          count === 0
            ? `Reference must name a declared ${namespace} ID; see validIds.${namespace}.`
            : `Reference names multiple ${namespace} declarations; make their IDs unique.`,
      });
  };

  config.tokens.semanticColors.forEach((alias, index) =>
    reference("colors", alias.primitive, `tokens.semanticColors[${index}].primitive`),
  );
  config.tokens.semanticSizes.forEach((alias, index) =>
    reference("sizes", alias.primitive, `tokens.semanticSizes[${index}].primitive`),
  );
  config.tokens.styles.forEach((style, index) => {
    for (const field of ["background", "foreground"] as const)
      reference("semanticColors", style[field], `tokens.styles[${index}].${field}`);
    for (const field of ["textSize", "cornerRadius"] as const)
      reference("semanticSizes", style[field], `tokens.styles[${index}].${field}`);
    for (const [field, stroke] of [
      ["stroke", style.stroke],
      ["interaction.focusRing", style.interaction?.focusRing],
    ] as const) {
      if (!stroke) continue;
      reference("semanticColors", stroke.color, `tokens.styles[${index}].${field}.color`);
      reference("semanticSizes", stroke.thickness, `tokens.styles[${index}].${field}.thickness`);
    }
    if (style.interaction)
      for (const state of ["hover", "pressed", "focused", "disabled"] as const)
        for (const role of ["background", "foreground"] as const)
          reference(
            "semanticColors",
            style.interaction[state][role],
            `tokens.styles[${index}].interaction.${state}.${role}`,
          );
  });
  config.nodes.forEach((node, index) => {
    const path = `nodes[${index}]`;
    if (node.parentId !== undefined) reference("nodes", node.parentId, `${path}.parentId`);
    reference("styles", node.style, `${path}.style`);
    if (node.padding)
      for (const side of ["top", "right", "bottom", "left"] as const)
        reference("semanticSizes", node.padding[side], `${path}.padding.${side}`);
    if (node.list) reference("semanticSizes", node.list.gap, `${path}.list.gap`);
    if (node.gradient) {
      reference("semanticColors", node.gradient.from, `${path}.gradient.from`);
      reference("semanticColors", node.gradient.to, `${path}.gradient.to`);
    }
    if (node.scroll) reference("semanticSizes", node.scroll.barSize, `${path}.scroll.barSize`);
  });

  // Each node has at most one parent. Walk each unique edge once, excluding ambiguous IDs;
  // report all edges in each cycle while keeping descendants outside that cycle unblamed.
  const uniqueNodes = new Map(
    config.nodes.flatMap((node, index) =>
      counts.get("nodes")!.get(node.id) === 1 ? [[node.id, { node, index }] as const] : [],
    ),
  );
  const visited = new Set<string>();
  for (const start of uniqueNodes.keys()) {
    const walk: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && uniqueNodes.has(current) && !visited.has(current)) {
      const cycleStart = position.get(current);
      if (cycleStart !== undefined) {
        for (const id of walk.slice(cycleStart)) {
          const { node, index } = uniqueNodes.get(id)!;
          issues.push({
            code: "parent_cycle",
            path: `nodes[${index}].parentId`,
            value: node.parentId!,
            namespace: "nodes",
            detail: "Parent reference participates in a cycle; UI parents must form a tree.",
          });
        }
        break;
      }
      position.set(current, walk.length);
      walk.push(current);
      current = uniqueNodes.get(current)!.node.parentId;
    }
    for (const id of walk) visited.add(id);
  }
  return { issues, validIds };
}

type UiFact = string | number | boolean | null | UiFact[] | { [key: string]: UiFact };
export interface UiValidationIssue {
  code: string;
  path: string;
  nodeId?: string;
  styleId?: string;
  viewportId?: string;
  actual: UiFact;
  expected: UiFact;
  detail: string;
}
export interface UiValidationDiagnostics {
  componentId: string;
  referenceIssues: UiReferenceIssue[];
  issues: UiValidationIssue[];
  validIds: UiReferenceDiagnostics["validIds"];
  layout: {
    scope: "declared_static_rectangles";
    excludedNodeIds: string[];
    unresolvedNodeIds: string[];
  };
}

/** All independent semantic checks precede inventory expansion. Unresolved inputs do not
 * invent dependent measurements; excluded native layout modes do not gain a static proof. */
export function collectUiValidationIssues(
  config: ResponsiveUiConfig,
  componentId: string,
): UiValidationDiagnostics {
  const references = collectUiReferenceIssues(config);
  const issues: UiValidationIssue[] = [];
  const unique = <T extends { id: string }>(namespace: UiReferenceNamespace, entries: T[]) => {
    const valid = new Set(references.validIds[namespace]);
    return new Map(
      entries.filter((entry) => valid.has(entry.id)).map((entry) => [entry.id, entry]),
    );
  };
  const colors = unique("colors", config.tokens.colors);
  const sizes = unique("sizes", config.tokens.sizes);
  const semanticColors = unique("semanticColors", config.tokens.semanticColors);
  const semanticSizes = unique("semanticSizes", config.tokens.semanticSizes);
  const styles = unique("styles", config.tokens.styles);
  const nodes = unique("nodes", config.nodes);
  const color = (semanticTokenId: string) => {
    const alias = semanticColors.get(semanticTokenId);
    const primitive = alias && colors.get(alias.primitive);
    return (
      primitive && {
        semanticTokenId,
        primitiveTokenId: primitive.id,
        value: { ...primitive.value },
      }
    );
  };
  const size = (semanticTokenId: string) => {
    const alias = semanticSizes.get(semanticTokenId);
    const primitive = alias && sizes.get(alias.primitive);
    return primitive && { semanticTokenId, primitiveTokenId: primitive.id, value: primitive.value };
  };
  config.tokens.styles.forEach((style, index) => {
    for (const [field, minimum, maximum] of [
      ["textSize", 12, 100],
      ["cornerRadius", 0, 128],
    ] as const) {
      const token = size(style[field]);
      if (token && (token.value < minimum || token.value > maximum))
        issues.push({
          code: "invalid_token",
          path: `tokens.styles[${index}].${field}`,
          styleId: style.id,
          actual: token,
          expected: { minimum, maximum, unit: "pixels" },
          detail: `Resolved ${field} must be between ${minimum} and ${maximum} pixels.`,
        });
    }
    for (const [field, stroke, minimum, maximum] of [
      ["stroke", style.stroke, 0.5, 16],
      ["interaction.focusRing", style.interaction?.focusRing, 2, 8],
    ] as const) {
      if (!stroke) continue;
      const token = size(stroke.thickness);
      if (token && (token.value < minimum || token.value > maximum))
        issues.push({
          code: "invalid_token",
          path: `tokens.styles[${index}].${field}.thickness`,
          styleId: style.id,
          actual: token,
          expected: { minimum, maximum, unit: "pixels" },
          detail: `${field} thickness must resolve to ${minimum}–${maximum} pixels.`,
        });
    }
  });
  const bindingUses = new Map<string, Array<{ path: string; nodeId: string; type: string }>>();
  config.nodes.forEach((node, index) => {
    const path = `nodes[${index}]`;
    const base = { nodeId: node.id, styleId: node.style };
    for (const [property, field] of Object.entries(node.bindings ?? {})) {
      if (field === undefined) continue;
      const allowedKinds =
        property === "text"
          ? ["text", "button"]
          : property === "enabled"
            ? ["button"]
            : property === "transparency"
              ? ["group"]
              : ["panel", "group", "scroll", "text", "button"];
      if (!allowedKinds.includes(node.kind))
        issues.push({
          ...base,
          code: "invalid_binding",
          path: `${path}.bindings.${property}`,
          actual: { kind: node.kind, field, property },
          expected: { allowedKinds },
          detail: "Binding property is incompatible with node kind.",
        });
      const type =
        property === "text" ? "string" : property === "transparency" ? "number" : "boolean";
      const uses = bindingUses.get(field) ?? [];
      uses.push({ path: `${path}.bindings.${property}`, nodeId: node.id, type });
      bindingUses.set(field, uses);
    }
    if (node.motionSeconds !== undefined && node.bindings?.transparency === undefined)
      issues.push({
        ...base,
        code: "invalid_motion",
        path: `${path}.motionSeconds`,
        actual: { motionSeconds: node.motionSeconds, transparencyBinding: null },
        expected: { binding: "transparency", kind: "group" },
        detail: "Motion requires a declared group transparency binding.",
      });
    if (node.kind !== "button" && node.action !== undefined)
      issues.push({
        ...base,
        code: "invalid_action",
        path: `${path}.action`,
        actual: { kind: node.kind, action: node.action },
        expected: { kind: "button" },
        detail: "Only buttons admit an action binding.",
      });
    if ((node.kind === "scroll") !== (node.scroll !== undefined))
      issues.push({
        ...base,
        code: "invalid_scroll",
        path: `${path}.scroll`,
        actual: { kind: node.kind, hasScroll: node.scroll !== undefined },
        expected: { hasScroll: node.kind === "scroll" },
        detail:
          "Scroll nodes require an explicit axis and bar token; other nodes cannot declare scrolling.",
      });
    if (node.scroll) {
      const token = size(node.scroll.barSize);
      if (token && (token.value < 1 || token.value > 32))
        issues.push({
          ...base,
          code: "invalid_scroll",
          path: `${path}.scroll.barSize`,
          actual: token,
          expected: { minimum: 1, maximum: 32, unit: "pixels" },
          detail: "Scroll bar size must resolve to 1–32 pixels.",
        });
    }
    if (node.kind === "text" || node.kind === "button") {
      const utf8Bytes = Buffer.byteLength(node.text ?? "");
      if (!node.text?.trim() || utf8Bytes > 4096)
        issues.push({
          ...base,
          code: "unreadable_label",
          path: `${path}.text`,
          actual: { visibleLabel: Boolean(node.text?.trim()), utf8Bytes },
          expected: { visibleLabel: true, maximumUtf8Bytes: 4096 },
          detail: "Text and buttons require a visible label within the UTF-8 byte bound.",
        });
      const style = styles.get(node.style);
      const background = style && color(style.background);
      const foreground = style && color(style.foreground);
      if (background && foreground) {
        const contrastRatio = contrast(background.value, foreground.value);
        if (contrastRatio < 4.5)
          issues.push({
            ...base,
            code: "insufficient_contrast",
            path: `${path}.style`,
            actual: { background, foreground, contrastRatio },
            expected: { minimumContrastRatio: 4.5, scope: "declared_base_colors" },
            detail:
              "Text and buttons require declared base token contrast of at least 4.5:1; compositing and rendered text still require native review.",
          });
      }
      if (node.kind === "button" && style?.interaction) {
        for (const state of ["hover", "pressed", "focused", "disabled"] as const) {
          const background = color(style.interaction[state].background);
          const foreground = color(style.interaction[state].foreground);
          if (background && foreground && contrast(background.value, foreground.value) < 4.5)
            issues.push({
              ...base,
              code: "insufficient_contrast",
              path: `${path}.style`,
              actual: {
                state,
                background,
                foreground,
                contrastRatio: contrast(background.value, foreground.value),
              },
              expected: { minimumContrastRatio: 4.5, scope: "declared_state_colors" },
              detail: `Button ${state} state requires readable label contrast of at least 4.5:1.`,
            });
        }
        const ring = color(style.interaction.focusRing.color);
        const focused = color(style.interaction.focused.background);
        if (ring && focused && contrast(ring.value, focused.value) < 3)
          issues.push({
            ...base,
            code: "insufficient_focus_contrast",
            path: `${path}.style`,
            actual: { ring, focused, contrastRatio: contrast(ring.value, focused.value) },
            expected: { minimumContrastRatio: 3, scope: "declared_state_colors" },
            detail:
              "The inner focus ring must contrast with the focused button surface by at least 3:1.",
          });
      }
    }
    const l = node.layout;
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    for (const [axis, scale] of [
      ["X", l.widthScale],
      ["Y", l.heightScale],
    ] as const)
      if (parent?.automaticSize?.includes(axis) && scale > 0)
        issues.push({
          ...base,
          code: "automatic_size_cycle",
          path: `${path}.layout.${axis === "X" ? "widthScale" : "heightScale"}`,
          actual: { parentId: parent.id, automaticSize: parent.automaticSize, scale },
          expected: { scale: 0, axis },
          detail:
            "A child cannot size itself from the same parent axis that automatically sizes from its children; use an offset or a fixed-size parent.",
        });
    for (const [axis, minimum, maximum] of [
      ["width", l.minWidth, l.maxWidth],
      ["height", l.minHeight, l.maxHeight],
    ] as const)
      if (minimum > maximum)
        issues.push({
          ...base,
          code: "unsatisfiable_layout",
          path: `${path}.layout`,
          actual: { axis, minimum, maximum },
          expected: { minimumAtMostMaximum: true },
          detail: "Minimum layout size exceeds maximum.",
        });
    if (node.kind === "button" && (l.minWidth < 48 || l.minHeight < 48))
      issues.push({
        ...base,
        code: "touch_target",
        path: `${path}.layout`,
        actual: { minWidth: l.minWidth, minHeight: l.minHeight },
        expected: { minWidth: 48, minHeight: 48, unit: "pixels" },
        detail: "This UI graph requires a 48 by 48 minimum button target.",
      });
  });
  for (const [field, uses] of bindingUses)
    if (new Set(uses.map((use) => use.type)).size > 1)
      issues.push({
        code: "invalid_binding",
        path: uses[0]!.path,
        actual: { field, uses },
        expected: { oneTypePerField: true },
        detail: "Shared UI state field types conflict; all uses must agree.",
      });

  type Mode = "modeled" | "excluded" | "unresolved";
  const modes = new Map<string, Mode>();
  const active = new Set<string>();
  const mode = (id: string): Mode => {
    const known = modes.get(id);
    if (known) return known;
    const node = nodes.get(id);
    if (!node || active.has(id)) return "unresolved";
    active.add(id);
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    const parentMode = node.parentId ? mode(node.parentId) : "modeled";
    const result: Mode =
      parentMode === "unresolved" ||
      node.layout.minWidth > node.layout.maxWidth ||
      node.layout.minHeight > node.layout.maxHeight
        ? "unresolved"
        : node.aspect ||
            (node.automaticSize !== undefined && node.automaticSize !== "None") ||
            parentMode === "excluded" ||
            parent?.padding ||
            parent?.list ||
            parent?.scroll
          ? "excluded"
          : "modeled";
    active.delete(id);
    modes.set(id, result);
    return result;
  };
  for (const node of config.nodes) mode(node.id);
  config.viewports.forEach((viewport, viewportIndex) => {
    const width = viewport.width - viewport.insetLeft - viewport.insetRight;
    const height = viewport.height - viewport.insetTop - viewport.insetBottom;
    if (width <= 0 || height <= 0) {
      issues.push({
        code: "unsatisfiable_layout",
        path: `viewports[${viewportIndex}]`,
        viewportId: viewport.id,
        actual: {
          viewport: { ...viewport },
          availableWidth: Number.isFinite(width) ? width : String(width),
          availableHeight: Number.isFinite(height) ? height : String(height),
        },
        expected: { availableWidthGreaterThan: 0, availableHeightGreaterThan: 0 },
        detail: "Viewport insets consume the entire available area.",
      });
      return;
    }
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
      const bounds = {
        x,
        y,
        width: w,
        height: h,
        right: x + w,
        bottom: y + h,
        parentWidth: parent.width,
        parentHeight: parent.height,
      };
      const finite = Object.values(bounds).every(Number.isFinite);
      if (
        !finite ||
        (node.requireInsideParent &&
          (x < -0.001 ||
            y < -0.001 ||
            x + w > parent.width + 0.001 ||
            y + h > parent.height + 0.001))
      )
        issues.push({
          code: "unsatisfiable_layout",
          path: `nodes[${config.nodes.indexOf(node)}].layout`,
          nodeId: id,
          styleId: node.style,
          viewportId: viewport.id,
          actual: {
            parentId: node.parentId ?? null,
            ...Object.fromEntries(
              Object.entries(bounds).map(([key, value]) => [
                key,
                Number.isFinite(value) ? value : String(value),
              ]),
            ),
          },
          expected: {
            finite: true,
            insideParent: node.requireInsideParent,
            tolerancePixels: 0.001,
          },
          detail: finite
            ? `Node ${id} exceeds its parent at viewport ${viewport.id}.`
            : `Node ${id} has nonfinite float32 layout at viewport ${viewport.id}.`,
        });
      const result = { width: w, height: h };
      boxes.set(id, result);
      return result;
    };
    for (const id of nodes.keys()) if (mode(id) === "modeled") measure(id);
  });
  return {
    componentId,
    referenceIssues: references.issues,
    issues,
    validIds: references.validIds,
    layout: {
      scope: "declared_static_rectangles",
      excludedNodeIds: [...modes]
        .filter(([, value]) => value === "excluded")
        .map(([id]) => id)
        .sort(),
      unresolvedNodeIds: [
        ...new Set(
          config.nodes.filter((node) => mode(node.id) === "unresolved").map((node) => node.id),
        ),
      ].sort(),
    },
  };
}

export function assertUiValid(config: ResponsiveUiConfig, componentId: string): void {
  const diagnostics = collectUiValidationIssues(config, componentId);
  if (diagnostics.referenceIssues.length || diagnostics.issues.length)
    throw new CompositionError("invalid_ui", JSON.stringify(diagnostics));
}

function contrast(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const luminance = (value: typeof a) => {
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
