import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import { UI_CONTROLLER_SOURCE } from "../packages/game-composition/src/index.js";
import {
  forgeRuntimeSourcePackage,
  loadForgeRuntimeBundle,
} from "../packages/game-runtime/src/index.js";

const runtimeRoot = resolve("packages/game-runtime");

test("ForgeRuntime remains an exact direct source dependency with no registry lifecycle", async () => {
  const bundle = await loadForgeRuntimeBundle({ root: runtimeRoot });
  assert.equal(bundle.abi, "forge-runtime@2");
  assert.deepEqual(bundle.provenance.thirdPartyDependencies, []);
  assert.equal(
    bundle.provenance.licenseHash,
    contentHash(await readFile(join(runtimeRoot, "LICENSE"), "utf8")),
  );
  const material = forgeRuntimeSourcePackage(bundle, {
    componentId: "forge-runtime",
    operationPrefix: "forge-runtime",
    parent: { kind: "component_output", componentId: "runtime-root", outputId: "root" },
    rootPath: "ReplicatedStorage/Packages/ForgeRuntime",
  });
  assert.equal(material.component.kind, "source_package");
  assert.deepEqual(
    material.component.files.map((file) => file.id),
    ["event", "network", "scope", "state-machine", "task"],
  );
  for (const file of material.component.files) {
    assert.equal(file.content.kind, "locked");
    const source = material.sources.find((entry) => entry.fileId === file.id);
    assert.ok(source);
    if (file.content.kind === "locked" && source) {
      assert.equal(contentHash(source.source), file.content.sourceHash);
      assert.equal(Buffer.byteLength(source.source), file.content.utf8Bytes);
    }
  }
});

test("retained direct runtime and geometry Luau harnesses execute through fixed local runners", () => {
  const cases = [
    {
      command: "luau",
      args: ["test/runtime-modules.luau"],
      expected: /ForgeRuntime real Luau tests passed: 12/,
    },
    {
      command: "lune",
      args: ["run", "test/runtime-network.luau"],
      expected: /Network runtime tests passed: 10/,
    },
    {
      command: "luau",
      args: ["test/runtime-task-immediate.luau"],
      expected: /ForgeRuntime immediate Task tests passed: 7/,
    },
    {
      command: "lune",
      args: ["run", "test/game-scene-geometry.luau"],
      expected: /\[/,
    },
  ] as const;
  for (const fixture of cases) {
    const result = spawnSync(fixture.command, fixture.args, {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, fixture.expected);
  }
});

test("the pinned direct UI controller passes type analysis and its real offline lifecycle suite", async () => {
  const temp = await mkdtemp(join(tmpdir(), "forge-direct-ui-controller-"));
  try {
    const nativeSource = join(temp, "NativeController.luau");
    await writeFile(nativeSource, UI_CONTROLLER_SOURCE);
    const analyzed = spawnSync(
      "luau-lsp",
      [
        "analyze",
        "--no-strict-dm-types",
        "--definitions",
        "packages/luau-toolchain/roblox/globalTypes.d.luau",
        nativeSource,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(analyzed.error, undefined);
    assert.equal(analyzed.status, 0, analyzed.stdout + analyzed.stderr);
    await writeFile(
      join(temp, "UiEnvironment.luau"),
      await readFile("test/ui-controller-environment.luau"),
    );
    await writeFile(
      join(temp, "Controller.luau"),
      'local environment = require("./UiEnvironment")\nlocal game = environment.game\nlocal TweenInfo = environment.TweenInfo\nlocal Enum = environment.Enum\nlocal Color3 = environment.Color3\n' +
        UI_CONTROLLER_SOURCE,
    );
    await writeFile(join(temp, "Fixture.luau"), await readFile("test/ui-controller-runtime.luau"));
    const result = spawnSync("luau", [join(temp, "Fixture.luau")], {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /UI controller contract cases passed; fake engine, no native claims/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
