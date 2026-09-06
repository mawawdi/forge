import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import test from "node:test";
import {
  analyzeStudioSourcesWithRobloxLuau,
  analyzeWithRobloxLuau,
} from "../packages/luau-toolchain/src/index.js";

test("module import feedback identifies the analyzer cast limitation without weakening module types", () => {
  const analyze = (source: string) =>
    analyzeStudioSourcesWithRobloxLuau({
      nodes: [{ studioPath: "ReplicatedStorage/Shared", className: "Folder" }],
      sources: [
        {
          id: "module",
          studioPath: "ReplicatedStorage/Shared/Protocol",
          className: "ModuleScript",
          source: "return { version = 1 }",
        },
        { id: "server", studioPath: "ServerScriptService/Main", className: "Script", source },
      ],
    });
  const importLine =
    'local protocol = require(game:GetService("ReplicatedStorage"):WaitForChild("Shared"):WaitForChild("Protocol"))';
  assert.equal(analyze(importLine + "\nprint(protocol.version)").tiers[1].status, "pass");
  assert.equal(
    analyze(importLine + "\nlocal invalid: string = protocol.version\nprint(invalid)").tiers[1]
      .status,
    "fail",
  );
  const cast = importLine.replace('"Protocol"))', '"Protocol") :: ModuleScript)');
  assert.ok(
    analyze(cast).issues.some(
      (issue) =>
        issue.message.includes("without :: casts") && issue.message.includes("do not duplicate"),
    ),
  );
});

test("Studio candidates retain strict API analysis through optional instance refinement", () => {
  const source = [
    "local function nearby(root: BasePart?, target: Vector3): boolean",
    "  if root == nil then return false end",
    "  return (root.Position - target):Magnitude() <= 12",
    "end",
    "print(nearby)",
  ].join("\n");
  const analyze = (text: string) =>
    analyzeStudioSourcesWithRobloxLuau({
      nodes: [{ studioPath: "ServerScriptService/RangeCheck", className: "Script" }],
      sources: [
        {
          id: "range",
          studioPath: "ServerScriptService/RangeCheck",
          className: "Script",
          source: text,
        },
      ],
    });
  const invalid = analyze(source);
  assert.equal(invalid.tiers[1].status, "fail");
  assert.ok(
    invalid.issues.some(
      (issue) =>
        issue.ruleId === "LUAU_TYPE_ERROR" &&
        issue.path === "ServerScriptService/RangeCheck" &&
        issue.location?.line === 3 &&
        issue.message.includes("Cannot call a value of type number"),
    ),
  );
  const corrected = analyze(source.replace(":Magnitude()", ".Magnitude"));
  assert.equal(corrected.tiers[1].status, "pass");
});

test("characterization: a DataModel lookup needs an explicit type for this property check", () => {
  const analyze = (source: string) =>
    analyzeStudioSourcesWithRobloxLuau({
      nodes: [{ studioPath: "Workspace/Probe", className: "Part" }],
      sources: [
        { id: "main", studioPath: "ServerScriptService/Main", className: "Script", source },
      ],
    });
  const lookup = 'workspace:WaitForChild("Probe")';
  // The pinned analyzer still accepts this invalid assignment despite the
  // complete sourcemap. Do not treat an inferred lookup as verified Part typing.
  assert.equal(analyze(`local probe = ${lookup}\nprobe.Size = "wrong"`).tiers[1].status, "pass");
  const invalid = analyze(`local probe: Part = ${lookup}\nprobe.Size = "wrong"`);
  assert.equal(invalid.tiers[1].status, "fail");
  assert.ok(
    invalid.issues.some(
      (issue) =>
        issue.ruleId === "LUAU_TYPE_ERROR" &&
        issue.path === "ServerScriptService/Main" &&
        issue.location?.line === 2 &&
        issue.message.includes("Vector3"),
    ),
  );
  assert.equal(
    analyze(
      'local probe: Part = workspace:WaitForChild("Probe")\nprobe.Size = Vector3.new(1, 2, 3)',
    ).tiers[1].status,
    "pass",
  );
});

test("characterization: a source nocheck directive overrides the host strict default", () => {
  const analyze = (source: string) =>
    analyzeStudioSourcesWithRobloxLuau({
      nodes: [],
      sources: [
        { id: "main", studioPath: "ServerScriptService/Main", className: "Script", source },
      ],
    });
  const source = 'local value: number = "wrong"\nprint(value)';
  assert.equal(analyze(source).tiers[1].status, "fail");
  // This records a limitation, not evidence that the same code is type-safe.
  const suppressed = analyze(`--!nocheck\n${source}`);
  assert.equal(suppressed.tiers[1].status, "pass");
  assert.equal(
    suppressed.issues.some((issue) => issue.ruleId === "LUAU_TYPE_ERROR"),
    false,
  );
});

test("imported and directly analyzed Studio module errors have one canonical identity", () => {
  const result = analyzeStudioSourcesWithRobloxLuau({
    nodes: [],
    sources: [
      {
        id: "server",
        studioPath: "ServerScriptService/GameServer",
        className: "Script",
        source:
          'local model = require(game:GetService("ServerScriptService"):WaitForChild("RunModel"))\nprint(model)',
      },
      {
        id: "run",
        studioPath: "ServerScriptService/RunModel",
        className: "ModuleScript",
        source: "local model = {}\nfunction model.step()\n  return RunModel\nend\nreturn model",
      },
    ],
  });
  const errors = result.issues.filter((issue) => issue.message.includes("Unknown global"));
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.equal(errors[0]?.path, "ServerScriptService/RunModel");
  assert.equal(result.tiers[1].status, "fail");
  for (const tier of result.tiers) assert.equal(new Set(tier.issueIds).size, tier.issueIds.length);
});

test("Studio diagnostic aliases require both the generated file and its exact mapped path", () => {
  withFakeToolchain(({ writeTool }) => {
    writeTool(
      "lsp",
      [
        'const file = process.argv.find((argument) => argument.endsWith("_run.luau"));',
        'const diagnostic = ":38.10-38.18: TypeError: Unknown global RunModel\\n";',
        "process.stderr.write(file + diagnostic);",
        'process.stderr.write(file + " [game/ServerScriptService/RunModel]" + diagnostic);',
        'process.stderr.write(file + " [game/ServerScriptService/Other]" + diagnostic);',
        'process.stderr.write(file.replace("_run.luau", "_unknown.luau") + " [game/ServerScriptService/RunModel]" + diagnostic);',
        'process.stderr.write("/untrusted/" + require("node:path").basename(file) + " [game/ServerScriptService/RunModel]" + diagnostic);',
        "process.exit(1);",
      ].join("\n"),
    );
    const result = analyzeStudioSourcesWithRobloxLuau({
      nodes: [],
      sources: [
        {
          id: "run",
          studioPath: "ServerScriptService/RunModel",
          className: "ModuleScript",
          source: "return {}",
        },
      ],
    });
    assert.equal(result.issues.length, 4);
    assert.equal(
      result.issues.filter((issue) => issue.path === "ServerScriptService/RunModel").length,
      1,
    );
    assert.ok(
      result.issues.some((issue) => issue.path?.includes("[game/ServerScriptService/Other]")),
    );
    assert.ok(result.issues.some((issue) => issue.path?.includes("_unknown.luau [game/")));
    assert.ok(result.issues.some((issue) => issue.path?.startsWith("/untrusted/")));
    assert.deepEqual(
      result.tiers[1].issueIds,
      result.issues.map((issue) => issue.id),
    );
  });
});

for (const [tool, ruleId, completedSyntax] of [
  ["compile", "LUAU_SYNTAX_TOOL_TIMEOUT", false],
  ["rojo", "ROBLOX_SOURCEMAP_TOOL_TIMEOUT", true],
  ["lsp", "ROBLOX_TYPE_TOOL_TIMEOUT", true],
] as const) {
  test(`${tool} timeout is incomplete and does not promote partial source diagnostics`, () => {
    withFakeToolchain(({ root, writeTool }) => {
      writeTool(
        tool,
        [
          'process.on("SIGTERM", () => {});',
          'require("node:fs").writeSync(2, "Candidate.luau(1,1): SyntaxError: partial\\nCandidate.luau:1.1: TypeError: partial\\n");',
          "while (true) {}",
        ].join("\n"),
      );
      const started = performance.now();
      const result = analyzeWithRobloxLuau(root, ["Candidate.luau"], { deadlineMs: 250 });
      assert.ok(
        performance.now() - started < 2_500,
        "SIGTERM-resistant tool must be killed promptly",
      );
      assert.equal(result.tiers[0].status, completedSyntax ? "pass" : "unavailable");
      assert.equal(result.tiers[1].status, "unavailable");
      assert.deepEqual(
        result.issues.map((issue) => issue.ruleId),
        [ruleId],
      );
      assert.ok(result.issues.every((issue) => issue.category === "tooling"));
      assert.match(result.stderr, /partial/);
      assert.ok(
        result.tools.some(
          (entry) =>
            entry.name ===
            (tool === "compile"
              ? "luau-compile"
              : tool === "rojo"
                ? "rojo-sourcemap"
                : "luau-lsp-roblox"),
        ),
      );
    });
  });
}

test("compiler files share one deadline and stop launching work when it expires", () => {
  withFakeToolchain(({ root, writeTool }) => {
    const calls = resolve(root, "calls.txt");
    writeTool(
      "compile",
      [
        `require("node:fs").appendFileSync(${JSON.stringify(calls)}, "called\\n");`,
        "const until = performance.now() + 120; while (performance.now() < until) {}",
      ].join("\n"),
    );
    const files = Array.from({ length: 4 }, (_, index) => `${index}.luau`);
    for (const file of files) writeFileSync(resolve(root, file), "return 1");
    const result = analyzeWithRobloxLuau(root, files, { deadlineMs: 250 });
    assert.equal(result.tiers[0].status, "unavailable");
    assert.equal(result.issues[0]?.ruleId, "LUAU_SYNTAX_TOOL_TIMEOUT");
    const count = readFileSync(calls, "utf8").trim().split("\n").length;
    assert.ok(
      count > 0 && count < files.length,
      "per-file timeout resets would allow all files to finish",
    );
  });
});

test("a killed analyzer is a tooling failure even after it emitted a language diagnostic", () => {
  withFakeToolchain(({ root, writeTool }) => {
    writeTool(
      "lsp",
      'require("node:fs").writeSync(2, "Candidate.luau:1.1: TypeError: partial\\n"); process.kill(process.pid, "SIGKILL");',
    );
    const result = analyzeWithRobloxLuau(root, ["Candidate.luau"]);
    assert.equal(result.tiers[1].status, "unavailable");
    assert.deepEqual(
      result.issues.map((issue) => issue.ruleId),
      ["ROBLOX_TYPE_TOOL_SIGNAL"],
    );
  });
});

test("a completed analyzer keeps genuine source errors distinct from tool failures", () => {
  withFakeToolchain(({ root, writeTool }) => {
    writeTool(
      "lsp",
      'require("node:fs").writeSync(2, "Candidate.luau:1.1: TypeError: complete diagnostic\\n"); process.exit(1);',
    );
    const result = analyzeWithRobloxLuau(root, ["Candidate.luau"]);
    assert.equal(result.tiers[1].status, "fail");
    assert.deepEqual(
      result.issues.map((issue) => issue.ruleId),
      ["LUAU_TYPE_ERROR"],
    );
  });
});

test("compiler launch failure is incomplete and preserves the executable record", () => {
  withFakeToolchain(({ root, writeTool }) => {
    const executable = writeTool("compile", "process.exit(0);");
    chmodSync(executable, 0o600);
    const result = analyzeWithRobloxLuau(root, ["Candidate.luau"]);
    assert.equal(result.tiers[0].status, "unavailable");
    assert.equal(result.issues[0]?.ruleId, "LUAU_SYNTAX_TOOL_PROCESS_ERROR");
    assert.equal(result.tools[0]?.name, "luau-compile");
  });
});

test("malformed sourcemap output is a tooling failure", () => {
  withFakeToolchain(({ root, writeTool }) => {
    writeTool("rojo", 'require("node:fs").writeFileSync(process.argv.at(-1), "{broken");');
    const result = analyzeWithRobloxLuau(root, ["Candidate.luau"]);
    assert.equal(result.tiers[1].status, "unavailable");
    assert.equal(result.issues[0]?.category, "tooling");
    assert.match(result.issues[0]?.message ?? "", /invalid JSON sourcemap/);
  });
});

test("host deadline policy is bound into tool identity", () => {
  withFakeToolchain(({ root }) => {
    const first = analyzeWithRobloxLuau(root, ["Candidate.luau"], { deadlineMs: 10_000 });
    const repeated = analyzeWithRobloxLuau(root, ["Candidate.luau"], { deadlineMs: 10_000 });
    const changed = analyzeWithRobloxLuau(root, ["Candidate.luau"], { deadlineMs: 20_000 });
    assert.deepEqual(first.tools, repeated.tools);
    assert.equal(first.tools.length, 4);
    for (const tool of first.tools.filter((entry) => entry.name !== "roblox-global-types"))
      assert.notEqual(
        tool.configHash,
        changed.tools.find((entry) => entry.name === tool.name)?.configHash,
      );
  });
});

test("PATH lookup skips non-executable files and explicit tool paths retain precedence", () => {
  withFakeToolchain(({ root }) => {
    const first = resolve(root, "first");
    const second = resolve(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(resolve(first, "luau-compile"), "not executable", { mode: 0o600 });
    writeFileSync(resolve(second, "luau-compile"), `#!${process.execPath}\nprocess.exit(0);\n`, {
      mode: 0o700,
    });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = [first, second].join(delimiter);
      const configured = analyzeWithRobloxLuau(root, ["Candidate.luau"]);
      assert.equal(configured.tiers[0].status, "pass");
      delete process.env.FORGE_LUAU_COMPILE;
      const fromPath = analyzeWithRobloxLuau(root, ["Candidate.luau"]);
      assert.equal(fromPath.tiers[0].status, "pass");
      assert.notEqual(configured.tools[0]?.configHash, fromPath.tools[0]?.configHash);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

function withFakeToolchain(
  run: (fixture: {
    root: string;
    writeTool: (name: "compile" | "rojo" | "lsp", source: string) => string;
  }) => void,
): void {
  const root = mkdtempSync(resolve(tmpdir(), "forge-analysis-process-test-"));
  const names = { compile: "FORGE_LUAU_COMPILE", rojo: "FORGE_ROJO", lsp: "FORGE_LUAU_LSP" };
  const previous = Object.fromEntries(
    Object.values(names).map((name) => [name, process.env[name]]),
  );
  const writeTool = (name: keyof typeof names, source: string) => {
    const path = resolve(root, `${name}.cjs`);
    writeFileSync(
      path,
      `#!${process.execPath}\nif (process.argv[2] === "--fixture-warmup") process.exit(0);\n${source}\n`,
      { mode: 0o700 },
    );
    // macOS may inspect a newly written executable before its first launch.
    // Finish that host work before exercising a deliberately short deadline.
    const warmup = spawnSync(path, ["--fixture-warmup"], {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    assert.equal(warmup.status, 0, warmup.stderr);
    process.env[names[name]] = path;
    return path;
  };
  try {
    writeFileSync(resolve(root, "Candidate.luau"), "return 1");
    writeTool("compile", "process.exit(0);");
    writeTool(
      "rojo",
      'require("node:fs").writeFileSync(process.argv.at(-1), JSON.stringify({ name: "DataModel", className: "DataModel", children: [] }));',
    );
    writeTool("lsp", "process.exit(0);");
    run({ root, writeTool });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}
