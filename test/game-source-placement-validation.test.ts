import assert from "node:assert/strict";
import test from "node:test";
import { CreatorDesignDraft } from "../packages/creator-session/src/design-draft.js";
import {
  projectCreatorGameComponentInput,
  validateCreatorGameComponent,
} from "../packages/creator-session/src/game-authoring.js";
import { CompositionError } from "../packages/game-composition/src/config-schema.js";
import type { GameDesignSpec, GamePlacementParent } from "../packages/game-ir/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
} from "../packages/studio-evidence/src/index.js";

function component(parents: GamePlacementParent[]): GameDesignSpec["components"][number] {
  return {
    kind: "source_package",
    id: "application",
    ports: [],
    obligations: [],
    files: parents.map((parent, index) => ({
      id: `file-${index}`,
      path: `Module${index}.luau`,
      role: "module",
      context: "shared",
      imports: [],
      content: { kind: "slot", maximumUtf8Bytes: 4096 },
      placement: {
        kind: "create",
        operationId: `install-${index}`,
        className: "ModuleScript",
        name: `Module${index}`,
        parent,
      },
    })),
  };
}
function draft() {
  return new CreatorDesignDraft({
    capabilities: {} as never,
    lockedSources: new Map(),
    visualSceneAuthority: { resolve: () => undefined },
    validateComponent: validateCreatorGameComponent,
  });
}
const valid = {
  kind: "engine_container" as const,
  className: "StarterPlayerScripts",
  path: "StarterPlayer/StarterPlayerScripts",
};

test("canonical source validation retains exact engine-pair authority diagnostics", () => {
  const value = component([
    { ...valid, path: "StarterPlayerScripts" },
    { kind: "engine_container", className: "ModuleScript", path: "ReplicatedStorage" },
    valid,
  ]);
  const saved = draft();
  const before = saved.snapshot();
  assert.throws(
    () => validateCreatorGameComponent(value),
    (error: unknown) => {
      assert.ok(error instanceof CompositionError);
      assert.equal(error.code, "invalid_source_placement");
      const diagnostics = JSON.parse(error.message);
      assert.equal(diagnostics.componentId, "application");
      assert.equal(diagnostics.manifestHash, STUDIO_CAPABILITY_MANIFEST_HASH);
      assert.deepEqual(
        diagnostics.issues.map((issue: { fileId: string; path: string }) => [
          issue.fileId,
          issue.path,
        ]),
        [
          ["file-0", "files[0].placement.parent"],
          ["file-1", "files[1].placement.parent"],
        ],
      );
      assert.deepEqual(diagnostics.issues[0].actual, {
        className: "StarterPlayerScripts",
        path: "StarterPlayerScripts",
      });
      assert.deepEqual(
        diagnostics.allowedEngineContainers,
        STUDIO_CAPABILITY_MANIFEST.authoringContainers.map(({ className, path }) => ({
          className,
          path,
        })),
      );
      return true;
    },
  );
  assert.throws(() => saved.define({ component: projectCreatorGameComponentInput(value) }));
  assert.deepEqual(saved.snapshot(), before);
  saved.define({
    component: projectCreatorGameComponentInput(component([valid])),
  });
  const retained = saved.snapshot();
  assert.throws(() =>
    saved.define({
      component: projectCreatorGameComponentInput(value),
    }),
  );
  assert.deepEqual(saved.snapshot(), retained);
});

test("source parent validation admits every exact engine pair and defers peer topology resolution", () => {
  assert.doesNotThrow(() =>
    validateCreatorGameComponent(
      component(
        STUDIO_CAPABILITY_MANIFEST.authoringContainers.map(({ className, path }) => ({
          kind: "engine_container",
          className,
          path,
        })),
      ),
    ),
  );
  const unresolved = component([
    { kind: "generated", operationId: "not-defined-yet" },
    { kind: "component_output", componentId: "future-scene", outputId: "root" },
    {
      kind: "instance",
      className: "Folder",
      path: "Workspace/Observed",
      identity: { kind: "forge_attribute", stableId: "observed" },
    },
  ]);
  assert.doesNotThrow(() =>
    draft().define({ component: projectCreatorGameComponentInput(unresolved) }),
  );
});

test("all offered engine paths resolve before retention and unknown or abbreviated paths fail closed", () => {
  const canonical = component(
    STUDIO_CAPABILITY_MANIFEST.authoringContainers.map(({ className, path }) => ({
      kind: "engine_container",
      className,
      path,
    })),
  );
  const saved = draft();
  saved.define({ component: projectCreatorGameComponentInput(canonical) });
  assert.deepEqual(saved.snapshot().components, [canonical]);
  const before = saved.snapshot();
  for (const path of ["StarterPlayerScripts", "Workspace/Unknown", "startergui", "StarterGui/"]) {
    const invalid = component([{ kind: "engine_container", className: "StarterGui", path }]);
    assert.throws(() =>
      saved.define({
        component: projectCreatorGameComponentInput(invalid),
      }),
    );
    assert.deepEqual(saved.snapshot(), before);
  }
});
