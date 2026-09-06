import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  CREATOR_DEFAULT_RESOURCE_POLICY,
  STUDIO_CAPABILITY_COVERAGE_REPORT,
  STUDIO_CAPABILITY_COVERAGE_REPORT_HASH,
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  STUDIO_CREATOR_MUTATION_BINDING_SCHEMA,
  STUDIO_EVIDENCE_VECTORS,
  STUDIO_CODECS,
  getRobloxApiCatalogLookupEntry,
  lookupRobloxApiCatalog,
  assertEvidenceAgainstProjection,
  assertStudioCapabilityManifest,
  assertStudioEvidenceEnvelope,
  assertStudioEvidenceFact,
  assertStudioValueForProperty,
  canonicalStudioValue,
  canonicalStudioValueMaterial,
  compileMutationEvidenceProjection,
  createStudioEvidenceEnvelope,
  createStudioEvidenceProjection,
  isStudioCreatorMutationBinding,
  matchesStudioCreatorMutationBinding,
  studioEvidenceEnvelopeHash,
  studioEvidenceFactKey,
  studioValuesEqual,
  sortedStudioMutationPropertyNames,
  type StudioCapabilityManifest,
  type StudioEvidenceFact,
  type StudioEvidenceTarget,
  type StudioValue,
} from "../packages/studio-evidence/src/index.js";

const project = { name: "Evidence Test", placeId: 7, universeId: 11 };
const target: Extract<StudioEvidenceTarget, { readonly kind: "instance" }> = {
  kind: "instance",
  identity: { kind: "forge_attribute", stableId: "part-1" },
  path: "Workspace/Door/Prompt",
  className: "ProximityPrompt",
};
const interval = {
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.000Z",
};

test("generation rejects missing codec mappings before any model or Studio run", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "forge-codec-coverage-"));
  const files = [
    "scripts/generate-studio-evidence.mjs",
    "packages/studio-evidence/catalog/roblox-api-catalog.json",
    "packages/studio-evidence/src/index.ts",
    "packages/studio-evidence/src/project-index.ts",
    "packages/studio-evidence/src/project-authority.ts",
  ];
  const policyPath = "packages/studio-evidence/manifest/studio-capability-policy.json";
  const policy = JSON.parse(readFileSync(resolve(policyPath), "utf8"));
  try {
    for (const file of files) {
      await mkdir(resolve(sandbox, file, ".."), { recursive: true });
      await cp(resolve(file), resolve(sandbox, file));
    }
    await mkdir(resolve(sandbox, policyPath, ".."), { recursive: true });
    for (const [type, diagnostic] of [
      ["Font", /codec has no API-type mapping: font/],
      ["ContentId", /Uncovered authoring property .* \(ContentId\)/],
    ] as const) {
      const missing = structuredClone(policy);
      delete missing.codecByApiType[type];
      await writeFile(resolve(sandbox, policyPath), JSON.stringify(missing));
      const result = spawnSync(
        process.execPath,
        ["scripts/generate-studio-evidence.mjs", "--check"],
        {
          cwd: sandbox,
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, diagnostic);
    }
    for (const mutation of [
      "missing_strategy",
      "unknown_strategy",
      "noncreatable_class",
    ] as const) {
      const invalid = structuredClone(policy);
      if (mutation === "missing_strategy") delete invalid.authoringGroups[0].preflightStrategy;
      if (mutation === "unknown_strategy")
        invalid.authoringGroups[0].preflightStrategy = "live_write";
      if (mutation === "noncreatable_class") invalid.authoringGroups[0].classes.push("Terrain");
      await writeFile(resolve(sandbox, policyPath), JSON.stringify(invalid));
      const result = spawnSync(
        process.execPath,
        ["scripts/generate-studio-evidence.mjs", "--check"],
        {
          cwd: sandbox,
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 1, mutation);
      assert.match(
        result.stderr,
        mutation === "noncreatable_class"
          ? /class that cannot receive direct authoring: Terrain/
          : /Invalid Studio capability authoring group/,
      );
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("every enabled public property has a codec or an explicit authority exclusion", () => {
  assert.deepEqual(
    [
      ...new Set(
        STUDIO_EVIDENCE_VECTORS.map(({ value }) => value.kind).filter((kind) => kind !== "nil"),
      ),
    ].sort(),
    [...STUDIO_CODECS].sort(),
  );
  assert.deepEqual(
    STUDIO_CAPABILITY_COVERAGE_REPORT.entries.filter(
      (entry) => entry.authoringGroup && entry.reason === "unsupported_codec",
    ),
    [],
  );
  for (const className of [
    "ImageLabel",
    "ImageButton",
    "Sound",
    "Beam",
    "Trail",
    "ParticleEmitter",
  ]) {
    const definition = STUDIO_CAPABILITY_MANIFEST.classes.find((entry) => entry.name === className);
    assert.ok(
      definition?.properties.some((property) => property.codec === "content"),
      className,
    );
  }
  assert.deepEqual(canonicalStudioValue({ kind: "content", value: "" }), {
    kind: "content",
    value: "",
  });
});

test("content reflection matches the complete live Studio 0.737 attestation", () => {
  const properties = STUDIO_CAPABILITY_MANIFEST.classes.flatMap((entry) =>
    entry.properties.map((property) => ({ className: entry.name, ...property })),
  );
  const contentIds = properties.filter((property) => property.catalogType.name === "ContentId");
  assert.equal(contentIds.length, 30);
  for (const property of contentIds) {
    assert.deepEqual(property.reflection, { engineType: "ContentId", scriptType: "string" });
  }
  const content = properties.filter((property) => property.catalogType.name === "Content");
  assert.equal(content.length, 26);
  for (const property of content) {
    assert.deepEqual(property.reflection, { engineType: "Content", scriptType: "Content" });
    // ReflectionService reports these URI/object views as non-serialized,
    // independently of the documentation catalog's canSave flag.
    assert.equal(property.serialized, false, `${property.className}.${property.name}`);
  }
});

test("generated Studio evidence manifest is closed and canonical", () => {
  assertStudioCapabilityManifest(STUDIO_CAPABILITY_MANIFEST);
  assert.match(STUDIO_CAPABILITY_MANIFEST_HASH, /^[0-9a-f]{64}$/);
  assert.match(STUDIO_CAPABILITY_COVERAGE_REPORT_HASH, /^[0-9a-f]{64}$/);
  assert.equal(
    new Set(STUDIO_CAPABILITY_MANIFEST.operationKinds).size,
    STUDIO_CAPABILITY_MANIFEST.operationKinds.length,
  );
  for (const classDefinition of STUDIO_CAPABILITY_MANIFEST.classes) {
    assert.equal(classDefinition.creatable, true);
    assert.equal(classDefinition.preflightStrategy, "detached_instance");
    assert.equal(
      new Set(classDefinition.properties.map((property) => property.name)).size,
      classDefinition.properties.length,
    );
    for (const property of classDefinition.properties) {
      assert.equal(typeof property.nullable, "boolean");
      if (property.nullable) assert.notEqual(property.codec, "instance_ref");
      assert.deepEqual(property.proof, [
        "canonicalize",
        "validate",
        "preflight",
        "write",
        "read",
        "project",
        "compare",
      ]);
    }
  }
  assert.ok(STUDIO_CAPABILITY_COVERAGE_REPORT.entries.length > 9_000);
});

test("manifest grants require a lawful detached same-class strategy", () => {
  for (const strategy of [undefined, "live_write", "surrogate_part"]) {
    const manifest = structuredClone(STUDIO_CAPABILITY_MANIFEST) as unknown as {
      classes: Array<{ preflightStrategy?: string; creatable: boolean }>;
    };
    if (strategy === undefined) delete manifest.classes[0]!.preflightStrategy;
    else manifest.classes[0]!.preflightStrategy = strategy;
    assert.throws(() => assertStudioCapabilityManifest(manifest), /manifest class/);
  }
  const manifest = structuredClone(STUDIO_CAPABILITY_MANIFEST) as unknown as {
    classes: Array<{ creatable: boolean }>;
  };
  manifest.classes[0]!.creatable = false;
  assert.throws(() => assertStudioCapabilityManifest(manifest), /manifest class/);
});

test("PhysicalProperties preserves all six fields and the pinned engine constructor bounds", () => {
  const value = {
    kind: "physical_properties" as const,
    density: 0.7,
    friction: 1.5,
    elasticity: 0.5,
    frictionWeight: 50,
    elasticityWeight: 100,
    acousticAbsorption: 0.3,
  };
  assert.deepEqual(canonicalStudioValue(value), {
    ...value,
    density: Math.fround(value.density),
    acousticAbsorption: Math.fround(value.acousticAbsorption),
  });
  const changed = { ...value, acousticAbsorption: 0.8 };
  assert.equal(studioValuesEqual(value, changed), false);
  assert.notEqual(canonicalStudioValueMaterial(value), canonicalStudioValueMaterial(changed));
  const { acousticAbsorption: _removed, ...incomplete } = value;
  assert.throws(() => canonicalStudioValue(incomplete as never), /physical properties/);
  for (const [field, minimum, maximum] of [
    ["density", Math.fround(0.0001), 100],
    ["friction", 0, 2],
    ["elasticity", 0, 1],
    ["frictionWeight", 0, 100],
    ["elasticityWeight", 0, 100],
    ["acousticAbsorption", 0, 1],
  ] as const) {
    for (const endpoint of [minimum, maximum])
      assert.doesNotThrow(() => canonicalStudioValue({ ...value, [field]: endpoint }));
    for (const outside of [minimum - 0.00001, maximum + 0.00001, NaN, Infinity])
      assert.throws(
        () => canonicalStudioValue({ ...value, [field]: outside }),
        /physical properties/,
      );
  }
});

test("coupled setter families reject combined writes without granting derived effects", () => {
  const assignments: Record<string, StudioValue> = {
    BrickColor: { kind: "brick_color", name: "Bright red" },
    Color: { kind: "color3_rgb8", r: 0, g: 255, b: 0 },
    CFrame: { kind: "cframe_f32x12", components: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
    Position: { kind: "vector3_f32", x: 2, y: 3, z: 4 },
    Rotation: { kind: "vector3_f32", x: 5, y: 6, z: 7 },
    Orientation: { kind: "vector3_f32", x: 8, y: 9, z: 10 },
  };
  for (const definition of STUDIO_CAPABILITY_MANIFEST.classes) {
    if (!definition.properties.some((property) => property.declaringClass === "BasePart")) continue;
    const families = [
      ["BrickColor", "Color"],
      ["CFrame", "Rotation"],
    ];
    for (const family of families) {
      assert.equal(
        new Set(
          family.map(
            (name) =>
              definition.properties.find((property) => property.name === name)?.setterFamily,
          ),
        ).size,
        1,
      );
      for (const name of family) {
        assert.deepEqual(
          sortedStudioMutationPropertyNames(definition, { [name]: assignments[name]! }),
          [name],
        );
      }
      for (let left = 0; left < family.length; left += 1) {
        for (let right = left + 1; right < family.length; right += 1) {
          const properties = {
            [family[left]!]: assignments[family[left]!]!,
            [family[right]!]: assignments[family[right]!]!,
          };
          assert.throws(
            () =>
              compileMutationEvidenceProjection({
                id: "coupled-setters",
                project,
                binding: { sessionId: "coupled-setters", changeSetHash: "coupled-setters" },
                operations: [
                  {
                    id: "update",
                    kind: "update",
                    target: { ...target, className: definition.name },
                    properties,
                  },
                ],
              }),
            /coupled property setters/,
          );
        }
      }
    }
    assert.deepEqual(
      sortedStudioMutationPropertyNames(definition, {
        Color: assignments.Color!,
        CFrame: assignments.CFrame!,
      }),
      ["CFrame", "Color"],
    );
    for (const name of ["Position", "Orientation"]) {
      assert.throws(
        () =>
          sortedStudioMutationPropertyNames(definition, {
            CFrame: assignments.CFrame!,
            [name]: assignments[name]!,
          }),
        /outside manifest/,
      );
    }
  }
  const frame = STUDIO_CAPABILITY_MANIFEST.classes.find((entry) => entry.name === "Frame")!;
  assert.deepEqual(
    sortedStudioMutationPropertyNames(frame, {
      Position: { kind: "udim2", x: { scale: 0, offset: 0 }, y: { scale: 0, offset: 0 } },
      Rotation: { kind: "number_f32", value: 30 },
    }),
    ["Position", "Rotation"],
  );
});

test("catalog-derived direct property selection stays exhaustive and keeps structural authority separate", () => {
  const applications = STUDIO_CAPABILITY_MANIFEST.classes.flatMap((classDefinition) =>
    classDefinition.properties.map((property) => ({
      className: classDefinition.name,
      property,
    })),
  );
  assert.equal(applications.length, STUDIO_CAPABILITY_COVERAGE_REPORT.summary.authorableProperties);
  assert.ok(
    applications.some(
      ({ className, property }) =>
        className === "Part" &&
        property.declaringClass === "BasePart" &&
        property.name === "CustomPhysicalProperties" &&
        property.codec === "physical_properties",
    ),
  );
  assert.ok(
    applications.some(
      ({ className, property }) =>
        className === "Sound" &&
        property.name === "SoundGroup" &&
        property.codec === "instance_ref" &&
        property.referenceClass === "SoundGroup",
    ),
  );
  assert.ok(
    applications.some(
      ({ className, property }) =>
        className === "TextLabel" &&
        property.name === "TextXAlignment" &&
        property.codec === "enum_name",
    ),
  );
  assert.equal(
    applications.some(
      ({ property }) =>
        property.declaringClass === "Instance" && ["Name", "Parent"].includes(property.name),
    ),
    false,
  );
  for (const { className, property } of applications) {
    const row = STUDIO_CAPABILITY_COVERAGE_REPORT.entries.find(
      (entry) =>
        entry.entryKind === "class_property" &&
        entry.owner === property.declaringClass &&
        entry.name === property.name,
    );
    assert.equal(row?.disposition, "authorable");
    assert.equal(row?.codec, property.codec);
    assert.ok(row?.inheritedBy?.includes(className));
  }
  assert.equal(
    STUDIO_CAPABILITY_COVERAGE_REPORT.entries.find(
      (entry) =>
        entry.entryKind === "class_property" && entry.owner === "Instance" && entry.name === "Name",
    )?.reason,
    "structure_managed",
  );
});

test("manifest nullability is explicit per inherited property and never implied by a codec", () => {
  const part = STUDIO_CAPABILITY_MANIFEST.classes.find(({ name }) => name === "Part");
  assert.ok(part);
  const nullable = part.properties.find(({ name }) => name === "CustomPhysicalProperties");
  const nonNullable = part.properties.find(({ name }) => name === "Anchored");
  assert.ok(nullable);
  assert.ok(nonNullable);
  assert.equal(nullable.declaringClass, "BasePart");
  assert.equal(nullable.codec, "physical_properties");
  assert.equal(nullable.nullable, true);
  assert.equal(nonNullable.nullable, false);
  assert.deepEqual(
    canonicalStudioValue({ kind: "nil", expectedCodec: "physical_properties" }, nullable),
    { kind: "nil", expectedCodec: "physical_properties" },
  );
  assert.throws(
    () =>
      assertStudioValueForProperty(
        { kind: "nil", expectedCodec: "physical_properties" },
        nonNullable,
      ),
    /nil is not declared/i,
  );
  assert.throws(
    () => assertStudioValueForProperty({ kind: "nil", expectedCodec: "boolean" }, nullable),
    /nil is not declared/i,
  );
  assert.throws(
    () =>
      assertStudioValueForProperty(
        {
          kind: "nil",
          expectedCodec: "physical_properties",
          invented: true,
        } as never,
        nullable,
      ),
    /nil value/i,
  );
  assert.throws(
    () => canonicalStudioValue({ kind: "nil", expectedCodec: "instance_ref" } as never),
    /nil value codec/i,
  );
  assert.notEqual(
    canonicalStudioValueMaterial({ kind: "nil", expectedCodec: "physical_properties" }),
    canonicalStudioValueMaterial({ kind: "nil", expectedCodec: "boolean" }),
  );
  assert.notEqual(
    canonicalStudioValueMaterial({ kind: "nil", expectedCodec: "physical_properties" }),
    canonicalStudioValueMaterial({
      kind: "physical_properties",
      density: 0.7,
      friction: 0.3,
      elasticity: 0.5,
      frictionWeight: 1,
      elasticityWeight: 1,
      acousticAbsorption: 0.3,
    }),
  );
});

test("manifest text minima are explicit, byte-based, and bound to their property", () => {
  const part = STUDIO_CAPABILITY_MANIFEST.classes.find(({ name }) => name === "Part");
  const collisionGroup = part?.properties.find(({ name }) => name === "CollisionGroup");
  assert.ok(collisionGroup);
  assert.equal(collisionGroup.codec, "string_utf8");
  assert.equal(collisionGroup.minimumUtf8Bytes, 1);
  assert.equal(collisionGroup.maximumUtf8Bytes, 100);
  assert.doesNotThrow(() =>
    assertStudioValueForProperty({ kind: "string_utf8", value: "Default" }, collisionGroup),
  );
  assert.throws(
    () => assertStudioValueForProperty({ kind: "string_utf8", value: "" }, collisionGroup),
    /string bound/i,
  );
  const byteBoundProperty = {
    ...collisionGroup,
    minimumUtf8Bytes: 3,
    maximumUtf8Bytes: 4,
  };
  assert.throws(
    () => assertStudioValueForProperty({ kind: "string_utf8", value: "é" }, byteBoundProperty),
    /string bound/i,
  );
  assert.doesNotThrow(() =>
    assertStudioValueForProperty({ kind: "string_utf8", value: "éx" }, byteBoundProperty),
  );
});

test("every catalog row remains planner-queryable with official provenance", () => {
  for (const coverage of STUDIO_CAPABILITY_COVERAGE_REPORT.entries) {
    const entry = getRobloxApiCatalogLookupEntry(coverage.catalogEntryId);
    assert.ok(entry, coverage.catalogEntryId);
    assert.equal(entry.catalogEntryId, coverage.catalogEntryId);
    assert.match(entry.sourceFileHash, /^[0-9a-f]{64}$/);
    assert.ok(entry.sourceFile.length > 0);
    const security = Object.values(entry.security ?? {});
    const platformValid =
      !entry.deprecated &&
      !entry.tags.includes("Hidden") &&
      !entry.tags.includes("NotScriptable") &&
      security.every((value) => value === "None");
    if (platformValid) assert.notEqual(entry.disposition, "unsupported");
  }
  const soundGroup = lookupRobloxApiCatalog({
    ownerName: "Sound",
    query: "SoundGroup",
  });
  assert.equal(soundGroup.total, 1);
  assert.equal(soundGroup.entries[0]?.disposition, "authorable");
  assert.equal(soundGroup.entries[0]?.valueType, "SoundGroup");
  assert.deepEqual(soundGroup.entries[0]?.security, {
    read: "None",
    write: "None",
  });
});

test("creator mutation bindings are closed and use revisionHash", () => {
  const backendProduced = {
    sessionId: "creator-session-binding-fixture",
    changeSetHash: "a".repeat(64),
    approvalHash: "b".repeat(64),
    revisionHash: "c".repeat(64),
    buildHash: "d".repeat(64),
    dashboardReviewHash: "e".repeat(64),
  };
  assert.deepEqual(
    STUDIO_CREATOR_MUTATION_BINDING_SCHEMA.map(({ name }) => name),
    [
      "sessionId",
      "changeSetHash",
      "approvalHash",
      "revisionHash",
      "buildHash",
      "dashboardReviewHash",
    ],
  );
  assert.equal(isStudioCreatorMutationBinding(backendProduced), true);
  assert.equal(matchesStudioCreatorMutationBinding(backendProduced, backendProduced), true);
  assert.equal(
    isStudioCreatorMutationBinding({
      ...backendProduced,
      projectRevisionHash: backendProduced.revisionHash,
    }),
    false,
  );
  assert.equal(
    isStudioCreatorMutationBinding({
      ...backendProduced,
      revisionHash: undefined,
    }),
    false,
  );
  assert.equal(
    matchesStudioCreatorMutationBinding(backendProduced, {
      ...backendProduced,
      revisionHash: "f".repeat(64),
    }),
    false,
  );
});

test("canonical values preserve explicit presence and numeric storage domains", () => {
  const rounded = canonicalStudioValue({ kind: "number_f32", value: 1 / 3 });
  assert.equal(rounded.kind, "number_f32");
  if (rounded.kind === "number_f32") assert.equal(rounded.value, Math.fround(1 / 3));
  assert.equal(
    studioValuesEqual({ kind: "boolean", value: false }, { kind: "boolean", value: false }),
    true,
  );
  assert.equal(
    studioValuesEqual({ kind: "number_f32", value: -0 }, { kind: "number_f32", value: 0 }),
    false,
  );
  assert.equal(
    studioValuesEqual(
      { kind: "nil", expectedCodec: "physical_properties" },
      { kind: "nil", expectedCodec: "physical_properties" },
    ),
    true,
  );
  assert.notEqual(
    canonicalStudioValueMaterial({
      kind: "instance_ref",
      state: "nil",
      expectedClass: "Instance",
    }),
    canonicalStudioValueMaterial({
      kind: "instance_ref",
      state: "reference",
      identity: {
        kind: "studio_ephemeral",
        connectorEpoch: "epoch-a",
        opaqueHash: "a".repeat(64),
      },
      path: "Workspace/Duplicate",
      className: "Part",
      expectedClass: "Instance",
    }),
  );
  assert.throws(() => canonicalStudioValue({ kind: "number_f32", value: Number.NaN }));
  assert.throws(() => canonicalStudioValue({ kind: "color3_rgb8", r: 0, g: 2.5, b: 255 }));
});

test("cross-language canonical evidence vectors stay pinned", () => {
  assert.ok(STUDIO_EVIDENCE_VECTORS.length > 0);
  for (const vector of STUDIO_EVIDENCE_VECTORS) assert.ok(vector.material.length > 0);
  const emptyTarget = {
    kind: "instance" as const,
    identity: {
      kind: "forge_attribute" as const,
      stableId: "empty-list-instance",
    },
    path: "Workspace/EmptyList",
    className: "Folder",
  };
  assert.equal(
    studioEvidenceEnvelopeHash({
      kind: "StudioEvidenceEnvelope",
      manifestHash: "a".repeat(64),
      projectionId: "empty-list-projection",
      projectionHash: "b".repeat(64),
      bindingHash: "c".repeat(64),
      project: { name: "Empty List Vector", placeId: 0, universeId: 0 },
      authoritative: true,
      startedAt: interval.startedAt,
      endedAt: interval.startedAt,
      completion: "complete",
      facts: [
        {
          kind: "tags",
          key: studioEvidenceFactKey("tags", emptyTarget),
          target: emptyTarget,
          result: { status: "observed", value: [] },
        },
      ],
    }),
    "1b51d6c9aeef8724f06a121027fe3176f5a550256168847389cfee403f279735",
  );
});

test("complete evidence can mismatch expectations while unavailable evidence is incomplete", () => {
  const projection = compileMutationEvidenceProjection({
    id: "projection-mutation-1",
    project,
    binding: { sessionId: "session-1", changeSetHash: "change-1" },
    operations: [
      {
        id: "update-1",
        kind: "update",
        target,
        properties: { RequiresLineOfSight: { kind: "boolean", value: false } },
        removedAttributes: ["LegacyTag"],
      },
    ],
  });
  const property: StudioEvidenceFact = {
    kind: "property",
    key: studioEvidenceFactKey("property", target, "RequiresLineOfSight"),
    target,
    propertyName: "RequiresLineOfSight",
    result: { status: "observed", value: { kind: "boolean", value: true } },
  };
  const removed: StudioEvidenceFact = {
    kind: "attribute",
    key: studioEvidenceFactKey("attribute", target, "LegacyTag"),
    target,
    attributeName: "LegacyTag",
    result: { status: "absent" },
  };
  const mismatched = createStudioEvidenceEnvelope(
    {
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      bindingHash: projection.bindingHash,
      project,
      authoritative: true,
      completion: "complete",
      facts: [property, removed],
      ...interval,
    },
    projection,
  );
  assertEvidenceAgainstProjection(mismatched, projection);
  assert.equal(mismatched.completion, "complete");

  const unavailable = createStudioEvidenceEnvelope({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    projectionId: projection.id,
    projectionHash: projection.contentHash,
    bindingHash: projection.bindingHash,
    project,
    authoritative: true,
    completion: "incomplete",
    facts: [
      {
        ...property,
        result: { status: "read_error", code: "engine_read_failed" },
      },
      removed,
    ],
    ...interval,
  });
  assertStudioEvidenceEnvelope(unavailable);
  assert.doesNotThrow(() => assertEvidenceAgainstProjection(unavailable, projection));
  assert.equal(unavailable.completion, "incomplete");
});

test("delete proof requires an explicit absent structure fact", () => {
  const projection = compileMutationEvidenceProjection({
    id: "projection-delete-1",
    project,
    binding: { sessionId: "session-delete", changeSetHash: "change-delete" },
    operations: [{ id: "delete-1", kind: "delete", target }],
  });
  const envelope = createStudioEvidenceEnvelope(
    {
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      bindingHash: projection.bindingHash,
      project,
      authoritative: true,
      completion: "complete",
      facts: [
        {
          kind: "structure",
          key: studioEvidenceFactKey("structure", target),
          target,
          result: { status: "absent" },
        },
      ],
      ...interval,
    },
    projection,
  );
  assertEvidenceAgainstProjection(envelope, projection);
});

test("immutable evidence validates against the manifest stored with it", () => {
  const legacyProperty = {
    name: "LegacyFlag",
    codec: "boolean" as const,
    catalogType: { category: "primitive" as const, name: "boolean" },
    reflection: { engineType: "bool", scriptType: "boolean" },
    declaringClass: "Folder",
    nullable: false,
    proof: [
      "canonicalize",
      "validate",
      "preflight",
      "write",
      "read",
      "project",
      "compare",
    ] as const,
  };
  const storedManifest: StudioCapabilityManifest = {
    ...STUDIO_CAPABILITY_MANIFEST,
    classes: STUDIO_CAPABILITY_MANIFEST.classes.map((entry) =>
      entry.name === "Folder" ? { ...entry, properties: [legacyProperty] } : entry,
    ),
  };
  const storedTarget = {
    kind: "instance" as const,
    identity: { kind: "forge_attribute" as const, stableId: "legacy-folder" },
    path: "Workspace/Legacy",
    className: "Folder",
  };
  const requirement = {
    kind: "property" as const,
    key: studioEvidenceFactKey("property", storedTarget, "LegacyFlag"),
    target: storedTarget,
    propertyName: "LegacyFlag",
    expected: { kind: "boolean" as const, value: false },
  };
  const projection = createStudioEvidenceProjection(
    {
      id: "stored-manifest-projection",
      manifestHash: "f".repeat(64),
      purpose: "mutation_direct_readback",
      project,
      binding: { sessionId: "stored-manifest-session" },
      requirements: [requirement],
      scope: { roots: storedManifest.roots },
      bounds: {
        maximumFacts: storedManifest.limits.maximumProjectionFacts,
        maximumBytes: storedManifest.limits.maximumProjectionBytes,
        roots: storedManifest.roots,
      },
    },
    storedManifest,
  );
  const envelope = createStudioEvidenceEnvelope(
    {
      manifestHash: "f".repeat(64),
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      bindingHash: projection.bindingHash,
      project,
      authoritative: true,
      completion: "complete",
      facts: [
        {
          kind: "property",
          key: requirement.key,
          target: storedTarget,
          propertyName: "LegacyFlag",
          result: {
            status: "observed",
            value: { kind: "boolean", value: false },
          },
        },
      ],
      ...interval,
    },
    projection,
    storedManifest,
  );
  assertStudioEvidenceEnvelope(envelope, projection, storedManifest);
  assert.throws(() => assertStudioEvidenceEnvelope(envelope, projection), /outside manifest/i);
});

test("facts reject missing observed values and unapproved fields", () => {
  assert.throws(
    () =>
      assertStudioEvidenceFact({
        kind: "property",
        key: "property:test",
        target,
        propertyName: "RequiresLineOfSight",
        result: { status: "observed" },
      }),
    /keys/,
  );
  assert.throws(
    () =>
      assertStudioEvidenceFact({
        kind: "property",
        key: "property:test",
        target,
        propertyName: "RequiresLineOfSight",
        result: { status: "absent" },
        invented: true,
      }),
    /keys/,
  );
});

test("solution-free seed places stay free of executable source", () => {
  for (const fixture of [
    "examples/door-control/default.project.json",
    "examples/status-beacon/default.project.json",
    "examples/orbital-freight-airlock/default.project.json",
  ]) {
    const parsed = JSON.parse(readFileSync(resolve(fixture), "utf8")) as {
      tree: Record<string, unknown>;
    };
    const visit = (node: unknown): void => {
      if (typeof node !== "object" || node === null || Array.isArray(node)) return;
      const record = node as Record<string, unknown>;
      assert.equal((record.$properties as Record<string, unknown> | undefined)?.Source, undefined);
      for (const [key, child] of Object.entries(record)) if (!key.startsWith("$")) visit(child);
    };
    visit(parsed.tree);
  }
});

test("project indexing policy replaces the former whole-place ceilings", () => {
  assert.deepEqual(CREATOR_DEFAULT_RESOURCE_POLICY, {
    kind: "CreatorResourcePolicy",
    maximumInstances: 1_048_576,
    maximumCanonicalIndexBytes: 1_073_741_824,
    maximumSourceBlobBytes: 134_217_728,
    maximumIndexingDurationMs: 600_000,
    maximumNodesPerShard: 512,
    maximumCanonicalShardBytes: 4_194_304,
    transportChunkBytes: 262_144,
  });
});
