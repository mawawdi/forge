import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import {
  ROBLOX_API_CATALOG,
  ROBLOX_API_CATALOG_HASH,
  getRobloxApiClass,
  isRobloxClassAssignableTo,
  resolveRobloxClassMembers,
  validateRobloxApiCatalog,
} from "../packages/studio-evidence/src/index.js";

test("the pinned catalog is exhaustive, provenance-bound, and internally valid", () => {
  validateRobloxApiCatalog(ROBLOX_API_CATALOG);
  assert.equal(ROBLOX_API_CATALOG.contentHash, ROBLOX_API_CATALOG_HASH);
  assert.equal(ROBLOX_API_CATALOG.source.commit, "d025c96bdb1c81570221997092fbe0ad94b5337c");
  assert.equal(
    ROBLOX_API_CATALOG.source.sourceTreeHash,
    "6df2b67ba4e5fdc4d24f245ee159a64a6575d7eea37f0819107141dfc9716d04",
  );
  assert.deepEqual(ROBLOX_API_CATALOG.counts, {
    classes: 638,
    datatypes: 48,
    enums: 518,
    classProperties: 2864,
    classMethods: 1562,
    classEvents: 393,
    classCallbacks: 13,
    datatypeConstants: 11,
    datatypeConstructors: 102,
    datatypeFunctions: 8,
    datatypeMathOperations: 34,
    datatypeMethods: 80,
    datatypeProperties: 175,
    enumItems: 3003,
    globalProperties: 8,
    globalFunctions: 42,
    libraries: 11,
    libraryProperties: 10,
    libraryFunctions: 165,
  });
  const typeEntries =
    ROBLOX_API_CATALOG.counts.classes +
    ROBLOX_API_CATALOG.counts.datatypes +
    ROBLOX_API_CATALOG.counts.enums +
    ROBLOX_API_CATALOG.counts.libraries;
  const memberEntries =
    ROBLOX_API_CATALOG.counts.classProperties +
    ROBLOX_API_CATALOG.counts.classMethods +
    ROBLOX_API_CATALOG.counts.classEvents +
    ROBLOX_API_CATALOG.counts.classCallbacks +
    ROBLOX_API_CATALOG.counts.datatypeConstants +
    ROBLOX_API_CATALOG.counts.datatypeConstructors +
    ROBLOX_API_CATALOG.counts.datatypeFunctions +
    ROBLOX_API_CATALOG.counts.datatypeMathOperations +
    ROBLOX_API_CATALOG.counts.datatypeMethods +
    ROBLOX_API_CATALOG.counts.datatypeProperties +
    ROBLOX_API_CATALOG.counts.enumItems +
    ROBLOX_API_CATALOG.counts.globalProperties +
    ROBLOX_API_CATALOG.counts.globalFunctions +
    ROBLOX_API_CATALOG.counts.libraryProperties +
    ROBLOX_API_CATALOG.counts.libraryFunctions;
  assert.equal(typeEntries, 1215);
  assert.equal(memberEntries, 8470);
  assert.equal(typeEntries + memberEntries, 9685);
});

test("globals and standard libraries are first-class pinned catalog entries", () => {
  const workspace = ROBLOX_API_CATALOG.globalMembers.filter((entry) => entry.name === "workspace");
  assert.equal(workspace.length, 1);
  assert.equal(workspace[0]?.valueType, "Workspace");
  assert.equal(workspace[0]?.sourceFile, "globals/RobloxGlobals.yaml");

  const math = ROBLOX_API_CATALOG.libraries.find((entry) => entry.name === "math");
  assert.ok(math);
  const abs = math.members.find((entry) => entry.kind === "function" && entry.name === "abs");
  assert.deepEqual(abs?.parameters, [{ name: "x", type: "number" }]);
  assert.deepEqual(abs?.returns, [{ type: "number" }]);
  assert.equal(abs?.sourceFile, "libraries/math.yaml");
});

test("class queries resolve declared and inherited members without copying provenance", () => {
  const part = getRobloxApiClass("Part");
  assert.ok(part);
  assert.equal(isRobloxClassAssignableTo("Part", "BasePart"), true);
  assert.equal(isRobloxClassAssignableTo("BasePart", "Part"), false);
  assert.equal(isRobloxClassAssignableTo("NotAClass", "Instance"), false);
  const anchored = resolveRobloxClassMembers("Part", "property").find(
    (entry) => entry.name === "Anchored",
  );
  assert.ok(anchored);
  assert.equal(anchored.declaringClass, "BasePart");
  assert.equal(anchored.valueType, "boolean");
  assert.match(anchored.sourceFile, /^classes\//);
  const resolvedProperties = resolveRobloxClassMembers("Part", "property");
  assert.ok(resolvedProperties.some((entry) => entry.id === anchored.id));
});

test("datatype overloads and enum items remain distinct catalog entries", () => {
  const cframe = ROBLOX_API_CATALOG.datatypes.find((entry) => entry.name === "CFrame");
  assert.ok(cframe);
  const constructors = cframe.members.filter(
    (entry) => entry.kind === "constructor" && entry.name === "new",
  );
  assert.equal(constructors.length, 6);
  assert.equal(new Set(constructors.map((entry) => entry.id)).size, constructors.length);
  assert.ok(
    constructors.every((entry) => entry.id.startsWith("datatype_member:CFrame:constructor:new:")),
  );
  const material = ROBLOX_API_CATALOG.enums.find((entry) => entry.name === "Material");
  assert.ok(material);
  assert.equal(material.items.find((entry) => entry.name === "Plastic")?.value, 256);
});

test("the validator fails closed for malformed catalog data", () => {
  const malformed = JSON.parse(JSON.stringify(ROBLOX_API_CATALOG)) as {
    counts: { classes: number };
  };
  malformed.counts.classes -= 1;
  assert.throws(() => validateRobloxApiCatalog(malformed), /Invalid Roblox API catalog/);
});

test("catalog refresh refuses a source root that is not the pinned official checkout", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/generate-roblox-api-catalog.mjs"),
      "--refresh",
      "--source-root",
      resolve("."),
    ],
    {
      cwd: resolve("."),
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Official API source commit mismatch: expected d025c96bdb1c81570221997092fbe0ad94b5337c/,
  );
});
