import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GAME_ADMISSION_POLICY,
  gameVisualReviewStatements,
  validateGameDesignSpec,
  type GameDesignSpec,
} from "../packages/game-ir/src/index.js";
import { CreatorDesignDraft } from "../packages/creator-session/src/design-draft.js";
import {
  projectCreatorGameComponentInput,
  validateCreatorGameComponent,
} from "../packages/creator-session/src/game-authoring.js";

const options = { policy: DEFAULT_GAME_ADMISSION_POLICY };
function design(): GameDesignSpec {
  return {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "visual-experiment",
    intent: "Create an evolving visual installation.",
    connections: [],
    artifactDependencies: [],
    components: [
      {
        id: "installation",
        kind: "source_package",
        ports: [],
        obligations: [],
        files: [
          {
            id: "main",
            path: "Installation.luau",
            context: "client",
            role: "entrypoint",
            imports: [],
            content: { kind: "slot", maximumUtf8Bytes: 4096 },
            placement: {
              kind: "create",
              operationId: "create-installation",
              name: "Installation",
              className: "LocalScript",
              parent: {
                kind: "engine_container",
                path: "ReplicatedFirst",
                className: "ReplicatedFirst",
              },
            },
          },
        ],
      },
    ],
    visualDirection: {
      artDirection:
        "Large folded silhouettes frame the changing display; restrained bright accents mark selectable surfaces.",
      views: [
        {
          id: "arrival",
          name: "Arrival",
          componentIds: ["installation"],
          setup: "Open the installation before choosing a surface.",
          criteria: [
            "The selectable surface separates clearly from the background.",
            "The folded silhouette remains recognizable at phone size.",
          ],
          viewport: { width: 390, height: 844 },
          camera: {
            position: { x: 10, y: 5, z: 20 },
            lookAt: { x: 0, y: 2, z: 0 },
            fieldOfViewDegrees: 60,
          },
        },
      ],
    },
  };
}
function eligible(spec: unknown) {
  const result = validateGameDesignSpec(spec, options);
  assert.equal(result.status, "eligible", JSON.stringify(result));
  assert.ok(result.status === "eligible");
  return result;
}

test("visual direction survives the actual draft proposal and binds the canonical design without requiring a genre", () => {
  const spec = design();
  const draft = new CreatorDesignDraft({
    capabilities: {} as never,
    lockedSources: new Map(),
    visualSceneAuthority: { resolve: () => undefined },
    validateComponent: validateCreatorGameComponent,
  });
  const ref = draft.define({
    component: projectCreatorGameComponentInput(spec.components[0]!),
  });
  const { components: _components, ...metadata } = spec;
  const assembled = draft.assemble({ ...metadata, componentIds: [ref.componentId] });
  const result = eligible(assembled);
  assert.deepEqual(result.spec.visualDirection, spec.visualDirection);
  const changed = structuredClone(spec);
  changed.visualDirection!.artDirection = "Soft silhouettes and diffuse color.";
  assert.notEqual(eligible(changed).hash, result.hash);
  const { visualDirection: _direction, ...without } = spec;
  eligible(without);
  assert.deepEqual(gameVisualReviewStatements(undefined), []);
  assert.equal("round" in result.spec, false);
});

test("visual view identity is canonical while criteria order remains intentional", () => {
  const spec = design();
  spec.visualDirection!.views.push({
    id: "detail",
    name: "Detail",
    setup: "Select a surface.",
    criteria: ["Feedback follows the selection."],
    componentIds: ["installation"],
  });
  const initial = eligible(spec);
  spec.visualDirection!.views.reverse();
  assert.equal(eligible(spec).hash, initial.hash);
  spec.visualDirection!.views.find((view) => view.id === "arrival")!.criteria.reverse();
  assert.notEqual(eligible(spec).hash, initial.hash);
});

test("unbound views, duplicate identities, invalid viewport and degenerate camera reject before approval", () => {
  const mutations: Array<(spec: GameDesignSpec) => void> = [
    (spec) => {
      spec.visualDirection!.views[0]!.componentIds = ["absent"];
    },
    (spec) => {
      spec.visualDirection!.views[0]!.componentIds.push("installation");
    },
    (spec) => {
      spec.visualDirection!.views.push(structuredClone(spec.visualDirection!.views[0]!));
    },
    (spec) => {
      spec.visualDirection!.views[0]!.viewport!.width = 0;
    },
    (spec) => {
      const camera = spec.visualDirection!.views[0]!.camera!;
      camera.position = { ...camera.lookAt };
    },
    (spec) => {
      spec.visualDirection!.views[0]!.camera!.fieldOfViewDegrees = 180;
    },
    (spec) => {
      spec.visualDirection!.views[0]!.camera!.position.x = Infinity;
    },
  ];
  for (const mutate of mutations) {
    const spec = design();
    mutate(spec);
    assert.equal(validateGameDesignSpec(spec, options).status, "rejected");
  }
});

test("review statements retain framing and criteria but cannot certify rendered quality", () => {
  const result = eligible(design());
  const [statement] = gameVisualReviewStatements(result.spec.visualDirection);
  assert.match(statement!, /390×844/);
  assert.match(statement!, /field of view 60/);
  assert.match(statement!, /selectable surface separates/);
  assert.equal(result.scope, "composition_declarations");
  assert.equal("runtime_verified" in result, false);
  assert.equal("screenshot" in result, false);
});
