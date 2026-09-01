import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import {
  ROBLOX_API_CATALOG,
  ROBLOX_API_CATALOG_HASH,
  getRobloxApiClass,
  getRobloxApiDatatype,
  getRobloxApiEnum,
  isRobloxClassAssignableTo,
  loadRobloxApiCatalog,
  resolveRobloxClassMember,
  resolveRobloxClassMembers,
  validateRobloxApiCatalog,
} from "../packages/studio-evidence/src/index.js";

test("the pinned catalog is exhaustive, provenance-bound, and internally valid", () => {
  validateRobloxApiCatalog(ROBLOX_API_CATALOG);
  assert.equal(ROBLOX_API_CATALOG.contentHash, ROBLOX_API_CATALOG_HASH);
  assert.equal(ROBLOX_API_CATALOG.source.commit, "529a24ff2aa9896dad50fc12268717210ba3127d");
  assert.equal(ROBLOX_API_CATALOG.source.sourceTreeHash, "b62066ef0fa92c4be5f8a6e0681cd899b4a88a30571a410900a75de98a987315");
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
  });
  const typeEntries = ROBLOX_API_CATALOG.counts.classes + ROBLOX_API_CATALOG.counts.datatypes + ROBLOX_API_CATALOG.counts.enums;
  const memberEntries = ROBLOX_API_CATALOG.counts.classProperties + ROBLOX_API_CATALOG.counts.classMethods + ROBLOX_API_CATALOG.counts.classEvents + ROBLOX_API_CATALOG.counts.classCallbacks + ROBLOX_API_CATALOG.counts.datatypeConstants + ROBLOX_API_CATALOG.counts.datatypeConstructors + ROBLOX_API_CATALOG.counts.datatypeFunctions + ROBLOX_API_CATALOG.counts.datatypeMathOperations + ROBLOX_API_CATALOG.counts.datatypeMethods + ROBLOX_API_CATALOG.counts.datatypeProperties + ROBLOX_API_CATALOG.counts.enumItems;
  assert.equal(typeEntries, 1204);
  assert.equal(memberEntries, 8245);
  assert.equal(typeEntries + memberEntries, 9449);
});

test("class queries resolve declared and inherited members without copying provenance", () => {
  const part = getRobloxApiClass("Part");
  assert.ok(part);
  assert.equal(isRobloxClassAssignableTo("Part", "BasePart"), true);
  assert.equal(isRobloxClassAssignableTo("BasePart", "Part"), false);
  assert.equal(isRobloxClassAssignableTo("NotAClass", "Instance"), false);
  const anchored = resolveRobloxClassMember("Part", "property", "Anchored");
  assert.ok(anchored);
  assert.equal(anchored.declaringClass, "BasePart");
  assert.equal(anchored.valueType, "boolean");
  assert.match(anchored.sourceFile, /^classes\//);
  const resolvedProperties = resolveRobloxClassMembers("Part", "property");
  assert.ok(resolvedProperties.some((entry) => entry.id === anchored.id));
});

test("datatype overloads and enum items remain distinct catalog entries", () => {
  const cframe = getRobloxApiDatatype("CFrame");
  assert.ok(cframe);
  const constructors = cframe.members.filter((entry) => entry.kind === "constructor" && entry.name === "new");
  assert.equal(constructors.length, 6);
  assert.equal(new Set(constructors.map((entry) => entry.id)).size, constructors.length);
  assert.ok(constructors.every((entry) => entry.id.startsWith("datatype_member:CFrame:constructor:new:")));
  const material = getRobloxApiEnum("Material");
  assert.ok(material);
  assert.equal(material.items.find((entry) => entry.name === "Plastic")?.value, 256);
});

test("the validator fails closed for malformed catalog data", () => {
  const malformed = JSON.parse(JSON.stringify(ROBLOX_API_CATALOG)) as { counts: { classes: number } };
  malformed.counts.classes -= 1;
  assert.throws(() => loadRobloxApiCatalog(malformed), /Invalid Roblox API catalog/);
});

test("offline catalog check accepts the committed generated artifacts", () => {
  execFileSync(process.execPath, [resolve("scripts/generate-roblox-api-catalog.mjs"), "--check"], { cwd: resolve("."), stdio: "pipe" });
});
