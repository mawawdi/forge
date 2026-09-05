import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  creatorBuilderObservationPage,
  type CreatorBuildContract,
  type CreatorProjectIndexView,
} from "../packages/creator-session/src/index.js";

const revisionHash = contentHash("observed-project");
const index: CreatorProjectIndexView = {
  project: { name: "Observed", placeId: 0, universeId: 0 },
  revision: { hash: revisionHash } as CreatorProjectIndexView["revision"],
  scripts: [],
  instances: [
    {
      objectId: "forge_attribute:part",
      identity: { kind: "forge_attribute", stableId: "part" },
      path: "Workspace/Part",
      name: "Part",
      className: "Part",
      tags: ["landmark"],
      attributes: { Purpose: "entry" },
      properties: {
        Color: { kind: "color3_rgb8", r: 128, g: 64, b: 255 },
        Material: { kind: "enum_name", value: "Wood" },
        Anchored: { kind: "boolean", value: true },
        CanCollide: { kind: "boolean", value: false },
      },
    },
    {
      objectId: "forge_attribute:other",
      identity: { kind: "forge_attribute", stableId: "other" },
      path: "Workspace/Other",
      name: "Other",
      className: "Part",
      tags: [],
      attributes: { Private: "outside approved observations" },
      properties: {},
    },
  ],
};
const contract = {
  initialRevisionHash: revisionHash,
  initialInspectionPaths: ["Workspace/Part"],
} as CreatorBuildContract;

test("bounded observation pages retain visual and physics facts instead of a GUI property whitelist", () => {
  const facts: Array<{ field: string; value: unknown }> = [];
  let cursor: string | undefined;
  do {
    const page = creatorBuilderObservationPage(
      index,
      contract,
      { objectId: "forge_attribute:part", revisionHash, ...(cursor ? { cursor } : {}) },
      120,
    );
    assert.ok(Buffer.byteLength(stableJson(page.facts), "utf8") <= 120);
    assert.ok(page.facts.length > 0);
    facts.push(...page.facts);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(Object.fromEntries(facts.map((fact) => [fact.field, fact.value])), {
    "attribute:Purpose": "entry",
    "property:Anchored": true,
    "property:CanCollide": false,
    "property:Color": { r: 128 / 255, g: 64 / 255, b: 1 },
    "property:Material": "Wood",
    tags: ["landmark"],
  });
  assert.doesNotMatch(stableJson(facts), /outside approved/);
});

test("observation retrieval binds revision, approved object, cursor and requested fields", () => {
  const request = { objectId: "forge_attribute:part", revisionHash };
  const first = creatorBuilderObservationPage(index, contract, request, 100);
  assert.ok(first.nextCursor);
  assert.throws(
    () =>
      creatorBuilderObservationPage(index, contract, { ...request, revisionHash: "f".repeat(64) }),
    /revision/,
  );
  assert.throws(
    () =>
      creatorBuilderObservationPage(index, contract, {
        ...request,
        objectId: "forge_attribute:other",
      }),
    /approved/,
  );
  assert.throws(
    () =>
      creatorBuilderObservationPage(index, contract, {
        ...request,
        cursor: first.nextCursor!,
        fields: ["property:Color"],
      }),
    /cursor/,
  );
  assert.throws(
    () =>
      creatorBuilderObservationPage(index, contract, { ...request, fields: ["property:Missing"] }),
    /exist/,
  );
  assert.deepEqual(
    creatorBuilderObservationPage(index, contract, { ...request, fields: ["property:Material"] })
      .facts,
    [{ field: "property:Material", value: "Wood" }],
  );
});
