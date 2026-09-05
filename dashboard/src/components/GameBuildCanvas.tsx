import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import "./game-build-graph.css";
import type {
  GameBuildControlNode,
  GameBuildControlView,
  GameBuildArchitecture,
} from "../../../packages/creator-conversation/src/game-build-contract";

type Point = { x: number; y: number };
type CanvasNode = {
  id: string;
  label: string;
  subtitle: string;
  icon: "build" | "code" | "cube" | "screen" | "folder" | "system";
  kind: "build" | "component" | "object" | "system" | "subsystem";
  status: string;
  position: Point;
  componentId?: string;
  object?: GameBuildControlNode;
  count?: number;
  systemId?: string;
  accent?: number;
  iconText?: string;
};
type CanvasEdge = {
  from: string;
  to: string;
  kind: "membership" | "parent" | "dependency" | "relationship";
  count: number;
  label?: string;
  id?: string;
};
export interface GameSystemCanvasInput {
  readonly architecture: GameBuildArchitecture;
  readonly visibleIds: readonly string[];
  readonly expandedIds: ReadonlySet<string>;
  readonly selectedId: string | undefined;
  readonly scopeKey: string;
  readonly onSelect: (id: string) => void;
  readonly onToggle: (id: string) => void;
}
type Camera = Point & { zoom: number; key: string };
// Allows Fit to include the complete bounded page; dense maps can then be zoomed or filtered.
const MIN_ZOOM = 0.001;
const MAX_ZOOM = 2;

export function GameBuildCanvas({
  view,
  filtered,
  visible,
  component,
  searching,
  selectedId,
  onComponent,
  onNode,
  systems,
}: {
  readonly view: GameBuildControlView;
  readonly filtered: readonly GameBuildControlNode[];
  readonly visible: readonly GameBuildControlNode[];
  readonly component: string;
  readonly searching: boolean;
  readonly selectedId: string | undefined;
  readonly onComponent: (id: string) => void;
  readonly onNode: (id: string) => void;
  readonly systems?: GameSystemCanvasInput;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [camera, setCamera] = useState<Camera | undefined>();
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; origin: Point; camera: Camera } | undefined>(undefined);
  const marker = useId().replaceAll(":", "");
  const layout = useMemo(
    () =>
      systems
        ? systemLayout(systems)
        : spatialLayout(view, filtered, visible, component, searching),
    [view, filtered, visible, component, searching, systems],
  );
  const layoutKey = systems
    ? `system-map:${systems.scopeKey}`
    : layout.nodes.map((node) => node.id).join("|");
  const fitted = fitCamera(layout.nodes, size, layoutKey, Boolean(systems));
  const active = camera?.key === layoutKey ? camera : fitted;
  const currentCamera = useRef(active);
  currentCamera.current = active;
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const project = (point: Point): Point => ({
    x: size.width / 2 + active.x + point.x * active.zoom,
    y: size.height / 2 + active.y + point.y * active.zoom,
  });
  function keepNodeVisible(node: CanvasNode): void {
    if (!systems) return;
    const before = currentCamera.current;
    const at = {
      x: size.width / 2 + before.x + node.position.x * before.zoom,
      y: size.height / 2 + before.y + node.position.y * before.zoom,
    };
    const left = Math.min(100, size.width / 4);
    const right = Math.max(
      left + 80,
      size.width - (systems.selectedId && size.width >= 700 ? 450 : left),
    );
    const top = size.width < 700 ? 164 : 120;
    const bottom = Math.max(
      top,
      size.height - (systems.selectedId && size.width < 700 ? size.height * 0.5 + 90 : 120),
    );
    const x = Math.max(left, Math.min(right, at.x));
    const y = Math.max(top, Math.min(bottom, at.y));
    if (x !== at.x || y !== at.y)
      setCamera({ ...before, x: before.x + x - at.x, y: before.y + y - at.y });
  }
  // Scope changes fit the map; selection and keyboard focus reveal the concept beside the inspector.
  useLayoutEffect(() => {
    const node = layout.nodes.find(
      (node) => node.systemId !== undefined && node.systemId === systems?.selectedId,
    );
    if (node) keepNodeVisible(node);
  }, [systems?.selectedId, systems?.scopeKey, size.width, size.height]);
  function zoomBy(factor: number, point = { x: size.width / 2, y: size.height / 2 }): void {
    const before = currentCamera.current;
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, before.zoom * factor));
    const ratio = zoom / before.zoom;
    setCamera({
      key: layoutKey,
      zoom,
      x: point.x - size.width / 2 - (point.x - size.width / 2 - before.x) * ratio,
      y: point.y - size.height / 2 - (point.y - size.height / 2 - before.y) * ratio,
    });
  }
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resize = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: rect.height });
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const before = currentCamera.current;
      const zoom = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, before.zoom * Math.exp(-event.deltaY * 0.006)),
      );
      const ratio = zoom / before.zoom;
      const x = event.clientX - rect.left - rect.width / 2;
      const y = event.clientY - rect.top - rect.height / 2;
      setCamera({ ...before, zoom, x: x - (x - before.x) * ratio, y: y - (y - before.y) * ratio });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  return (
    <div className={`build-space${systems ? " build-space--systems" : ""}`}>
      <div className="build-space__controls">
        {!systems ? (
          <span className="build-space__breadcrumb">
            <button type="button" onClick={() => onComponent("")} disabled={!component}>
              Components
            </button>
            <strong>{component || `${layout.componentCount} groups`}</strong>
          </span>
        ) : null}
        <span className="build-space__zoom">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={active.zoom <= MIN_ZOOM}
            onClick={() => zoomBy(1 / 1.2)}
          >
            −
          </button>
          <output aria-label="Canvas zoom">
            {active.zoom < 0.1 ? (active.zoom * 100).toFixed(1) : Math.round(active.zoom * 100)}%
          </output>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={active.zoom >= MAX_ZOOM}
            onClick={() => zoomBy(1.2)}
          >
            +
          </button>
          <button type="button" onClick={() => setCamera(fitted)} aria-label="Fit graph to canvas">
            {systems ? <Icon name="expand" size={17} /> : null}
            <span>Fit</span>
          </button>
        </span>
      </div>
      <div
        ref={ref}
        className="build-space__canvas"
        role="region"
        aria-label={systems ? "Game system map" : "Object dependency graph"}
        tabIndex={0}
        data-panning={dragging}
        style={{
          backgroundPosition: `${active.x}px ${active.y}px`,
          backgroundSize: `${systems ? Math.max(18, 28 * active.zoom) : 24 * active.zoom}px ${systems ? Math.max(18, 28 * active.zoom) : 24 * active.zoom}px`,
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
          drag.current = {
            id: event.pointerId,
            origin: { x: event.clientX, y: event.clientY },
            camera: active,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDragging(true);
          event.currentTarget.focus();
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          setCamera({
            ...start.camera,
            x: start.camera.x + event.clientX - start.origin.x,
            y: start.camera.y + event.clientY - start.origin.y,
          });
        }}
        onPointerUp={() => {
          drag.current = undefined;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = undefined;
          setDragging(false);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const motion = {
            ArrowLeft: [60, 0],
            ArrowRight: [-60, 0],
            ArrowUp: [0, 60],
            ArrowDown: [0, -60],
          }[event.key];
          if (motion) {
            event.preventDefault();
            setCamera({ ...active, x: active.x + motion[0]!, y: active.y + motion[1]! });
          } else if (["+", "=", "-", "Home"].includes(event.key)) {
            event.preventDefault();
            if (event.key === "Home") setCamera(fitted);
            else zoomBy(event.key === "-" ? 1 / 1.2 : 1.2);
          }
        }}
      >
        <svg
          className="build-space__links"
          width={size.width}
          height={size.height}
          aria-hidden="true"
        >
          <defs>
            <marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0 0L7 3.5L0 7" fill="var(--paper-muted)" />
            </marker>
          </defs>
          {layout.edges.map((edge) => {
            const from = project(byId.get(edge.to)!.position);
            const to = project(byId.get(edge.from)!.position);
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const distance = Math.max(1, Math.hypot(dx, dy));
            const ux = dx / distance;
            const uy = dy / distance;
            let offset =
              edge.kind === "membership"
                ? 22
                : edge.kind === "parent"
                  ? 30
                  : edge.kind === "relationship"
                    ? 80
                    : -30;
            const x1 = from.x + ux * 37;
            const y1 = from.y + uy * 37;
            const x2 = to.x - ux * 39;
            const y2 = to.y - uy * 39;
            if (systems && edge.kind === "relationship") {
              const center = project({ x: 0, y: 0 });
              const labelX = (x1 + x2) / 2 - (uy * offset) / 2;
              const labelY = (y1 + y2) / 2 + (ux * offset) / 2 - 6;
              // Node labels stay a fixed pixel size while the world zooms. Route around the game pill.
              if (
                Math.abs(labelX - center.x) < 100 &&
                labelY > center.y - 70 &&
                labelY < center.y + 130
              ) {
                if (Math.abs(ux) > 0.65) {
                  const targetY = center.y + (labelY >= center.y ? 150 : -90);
                  offset = (2 * (targetY + 6 - (y1 + y2) / 2)) / ux;
                } else {
                  const labelMargin = Math.min(124, (edge.label?.length ?? 0) * 3.5 + 16);
                  const targetX = Math.max(
                    labelMargin,
                    Math.min(
                      size.width - labelMargin,
                      center.x + (labelX >= center.x ? 110 : -110),
                    ),
                  );
                  offset = (2 * ((x1 + x2) / 2 - targetX)) / uy;
                }
              }
            }
            return (
              <g key={edge.id ?? `${edge.from}:${edge.to}:${edge.kind}`}>
                <path
                  key={`${edge.from}:${edge.to}:${edge.kind}`}
                  d={
                    edge.from === edge.to
                      ? `M${from.x + 26} ${from.y - 18}C${from.x + 120} ${from.y - 110} ${from.x - 120} ${from.y - 110} ${from.x - 26} ${from.y - 18}`
                      : `M${x1} ${y1}Q${(x1 + x2) / 2 - uy * offset} ${(y1 + y2) / 2 + ux * offset} ${x2} ${y2}`
                  }
                  fill="none"
                  className={`build-space__link build-space__link--${edge.kind}`}
                  markerEnd={edge.kind === "membership" ? undefined : `url(#${marker})`}
                >
                  <title>
                    {edge.label ??
                      `${edge.count} ${edge.kind === "membership" ? "contains" : edge.kind} connection`}
                    {edge.count === 1 ? "" : "s"}
                  </title>
                </path>
                {edge.label ? (
                  <text
                    className="build-space__edge-label"
                    x={(x1 + x2) / 2 - (uy * offset) / 2}
                    y={edge.from === edge.to ? from.y - 80 : (y1 + y2) / 2 + (ux * offset) / 2 - 6}
                    textAnchor="middle"
                  >
                    {edge.label.length > 32 ? `${edge.label.slice(0, 29)}…` : edge.label}
                    <title>{edge.label}</title>
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {layout.nodes.map((node) => {
          const at = project(node.position);
          const isObject = node.object !== undefined;
          const label = node.systemId
            ? `Select system ${node.label}`
            : node.object
              ? `${node.label}, ${node.object.className}, ${node.status}`
              : node.kind === "component"
                ? `Expand component ${node.label}, ${node.count} ${node.count === 1 ? "object" : "objects"}`
                : systems
                  ? "Game map overview"
                  : "Build overview";
          return (
            <Fragment key={node.id}>
              <button
                type="button"
                className={`build-space__node build-space__node--${node.kind}`}
                data-graph-node={node.systemId ?? node.object?.id}
                aria-label={label}
                aria-pressed={
                  node.systemId
                    ? systems?.selectedId === node.systemId
                    : isObject
                      ? selectedId === node.object?.id
                      : undefined
                }
                data-selected={node.systemId !== undefined && node.systemId === systems?.selectedId}
                style={{ left: at.x, top: at.y }}
                title={node.object?.path ?? `${node.label} · ${node.subtitle}`}
                onFocus={() => keepNodeVisible(node)}
                onClick={() =>
                  node.systemId
                    ? (setCamera(active), systems!.onSelect(node.systemId))
                    : systems
                      ? setCamera(fitted)
                      : node.object
                        ? onNode(node.object.id)
                        : onComponent(node.kind === "component" ? node.componentId! : "")
                }
              >
                <span
                  className={`build-space__hex build-space__hex--${node.icon}${node.accent === undefined ? "" : ` build-space__hex--accent-${node.accent}`}`}
                >
                  {node.iconText ? (
                    <span className="build-space__emoji" aria-hidden="true">
                      {node.iconText}
                    </span>
                  ) : (
                    <NodeGlyph kind={node.icon} />
                  )}
                </span>
                {node.count !== undefined && !node.systemId ? (
                  <span className="build-space__count">{node.count}</span>
                ) : null}
                {node.status === "Applied" ||
                node.status === "Applying" ||
                node.status === "Stopped" ? (
                  <span
                    aria-hidden="true"
                    className={`build-space__badge build-space__badge--${node.status.toLowerCase()}`}
                  >
                    {node.status === "Applied" ? "✓" : node.status === "Stopped" ? "!" : "•"}
                  </span>
                ) : null}
                <strong>{node.label}</strong>
                {node.subtitle ? (
                  <span className="build-space__subtitle">{node.subtitle}</span>
                ) : null}
              </button>
              {node.systemId && node.count ? (
                <button
                  type="button"
                  className="build-space__expand-node"
                  style={{
                    left: at.x + (node.kind === "subsystem" ? 27 : 40),
                    top: at.y - (node.kind === "subsystem" ? 27 : 40),
                  }}
                  aria-label={`${systems!.expandedIds.has(node.systemId) ? "Collapse" : "Expand"} ${node.label}`}
                  aria-expanded={systems!.expandedIds.has(node.systemId)}
                  onClick={() => {
                    setCamera(active);
                    systems!.onToggle(node.systemId!);
                  }}
                >
                  <span>{systems!.expandedIds.has(node.systemId) ? "−" : `+${node.count}`}</span>
                </button>
              ) : null}
            </Fragment>
          );
        })}
        <span className="build-space__hint" aria-hidden="true">
          <span>Drag to pan</span>
          <span>Ctrl + scroll to zoom</span>
          <span>Arrow keys to move</span>
        </span>
      </div>
      {!systems ? (
        <p className="build-space__legend">
          <span>Faint dashed: group membership</span>
          <span>Arrows: actual dependencies · Solid: parent</span>
          <span>
            {component || searching
              ? "Select an object for its exact source, slots and dependencies."
              : "Select a component to expand its objects."}
          </span>
        </p>
      ) : null}
    </div>
  );
}

function systemLayout(input: GameSystemCanvasInput): {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  componentCount: number;
} {
  const visible = new Set(input.visibleIds);
  const concepts = input.architecture.nodes;
  const byId = new Map(concepts.map((node) => [node.id, node]));
  const positions = new Map<string, Point>();
  function position(id: string): Point {
    const known = positions.get(id);
    if (known) return known;
    const concept = byId.get(id)!;
    const siblings = concepts.filter((node) => node.parentId === concept.parentId);
    const index = siblings.findIndex((node) => node.id === id);
    let at: Point;
    if (concept.parentId) {
      const center = position(concept.parentId);
      const angle =
        Math.atan2(center.y, center.x) +
        (siblings.length === 1
          ? 0
          : -Math.PI * 0.48 +
            ((index % 7) * Math.PI * 0.96) / Math.max(1, Math.min(siblings.length, 7) - 1));
      const radius = 215 + Math.floor(index / 7) * 160;
      at = { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
    } else {
      const angle = -Math.PI / 2 + ((index % 8) * Math.PI * 2) / Math.min(8, siblings.length);
      const radius = 325 + Math.floor(index / 8) * 220;
      at = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    }
    positions.set(id, at);
    return at;
  }
  const systems = concepts.filter((node) => visible.has(node.id));
  const nodes: CanvasNode[] = [
    {
      id: "system-root",
      label: input.architecture.name,
      subtitle: "",
      icon: "build",
      ...(input.architecture.icon ? { iconText: input.architecture.icon } : {}),
      kind: "build",
      status: "",
      position: { x: 0, y: 0 },
    },
  ];
  for (const system of systems) {
    const children = concepts.filter((node) => node.parentId === system.id).length;
    nodes.push({
      id: `system:${system.id}`,
      systemId: system.id,
      label: system.name,
      subtitle: "",
      icon: "system",
      ...(system.icon ? { iconText: system.icon } : {}),
      kind: system.parentId ? "subsystem" : "system",
      accent: stableAccent(system.id),
      status: "",
      position: position(system.id),
      ...(children ? { count: children } : {}),
    });
  }
  const edges: CanvasEdge[] = [
    ...systems.map((system) => ({
      from: `system:${system.id}`,
      to:
        system.parentId && visible.has(system.parentId)
          ? `system:${system.parentId}`
          : "system-root",
      kind: "membership" as const,
      count: 1,
    })),
    ...input.architecture.relationships
      .filter((edge) => visible.has(edge.from) && visible.has(edge.to))
      .map((edge) => ({
        id: edge.id,
        from: `system:${edge.to}`,
        to: `system:${edge.from}`,
        kind: "relationship" as const,
        count: 1,
        label: edge.label,
      })),
  ];
  return { nodes, edges, componentCount: systems.length };
}
/** Visual identity only: accents encode no inferred gameplay category. */
function stableAccent(id: string): number {
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return hash % 5;
}

function spatialLayout(
  view: GameBuildControlView,
  filtered: readonly GameBuildControlNode[],
  visible: readonly GameBuildControlNode[],
  component: string,
  searching: boolean,
): { nodes: CanvasNode[]; edges: CanvasEdge[]; componentCount: number } {
  const groups = new Map<string, GameBuildControlNode[]>();
  for (const node of filtered) {
    const group = groups.get(node.componentId) ?? [];
    group.push(node);
    groups.set(node.componentId, group);
  }
  if (!component && !searching && filtered.length === view.nodes.length)
    for (const entry of view.components) if (!groups.has(entry.id)) groups.set(entry.id, []);
  const groupIds = [...groups.keys()].sort();
  const expanded = Boolean(component) || searching;
  const nodes: CanvasNode[] = [];
  const rootId = component ? `component:${component}` : "build";
  nodes.push({
    id: rootId,
    label: component || "Build plan",
    subtitle: `${filtered.length} objects`,
    icon: component ? iconForGroup(groups.get(component) ?? []) : "build",
    kind: "build",
    position: { x: 0, y: -55 },
    status: "",
    count: filtered.length,
  });
  const membership: CanvasEdge[] = [];
  const positions = new Map<string, Point>();
  if (!component) {
    for (const [index, id] of groupIds.entries()) {
      const group = groups.get(id)!;
      const angle =
        groupIds.length === 2
          ? Math.PI * (index === 0 ? 0.8 : 0.2)
          : -Math.PI / 2 + (index * 2 * Math.PI) / Math.min(10, groupIds.length);
      const ring = Math.floor(index / 10);
      const radius = 225 + ring * 180;
      const position = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius + 35 };
      positions.set(id, position);
      const applied = group.filter((node) => node.status === "applied").length;
      const status = groupStatus(group);
      nodes.push({
        id: `component:${id}`,
        label: id,
        subtitle:
          group.length === 0
            ? `${view.components.find((entry) => entry.id === id)?.observedSources ?? 0} observed sources`
            : applied === group.length
              ? "Applied"
              : applied
                ? `${applied}/${group.length} applied`
                : status,
        icon: iconForGroup(group),
        kind: "component",
        componentId: id,
        position,
        count: group.length,
        status,
      });
      membership.push({
        from: `component:${id}`,
        to: rootId,
        kind: "membership",
        count: group.length,
      });
    }
  } else positions.set(component, { x: 0, y: -55 });
  if (expanded) {
    const counters = new Map<string, number>();
    for (const node of visible) {
      const center = positions.get(node.componentId)!;
      const index = counters.get(node.componentId) ?? 0;
      counters.set(node.componentId, index + 1);
      const count = visible.filter(
        (candidate) => candidate.componentId === node.componentId,
      ).length;
      const ring = Math.floor(index / 9);
      const inRing = Math.min(9, count - ring * 9);
      const angle = Math.PI / 2 + ((index % 9) * 2 * Math.PI) / Math.max(1, inRing);
      const radius = 180 + ring * 140;
      nodes.push({
        id: `object:${node.id}`,
        label: node.label,
        subtitle: node.className,
        icon: iconForGroup([node]),
        kind: "object",
        object: node,
        position: {
          x: center.x + Math.cos(angle) * radius,
          y: center.y + Math.sin(angle) * radius,
        },
        status: titleCase(node.status),
      });
      membership.push({
        from: `object:${node.id}`,
        to: `component:${node.componentId}`,
        kind: "membership",
        count: 1,
      });
    }
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const byObject = new Map(view.nodes.map((node) => [node.id, node]));
  const links = new Map<string, CanvasEdge>();
  if (!expanded)
    for (const edge of view.componentDependencies) {
      const from = `component:${edge.from}`;
      const to = `component:${edge.to}`;
      if (nodeIds.has(from) && nodeIds.has(to))
        links.set(`${from}:${to}:dependency`, { from, to, kind: "dependency", count: 1 });
    }
  for (const edge of view.edges) {
    const fromNode = byObject.get(edge.from)!;
    const toNode = byObject.get(edge.to)!;
    const from = expanded ? `object:${edge.from}` : `component:${fromNode.componentId}`;
    const to = expanded ? `object:${edge.to}` : `component:${toNode.componentId}`;
    if (from === to || !nodeIds.has(from) || !nodeIds.has(to)) continue;
    const key = `${from}:${to}:${edge.kind}`;
    const prior = links.get(key);
    links.set(key, { from, to, kind: edge.kind, count: (prior?.count ?? 0) + 1 });
  }
  return { nodes, edges: [...membership, ...links.values()], componentCount: groups.size };
}
function titleCase(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}
function groupStatus(nodes: readonly GameBuildControlNode[]): string {
  return nodes.length === 0
    ? "Dependency"
    : nodes.every((node) => node.status === "applied")
      ? "Applied"
      : nodes.some((node) => node.status === "applying")
        ? "Applying"
        : nodes.some((node) => node.status === "stopped")
          ? "Stopped"
          : nodes.some((node) => node.status === "pending")
            ? "Pending"
            : nodes.some((node) => node.status === "ready")
              ? "Ready"
              : "Planned";
}
function iconForGroup(nodes: readonly GameBuildControlNode[]): CanvasNode["icon"] {
  return nodes.some((node) => node.source)
    ? "code"
    : nodes.some((node) => /Gui|Frame|Text|Button|UI/.test(node.className))
      ? "screen"
      : nodes.some((node) => /Part|Wedge|Truss|Spawn/.test(node.className))
        ? "cube"
        : "folder";
}
function fitCamera(
  nodes: readonly CanvasNode[],
  size: { width: number; height: number },
  key: string,
  centered = false,
): Camera {
  const xs = nodes.map((node) => node.position.x);
  const ys = nodes.map((node) => node.position.y);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  const topInset = centered && size.width < 700 ? 176 : 80;
  const bottomInset = centered && size.width < 700 ? 120 : 80;
  const zoom = Math.min(
    1,
    Math.max(
      MIN_ZOOM,
      Math.min(
        (size.width - (centered ? 200 : 150)) /
          Math.max(
            1,
            centered ? Math.max(Math.abs(maximumX), Math.abs(minimumX)) * 2 : maximumX - minimumX,
          ),
        (size.height - topInset - bottomInset) /
          Math.max(
            1,
            centered ? Math.max(Math.abs(maximumY), Math.abs(minimumY)) * 2 : maximumY - minimumY,
          ),
      ),
    ),
  );
  return {
    key,
    zoom,
    x: centered ? 0 : (-(minimumX + maximumX) / 2) * zoom,
    y: centered ? (topInset - bottomInset) / 2 : (-(minimumY + maximumY) / 2) * zoom - 15,
  };
}
function NodeGlyph({ kind }: { readonly kind: CanvasNode["icon"] }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "system" ? (
        <>
          <path d="M16 3l10 6v13l-10 7-10-7V9l10-6Z" />
          <path d="M16 10v12M11 13l5-3 5 3M11 19l5 3 5-3" />
        </>
      ) : kind === "code" ? (
        <>
          <path d="M10 9L3 16l7 7M22 9l7 7-7 7M19 6l-6 20" />
        </>
      ) : kind === "cube" ? (
        <>
          <path d="M16 3L4 9v14l12 6 12-6V9L16 3Z" />
          <path d="M4 9l12 7 12-7M16 16v13M10 6l12 7" />
        </>
      ) : kind === "screen" ? (
        <>
          <rect x="3" y="5" width="26" height="21" rx="3" />
          <path d="M3 11h26M12 11v15M17 16h7M17 20h5" />
        </>
      ) : kind === "folder" ? (
        <>
          <path d="M3 10V7a2 2 0 0 1 2-2h7l3 4h12a2 2 0 0 1 2 2v14H3V10Z" />
          <path d="M3 14h26" />
        </>
      ) : (
        <>
          <path d="M16 2l12 7v14l-12 7-12-7V9l12-7Z" />
          <path d="M10 11h12M10 16h12M10 21h7" />
        </>
      )}
    </svg>
  );
}
