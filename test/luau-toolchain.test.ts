import assert from "node:assert/strict";
import test from "node:test";
import { analyzeStudioSourcesWithRobloxLuau } from "../packages/luau-toolchain/src/index.js";

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
