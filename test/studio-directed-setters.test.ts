import assert from "node:assert/strict";
import test from "node:test";
import {
  STUDIO_CAPABILITY_MANIFEST,
  assertStudioCapabilityManifest,
  sortedStudioMutationPropertyNames,
  derivedStudioMutationPropertyNames,
  compileMutationEvidenceProjection,
  type StudioManifestClass,
} from "../packages/studio-evidence/src/index.js";

const corner = STUDIO_CAPABILITY_MANIFEST.classes.find((entry) => entry.name === "UICorner")!;
const radii = ["BottomLeftRadius", "BottomRightRadius", "TopLeftRadius", "TopRightRadius"];
const radius = { kind: "udim" as const, scale: 0, offset: 12 };
test("direct effects cannot collide with another setter's family outputs", () => {
  const mixed: StudioManifestClass = {
    ...corner,
    properties: corner.properties.map((property) => ({
      ...property,
      ...(["TopRightRadius", "BottomRightRadius"].includes(property.name)
        ? { setterFamily: "test_pair", setterFamilySeed: "TopRightRadius" }
        : {}),
      ...(property.name === "TopLeftRadius"
        ? { setterEffects: ["BottomRightRadius", "CornerRadius"] }
        : {}),
    })),
  };
  assert.throws(
    () =>
      sortedStudioMutationPropertyNames(mixed, { TopLeftRadius: radius, TopRightRadius: radius }),
    /coupled property setters/,
  );
});
test("directed setters admit independent corners and reject overlapping writes", () => {
  assert.deepEqual(
    sortedStudioMutationPropertyNames(
      corner,
      Object.fromEntries(radii.map((name) => [name, radius])),
    ),
    radii,
  );
  for (const name of radii)
    assert.throws(
      () => sortedStudioMutationPropertyNames(corner, { CornerRadius: radius, [name]: radius }),
      /coupled property setters/,
    );
  assert.deepEqual(derivedStudioMutationPropertyNames(corner, { CornerRadius: radius }), radii);
  assert.deepEqual(derivedStudioMutationPropertyNames(corner, { TopLeftRadius: radius }), [
    "CornerRadius",
  ]);
  assert.deepEqual(derivedStudioMutationPropertyNames(corner, { TopRightRadius: radius }), []);
  assert.deepEqual(
    derivedStudioMutationPropertyNames(
      corner,
      Object.fromEntries(radii.map((name) => [name, radius])),
    ),
    ["CornerRadius"],
  );
  assert.ok(
    corner.properties.every((property) => property.setterFamilySeed === undefined),
    "No uniform seed may overwrite asymmetric detached state",
  );
});

test("directed setter projection includes native output obligations without invented values", () => {
  const projection = compileMutationEvidenceProjection({
    id: "corner-effects",
    purpose: "mutation_direct_readback",
    project: { name: "Corners", placeId: 0, universeId: 0 },
    binding: {
      sessionId: "corner-session",
      changeSetHash: "a".repeat(64),
      approvalHash: "b".repeat(64),
      revisionHash: "c".repeat(64),
      buildHash: "d".repeat(64),
      dashboardReviewHash: "e".repeat(64),
    },
    operations: [
      {
        id: "round-corners",
        kind: "update",
        target: {
          kind: "instance",
          path: "StarterGui/UI/Panel/Corner",
          className: "UICorner",
          identity: { kind: "forge_attribute", stableId: "corner" },
        },
        properties: { CornerRadius: radius },
      },
    ],
  });
  for (const name of radii) {
    const requirement = projection.requirements.find((entry) => entry.propertyName === name);
    assert.ok(requirement);
    assert.equal(requirement.expected, undefined);
  }
});

test("directed setter metadata rejects unknown, self, duplicate and unsorted outputs", () => {
  for (const effects of [
    [],
    ["Missing"],
    ["CornerRadius"],
    ["TopLeftRadius", "TopLeftRadius"],
    ["TopRightRadius", "TopLeftRadius"],
  ]) {
    const manifest = structuredClone(STUDIO_CAPABILITY_MANIFEST);
    const mutable = manifest.classes.find((entry) => entry.name === "UICorner")! as unknown as {
      properties: Array<
        StudioManifestClass["properties"][number] & { setterEffects?: readonly string[] }
      >;
    };
    mutable.properties.find((entry) => entry.name === "CornerRadius")!.setterEffects = effects;
    assert.throws(() => assertStudioCapabilityManifest(manifest), /setter effects/);
  }
});
