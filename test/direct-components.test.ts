import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import { compileGamePlan, expandGameDesign } from "../packages/game-compiler/src/index.js";
import type { GameDesignSpec } from "../packages/game-ir/src/index.js";

const engine = (path: string, className = path.split("/").at(-1)!) => ({
  identity: { kind: "forge_attribute" as const, stableId: `engine-${path.replaceAll("/", "-")}` },
  name: path.split("/").at(-1)!,
  path,
  className,
  engineContainer: { path, className },
});

function design(): GameDesignSpec {
  const layout = {
    xScale: 0,
    xOffset: 12,
    yScale: 0,
    yOffset: 12,
    widthScale: 0,
    widthOffset: 300,
    heightScale: 0,
    heightOffset: 56,
    anchorX: 0,
    anchorY: 0,
    minWidth: 48,
    minHeight: 48,
    maxWidth: 600,
    maxHeight: 120,
  };
  return {
    kind: "GameDesignSpec",
    id: "direct-components",
    intent: "Compile each public direct declaration without a registry or injectable expander.",
    worldAuthoring: { mode: "none" },
    components: [
      {
        kind: "native_graph",
        id: "patch",
        graph: {
          kind: "studio_objects",
          operations: [
            {
              id: "folder",
              kind: "create",
              className: "Folder",
              parent: { kind: "engine", id: "Workspace" },
              name: "DirectObjects",
              properties: [],
              valueSlots: [],
              attributes: [],
              removedAttributes: [],
              dependencies: [],
            },
          ],
        },
        ports: [],
        obligations: [],
      },
      {
        kind: "native_graph",
        id: "collections",
        graph: {
          kind: "collections",
          templates: [
            {
              id: "vehicle",
              nodes: [
                {
                  id: "root",
                  name: "Vehicle",
                  className: "Model",
                  properties: [],
                  references: [
                    { propertyName: "PrimaryPart", target: { kind: "local", id: "body" } },
                  ],
                  valueSlots: [],
                  attributes: [],
                  dependencies: [],
                },
                {
                  id: "body",
                  name: "Body",
                  className: "Part",
                  parentId: "root",
                  properties: [],
                  references: [],
                  valueSlots: [],
                  attributes: [],
                  dependencies: [],
                },
              ],
            },
          ],
          copies: [
            {
              id: "shuttle",
              templateId: "vehicle",
              name: "Shuttle",
              parent: { kind: "engine", id: "Workspace" },
              overrides: [],
            },
          ],
          sharedReferences: [],
        },
        ports: [],
        obligations: [],
      },
      {
        kind: "native_graph",
        id: "lighting",
        graph: {
          kind: "lighting",
          rootName: "DirectLights",
          fixtures: [
            {
              id: "key",
              name: "KeyLight",
              position: { x: 0, y: 12, z: 0 },
              size: { x: 1, y: 1, z: 1 },
              light: {
                kind: "point",
                color: { r: 80, g: 220, b: 255 },
                brightness: 3,
                range: 24,
                enabled: true,
                shadows: true,
              },
            },
          ],
          atmosphere: {
            name: "DirectAtmosphere",
            color: { r: 180, g: 210, b: 220 },
            decay: { r: 70, g: 90, b: 110 },
            density: 0.2,
            offset: 0,
            haze: 1,
            glare: 0,
          },
        },
        ports: [],
        obligations: [],
      },
      {
        kind: "ui_graph",
        id: "ui",
        ui: {
          rootName: "DirectUI",
          tokens: {
            colors: [
              { id: "ink", value: { r: 8, g: 12, b: 20 } },
              { id: "paper", value: { r: 248, g: 244, b: 236 } },
            ],
            sizes: [
              { id: "body", value: 18 },
              { id: "radius", value: 8 },
            ],
            semanticColors: [
              { id: "surface", primitive: "ink" },
              { id: "content", primitive: "paper" },
            ],
            semanticSizes: [
              { id: "label", primitive: "body" },
              { id: "rounding", primitive: "radius" },
            ],
            styles: [
              {
                id: "label",
                background: "surface",
                foreground: "content",
                textSize: "label",
                cornerRadius: "rounding",
              },
            ],
          },
          nodes: [
            {
              id: "status",
              name: "Status",
              kind: "text",
              style: "label",
              text: "READY",
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
              insetTop: 30,
              insetRight: 0,
              insetBottom: 20,
            },
          ],
        },
        ports: [],
        obligations: [],
      },
      {
        kind: "source_package",
        id: "source",
        files: [
          {
            id: "controller",
            path: "Controller.luau",
            context: "shared",
            role: "module",
            content: { kind: "slot", maximumUtf8Bytes: 4096 },
            placement: {
              kind: "create",
              operationId: "install-controller",
              parent: {
                kind: "component_output",
                componentId: "collections",
                outputId: "copy/shuttle/root",
              },
              name: "Controller",
              className: "ModuleScript",
            },
            imports: [],
          },
        ],
        ports: [],
        obligations: [],
      },
    ],
    connections: [],
    artifactDependencies: [{ from: "source", to: "collections" }],
  };
}

test("direct component compilers preserve native editing, collection remapping, lighting, UI, and source placement", () => {
  const initialTopology = [
    engine("Workspace"),
    engine("Lighting"),
    engine("StarterGui"),
    engine("ReplicatedStorage"),
  ];
  const input = {
    design: design(),
    projectId: "direct-project",
    project: { name: "Direct", placeId: 0, universeId: 0 },
    initialTopology,
  };
  const expanded = expandGameDesign(input);
  const plan = compileGamePlan({
    ...input,
    ...expanded,
    sessionId: "direct-session",
    observedRevisionHash: contentHash("direct-revision"),
  });

  assert.deepEqual(plan.design.components.map((component) => component.kind).sort(), [
    "native_graph",
    "native_graph",
    "native_graph",
    "source_package",
    "ui_graph",
  ]);
  assert.equal(
    plan.inventory.some((item) => item.componentId === "patch"),
    true,
  );
  const model = plan.inventory.find(
    (item) => item.componentId === "collections" && item.outputId === "copy/shuttle/root",
  );
  const body = plan.inventory.find(
    (item) => item.componentId === "collections" && item.outputId === "copy/shuttle/body",
  );
  assert.ok(model && body);
  if (!model || !body || model.change.kind !== "create" || body.change.kind !== "create") return;
  const primaryPart = model.lockedProperties.PrimaryPart;
  assert.equal(primaryPart?.kind, "instance_ref");
  assert.ok(primaryPart?.kind === "instance_ref" && primaryPart.state === "reference");
  if (primaryPart?.kind !== "instance_ref" || primaryPart.state !== "reference") return;
  assert.equal(primaryPart.path, body.change.path);
  assert.equal(primaryPart.className, "Part");
  assert.equal(primaryPart.expectedClass, "BasePart");
  const source = plan.inventory.find((item) => item.id === "install-controller");
  assert.equal(source?.change.kind, "create");
  if (!source || source.change.kind !== "create") return;
  assert.equal(source.change.path, `${model.change.path}/Controller`);
  assert.equal(source?.dependencies.includes(model.id), true);
  assert.equal(
    plan.inventory.some(
      (item) =>
        item.componentId === "lighting" &&
        item.change.kind === "create" &&
        item.change.className === "Atmosphere" &&
        item.change.parent.kind === "engine_container" &&
        item.change.parent.path === "Lighting",
    ),
    true,
  );
  const uiRoot = plan.inventory.find(
    (item) => item.componentId === "ui" && item.outputId === "root",
  );
  assert.equal(uiRoot?.attributes.UiGraphAbi, "1");
  assert.equal(new Set(plan.inventory.map((item) => item.id)).size, plan.inventory.length);
});
