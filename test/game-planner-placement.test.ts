import assert from "node:assert/strict";
import test from "node:test";
import {
  creatorGameCatalog,
  creatorGameComponentSchema,
  projectCreatorGameComponentInput,
  resolveCreatorGameComponentInput,
} from "../packages/creator-session/src/game-authoring.js";
import type {
  GameSourceFile,
  GameSourcePackage,
  GameSourcePlacement,
} from "../packages/game-ir/src/index.js";

const schema = creatorGameComponentSchema(await creatorGameCatalog());
const target = (className: string) => ({
  kind: "instance" as const,
  identity: { kind: "forge_attribute" as const, stableId: "inspected-source" },
  path: "ReplicatedStorage/Module",
  className,
});
function file(placement: GameSourcePlacement): GameSourceFile {
  return {
    id: "implementation",
    path: "Implementation.luau",
    role: "module",
    context: "shared",
    content: { kind: "slot", maximumUtf8Bytes: 4096 },
    imports: [],
    placement,
  };
}
const component = (source: GameSourceFile): GameSourcePackage => ({
  kind: "source_package",
  id: "implementation",
  ports: [],
  obligations: [],
  files: [source],
});

test("planner edits retain exact observed source classes and matching role/context checks", () => {
  let cases = 0;
  for (const className of ["ModuleScript", "Script", "LocalScript"] as const)
    for (const role of ["module", "entrypoint"] as const)
      for (const context of ["server", "client", "shared"] as const) {
        const source = file({
          kind: "edit_source",
          operationId: "edit-source",
          target: target(className),
          beforeSourceHash: "a".repeat(64),
          beforeSourceBytes: 24,
        });
        source.role = role;
        source.context = context;
        const accepted =
          (role === "module" && className === "ModuleScript") ||
          (role === "entrypoint" &&
            ((context === "server" && className === "Script") ||
              (context === "client" && className === "LocalScript")));
        assert.equal(
          schema.safeParse(component(source)).success,
          accepted,
          `${role}/${context}/${className}`,
        );
        cases++;
      }
  assert.equal(cases, 18);
});

test("new source classes derive only from role/context and stale redundant fields reject", () => {
  for (const role of ["module", "entrypoint"] as const)
    for (const context of ["server", "client", "shared"] as const) {
      const source = file({
        kind: "create",
        operationId: "install-source",
        className: "LocalScript",
        name: "Implementation",
        parent: { kind: "engine_container", path: "StarterGui", className: "StarterGui" },
      });
      source.role = role;
      source.context = context;
      const input = projectCreatorGameComponentInput(component(source));
      const parsed = schema.safeParse(input);
      assert.equal(parsed.success, role === "module" || context !== "shared");
      if (!parsed.success) continue;
      const resolved = resolveCreatorGameComponentInput(parsed.data);
      assert.ok(resolved.kind === "source_package");
      const placement = resolved.files[0]!.placement;
      assert.ok(placement?.kind === "create");
      assert.equal(
        placement.className,
        role === "module" ? "ModuleScript" : context === "server" ? "Script" : "LocalScript",
      );
      assert.deepEqual(placement.parent, {
        kind: "engine_container",
        path: "StarterGui",
        className: "StarterGui",
      });
      for (const className of ["ModuleScript", "Script", "LocalScript"]) {
        const stale = structuredClone(input);
        assert.ok(stale.kind === "source_package");
        Object.assign(stale.files[0]!.placement, { className });
        assert.equal(schema.safeParse(stale).success, false);
      }
      const staleParent = structuredClone(input);
      assert.ok(staleParent.kind === "source_package");
      const inputPlacement = staleParent.files[0]!.placement;
      assert.ok(inputPlacement.kind === "create");
      Object.assign(inputPlacement.parent, { className: "StarterGui" });
      assert.equal(schema.safeParse(staleParent).success, false);
    }
});

test("planner observed source alternatives require an exact locked module and an explicit placement", () => {
  const source = file({ kind: "observed", target: target("ModuleScript") });
  assert.equal(
    schema.safeParse(component(source)).success,
    false,
    "Observed source cannot be a slot",
  );
  source.content = { kind: "locked", sourceHash: "b".repeat(64), utf8Bytes: 24 };
  for (const context of ["server", "client", "shared"] as const) {
    source.context = context;
    assert.equal(schema.safeParse(component(source)).success, true);
  }
  source.context = "client";
  source.role = "entrypoint";
  assert.equal(schema.safeParse(component(source)).success, false);
  source.role = "module";
  source.placement = { kind: "observed", target: target("LocalScript") };
  assert.equal(schema.safeParse(component(source)).success, false);
  delete source.placement;
  assert.equal(schema.safeParse(component(source)).success, false);
});
