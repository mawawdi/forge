import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  STUDIO_CAPABILITY_COVERAGE_REPORT,
  STUDIO_CAPABILITY_COVERAGE_REPORT_HASH,
  STUDIO_CONNECTOR_BUILD_HASH,
  STUDIO_EVIDENCE_VECTORS,
  assertEvidenceAgainstProjection,
  assertStudioCapabilityAttestation,
  assertStudioCapabilityManifest,
  assertStudioEvidenceEnvelope,
  assertStudioEvidenceFact,
  canonicalStudioValue,
  canonicalStudioValueMaterial,
  compileMutationEvidenceProjection,
  compileProjectStateProjection,
  createStudioEvidenceEnvelope,
  createStudioEvidenceProjection,
  createStudioStateRevision,
  deriveMutationStateDelta,
  projectStateFromEvidence,
  studioEvidenceEnvelopeHash,
  studioEvidenceFactKey,
  studioStateDomainHash,
  studioValuesEqual,
  type StudioEvidenceFact,
  type StudioEvidenceTarget,
  type StudioCapabilityManifest,
  type StudioManifestProperty,
  type StudioPrimitiveValue,
  type StudioReflectionValue,
  gradeStudioCapabilityAttestation,
  lookupRobloxApiCatalog,
} from "../packages/studio-evidence/src/index.js";

const project = { name: "Evidence Test", placeId: 7, universeId: 11 };
const target: StudioEvidenceTarget = { kind: "instance", stableId: "part-1", path: "Workspace/Door", className: "ProximityPrompt" };
const interval = { startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z" };

type StateInstance = {
  readonly target: Extract<StudioEvidenceTarget, { readonly kind: "instance" }>;
  readonly attributes?: Readonly<Record<string, StudioPrimitiveValue>>;
};
function valueForProperty(property: StudioManifestProperty) {
  switch (property.codec) {
    case "boolean": return { kind: "boolean", value: false } as const;
    case "number_f32": return { kind: "number_f32", value: property.minimumExclusive === undefined ? (property.minimum ?? 0) : property.minimumExclusive + 1 } as const;
    case "number_f64": return { kind: "number_f64", value: property.minimumExclusive === undefined ? (property.minimum ?? 0) : property.minimumExclusive + 1 } as const;
    case "int32": return { kind: "int32", value: Math.ceil(property.minimumExclusive === undefined ? (property.minimum ?? 0) : property.minimumExclusive + 1) } as const;
    case "int64_decimal": return { kind: "int64_decimal", value: "0" } as const;
    case "string_utf8": return { kind: "string_utf8", value: "" } as const;
    case "content": return { kind: "content", value: "rbxassetid://1" } as const;
    case "color3_rgb8": return { kind: "color3_rgb8", r: 0, g: 0, b: 0 } as const;
    case "vector2_f32": return { kind: "vector2_f32", x: 1, y: 1 } as const;
    case "vector3_f32": return { kind: "vector3_f32", x: 1, y: 1, z: 1 } as const;
    case "cframe_f32x12": return { kind: "cframe_f32x12", components: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] } as const;
    case "udim": return { kind: "udim", scale: 0, offset: 0 } as const;
    case "udim2": return { kind: "udim2", x: { scale: 0, offset: 0 }, y: { scale: 0, offset: 0 } } as const;
    case "rect": return { kind: "rect", minX: 0, minY: 0, maxX: 1, maxY: 1 } as const;
    case "number_range": return { kind: "number_range", min: 0, max: 1 } as const;
    case "number_sequence": return { kind: "number_sequence", keypoints: [{ time: 0, value: 0, envelope: 0 }, { time: 1, value: 1, envelope: 0 }] } as const;
    case "color_sequence": return { kind: "color_sequence", keypoints: [{ time: 0, color: { r: 0, g: 0, b: 0 } }, { time: 1, color: { r: 255, g: 255, b: 255 } }] } as const;
    case "brick_color": return { kind: "brick_color", name: property.allowed![0]! } as const;
    case "font": return { kind: "font", family: "rbxasset://fonts/families/Arial.json", weight: "Regular", style: "Normal" } as const;
    case "physical_properties": return { kind: "physical_properties", density: 1, friction: 0.5, elasticity: 0, frictionWeight: 1, elasticityWeight: 1 } as const;
    case "axes": return { kind: "axes", x: false, y: false, z: false } as const;
    case "faces": return { kind: "faces", top: false, bottom: false, left: false, right: false, front: false, back: false } as const;
    case "ray": return { kind: "ray", origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } } as const;
    case "instance_ref": return { kind: "instance_ref", state: "nil", expectedClass: property.referenceClass! } as const;
    case "enum_name": return { kind: "enum_name", value: property.allowed![0]! } as const;
  }
}
function completeProjectState(instances: readonly StateInstance[]) {
  const projection = compileProjectStateProjection({ id: "complete-before", project, binding: { sessionId: "state-session", revisionHash: "before-revision" }, roots: ["ServerScriptService", "Workspace"] });
  const facts: StudioEvidenceFact[] = [{ kind: "inventory", key: studioEvidenceFactKey("inventory", { kind: "project" }), target: { kind: "project" }, result: { status: "observed", value: instances.map(({ target: entry }) => ({ stableId: entry.stableId, path: entry.path, className: entry.className, parentPath: entry.path.slice(0, entry.path.lastIndexOf("/")) })).sort((left, right) => left.stableId.localeCompare(right.stableId)) } }];
  for (const { target: entry, attributes = {} } of instances) {
    const manifestClass = STUDIO_CAPABILITY_MANIFEST.classes.find((candidate) => candidate.name === entry.className)!;
    const parentPath = entry.path.slice(0, entry.path.lastIndexOf("/"));
    facts.push({ kind: "structure", key: studioEvidenceFactKey("structure", entry), target: entry, result: { status: "observed", value: { stableId: entry.stableId, path: entry.path, className: entry.className, parentPath } } });
    for (const property of manifestClass.properties) facts.push({ kind: "property", key: studioEvidenceFactKey("property", entry, property.name), target: entry, propertyName: property.name, result: { status: "observed", value: valueForProperty(property) } });
    const names = Object.keys(attributes).sort();
    facts.push({ kind: "attribute_inventory", key: studioEvidenceFactKey("attribute_inventory", entry), target: entry, result: { status: "observed", value: names } });
    for (const name of names) facts.push({ kind: "attribute", key: studioEvidenceFactKey("attribute", entry, name), target: entry, attributeName: name, result: { status: "observed", value: attributes[name]! } });
    facts.push({ kind: "tags", key: studioEvidenceFactKey("tags", entry), target: entry, result: { status: "observed", value: [] } });
    if (manifestClass.source !== "forbidden") {
      facts.push({ kind: "source_hash", key: studioEvidenceFactKey("source_hash", entry), target: entry, result: { status: "observed", value: "a".repeat(64) } });
      facts.push({ kind: "source_body", key: studioEvidenceFactKey("source_body", entry), target: entry, result: { status: "observed", value: "print('before')" } });
    }
    if (entry.className === "RemoteEvent" || entry.className === "RemoteFunction") facts.push({ kind: "remote", key: studioEvidenceFactKey("remote", entry), target: entry, result: { status: "observed", value: { name: entry.path.split("/").at(-1)!, className: entry.className, direction: "client_to_server" } } });
  }
  return { projection, envelope: createStudioEvidenceEnvelope({ manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH, projectionId: projection.id, projectionHash: projection.contentHash, bindingHash: projection.bindingHash, project, authoritative: true, completion: "complete", facts, ...interval }, projection) };
}

test("generated manifest is closed and canonical", () => {
  assertStudioCapabilityManifest(STUDIO_CAPABILITY_MANIFEST);
  for (const entry of STUDIO_CAPABILITY_MANIFEST.classes) for (const property of entry.properties) {
    assert.deepEqual(property.proof, ["canonicalize", "validate", "preflight", "write", "read", "project", "compare"]);
    assert.ok(["primitive", "datatype", "enum", "class"].includes(property.catalogType.category));
    assert.equal(typeof property.catalogType.name, "string");
    assert.equal(typeof property.declaringClass, "string");
    assert.equal(typeof property.reflection.engineType, "string");
    assert.equal(typeof property.reflection.scriptType, "string");
    assert.equal(property.reflection.enumType !== undefined, property.catalogType.category === "enum");
    assert.equal(property.reflection.instanceType !== undefined, property.catalogType.category === "class");
  }
  const part = STUDIO_CAPABILITY_MANIFEST.classes.find((entry) => entry.name === "Part");
  assert.equal(part?.properties.find((property) => property.name === "Color")?.serialized, false);
  assert.equal(part?.properties.find((property) => property.name === "Size")?.serialized, false);
  const material = part?.properties.find((property) => property.name === "Material");
  assert.deepEqual(material?.catalogType, { category: "enum", name: "Material" });
  assert.deepEqual(material?.reflection, { engineType: "Enum", enumType: "Material", scriptType: "EnumItem" });
  assert.deepEqual(STUDIO_CAPABILITY_MANIFEST.stateRevision, {
    comparableDomain: ["project", "requirements", "scope"],
    projectionHashRole: "provenance_only",
    stateMaterial: ["facts", "manifest", "state_domain"],
  });
  assert.equal(STUDIO_CAPABILITY_COVERAGE_REPORT.entries.length, 9_685);
  assert.equal(STUDIO_CAPABILITY_COVERAGE_REPORT.summary.total, 9_685);
  assert.equal(new Set(STUDIO_CAPABILITY_COVERAGE_REPORT.entries.map((entry) => entry.catalogEntryId)).size, 9_685);
  assert.equal(STUDIO_CAPABILITY_COVERAGE_REPORT.contentHash, STUDIO_CAPABILITY_COVERAGE_REPORT_HASH);
  assert.ok(STUDIO_CAPABILITY_COVERAGE_REPORT.summary.byDisposition.source_only > 0);
  assert.equal(
    Object.values(STUDIO_CAPABILITY_COVERAGE_REPORT.summary.byDisposition).reduce(
      (total, count) => total + count,
      0,
    ),
    STUDIO_CAPABILITY_COVERAGE_REPORT.summary.total,
  );
  for (const vector of STUDIO_EVIDENCE_VECTORS) assert.equal(canonicalStudioValueMaterial(vector.value), vector.material, vector.name);
});

test("pinned API lookup joins official signatures to precise Forge boundaries", () => {
  const sourceApi = lookupRobloxApiCatalog({
    className: "ProximityPrompt",
    query: "Triggered",
    limit: 5,
  });
  assert.equal(sourceApi.kind, "RobloxApiCatalogLookupResult");
  assert.equal(sourceApi.truncated, false);
  assert.equal(sourceApi.entries[0]?.catalogEntryId, "class_member:ProximityPrompt:event:Triggered");
  assert.equal(sourceApi.entries[0]?.disposition, "source_only");
  assert.deepEqual(sourceApi.entries[0]?.parameters, [
    { name: "playerWhoTriggered", type: "Player" },
  ]);
  assert.equal(sourceApi.entries[0]?.security?.read, "None");
  assert.match(sourceApi.entries[0]?.sourceFile ?? "", /ProximityPrompt\.yaml$/);

  const direct = lookupRobloxApiCatalog({ className: "ProximityPrompt", query: "RequiresLineOfSight" });
  assert.equal(direct.entries[0]?.disposition, "authorable");
  assert.equal(direct.entries[0]?.reason, "proof_closed");

  const restricted = lookupRobloxApiCatalog({
    className: "AnimationNodeDefinition",
    query: "NodeId",
  });
  assert.equal(restricted.entries[0]?.disposition, "unsupported");
  assert.equal(restricted.entries[0]?.reason, "security_gated");

  assert.throws(
    () => lookupRobloxApiCatalog({}),
    /requires className or query/,
  );
  assert.throws(
    () => lookupRobloxApiCatalog({ query: "Part", limit: 21 }),
    /limit is invalid/,
  );

  const library = lookupRobloxApiCatalog({ query: "math.abs" });
  assert.equal(library.entries[0]?.catalogEntryId, "library_member:math:function:abs");
  assert.equal(library.entries[0]?.disposition, "source_only");
  const global = lookupRobloxApiCatalog({ query: "Roblox globals.workspace" });
  assert.equal(global.entries[0]?.catalogEntryId, "global_member:Roblox globals:property:workspace");
});

function reflectionValue(className: string, property: StudioManifestProperty): StudioReflectionValue {
  return {
    className,
    propertyName: property.name,
    owner: property.declaringClass,
    type: { ...property.reflection },
    inherited: property.declaringClass !== className,
    serialized: property.serialized ?? true,
    permits: ["read", "write"],
  };
}

function capabilityAttestationProjection() {
  const reflectionTarget = { kind: "project" as const };
  const requirements = STUDIO_CAPABILITY_MANIFEST.classes.flatMap((classDefinition) => classDefinition.properties.map((property) => ({
    key: studioEvidenceFactKey("reflection", reflectionTarget, `${classDefinition.name}.${property.name}`),
    kind: "reflection" as const,
    target: reflectionTarget,
  })));
  return createStudioEvidenceProjection({
    id: "real-reflection-attestation",
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    purpose: "capability_attestation",
    project,
    binding: { sessionId: "attestation-session" },
    requirements,
    scope: { mode: "exact", roots: [], requireCompleteInventory: false },
    bounds: { maximumFacts: 4096, maximumBytes: 131072, roots: [] },
  });
}

function completeCapabilityAttestation() {
  const reflectionTarget = { kind: "project" as const };
  const projection = capabilityAttestationProjection();
  const facts: StudioEvidenceFact[] = STUDIO_CAPABILITY_MANIFEST.classes.flatMap((classDefinition) => classDefinition.properties.map((property) => ({
    kind: "reflection" as const,
    key: studioEvidenceFactKey("reflection", reflectionTarget, `${classDefinition.name}.${property.name}`),
    target: reflectionTarget,
    result: {
      status: "observed" as const,
      value: reflectionValue(classDefinition.name, property),
    },
  })));
  const envelope = createStudioEvidenceEnvelope({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    projectionId: projection.id,
    projectionHash: projection.contentHash,
    bindingHash: projection.bindingHash,
    project,
    authoritative: true,
    completion: "complete",
    facts,
    ...interval,
  }, projection);
  return { projection, facts, envelope };
}

test("capability attestation binds every generated catalog and reflection type domain", () => {
  const { projection, facts, envelope } = completeCapabilityAttestation();
  assert.doesNotThrow(() => assertStudioCapabilityAttestation(STUDIO_CAPABILITY_MANIFEST, STUDIO_CAPABILITY_MANIFEST_HASH, projection, envelope));
  const categories = new Set(STUDIO_CAPABILITY_MANIFEST.classes.flatMap((entry) => entry.properties.map((property) => property.catalogType.category)));
  assert.deepEqual([...categories].sort(), ["class", "datatype", "enum", "primitive"]);
  const material = facts.find((fact) => fact.kind === "reflection" && fact.result.status === "observed" && fact.result.value.propertyName === "Material")!;
  if (material.kind !== "reflection" || material.result.status !== "observed") throw new Error("missing Material reflection fixture");
  const materialValue = material.result.value;
  const wrongEnumFacts = facts.map((fact) => {
    if (fact !== material) return fact;
    return { ...fact, result: { status: "observed" as const, value: { ...materialValue, type: { ...materialValue.type, enumType: "WrongEnum" } } } };
  });
  const wrongEnumEnvelope = createStudioEvidenceEnvelope({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    projectionId: projection.id,
    projectionHash: projection.contentHash,
    bindingHash: projection.bindingHash,
    project,
    authoritative: true,
    completion: "complete",
    facts: wrongEnumFacts,
    ...interval,
  }, projection);
  assert.throws(() => assertStudioCapabilityAttestation(STUDIO_CAPABILITY_MANIFEST, STUDIO_CAPABILITY_MANIFEST_HASH, projection, wrongEnumEnvelope), /reflection_enum_type_mismatch/);
});

test("every enabled property has a generated reflection obligation and a category-specific rejection vector", () => {
  const { projection, facts } = completeCapabilityAttestation();
  assert.equal(facts.length, STUDIO_CAPABILITY_MANIFEST.classes.reduce((total, entry) => total + entry.properties.length, 0));
  const mutatedFacts = facts.map((fact) => {
    if (fact.kind !== "reflection" || fact.result.status !== "observed") throw new Error("expected complete reflection fixture");
    const value = fact.result.value;
    const property = STUDIO_CAPABILITY_MANIFEST.classes.find((entry) => entry.name === value.className)?.properties.find((entry) => entry.name === value.propertyName);
    if (property === undefined) throw new Error(`missing manifest property ${value.className}.${value.propertyName}`);
    const type = property.catalogType.category === "class"
      ? { ...value.type, instanceType: `${property.catalogType.name}Wrong` }
      : property.catalogType.category === "enum"
        ? { ...value.type, enumType: `${property.catalogType.name}Wrong` }
        : { ...value.type, scriptType: `${property.reflection.scriptType}Wrong` };
    return { ...fact, result: { status: "observed" as const, value: { ...value, type } } };
  });
  const envelope = createStudioEvidenceEnvelope({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    projectionId: projection.id,
    projectionHash: projection.contentHash,
    bindingHash: projection.bindingHash,
    project,
    authoritative: true,
    completion: "complete",
    facts: mutatedFacts,
    ...interval,
  }, projection);
  const grade = gradeStudioCapabilityAttestation(STUDIO_CAPABILITY_MANIFEST, STUDIO_CAPABILITY_MANIFEST_HASH, projection, envelope);
  assert.equal(grade.status, "rejected");
  assert.equal(grade.mismatchedFacts, facts.length);
  assert.equal(grade.findingsTruncated, true);
  assert.equal(grade.findings.every((entry) => /type_mismatch/.test(entry.code)), true);
});

test("numeric catalog storage subtypes share the exact Luau number reflection contract", () => {
  const rows = STUDIO_CAPABILITY_MANIFEST.classes.flatMap((entry) => entry.properties);
  const expected = new Map([
    ["float", "float"],
    ["double", "double"],
    ["int", "int"],
    ["int64", "int64"],
  ]);
  for (const [catalogName, engineType] of expected) {
    const matching = rows.filter((property) => property.catalogType.category === "primitive" && property.catalogType.name === catalogName);
    assert.ok(matching.length > 0, `missing ${catalogName} regression rows`);
    for (const property of matching) assert.deepEqual(property.reflection, { engineType, scriptType: "number" });
  }
});

test("missing required reflection dimensions remain incomplete instead of becoming mismatches", () => {
  const { projection, facts } = completeCapabilityAttestation();
  const numeric = facts.find((fact) => fact.kind === "reflection" && fact.result.status === "observed" && fact.result.value.type.scriptType === "number");
  if (numeric === undefined || numeric.kind !== "reflection" || numeric.result.status !== "observed") throw new Error("missing numeric reflection fixture");
  const numericValue = numeric.result.value;
  const engineType = numericValue.type.engineType;
  if (engineType === undefined) throw new Error("missing numeric engine type fixture");
  const withoutScriptType = facts.map((fact) => fact === numeric
    ? { ...fact, result: { status: "observed" as const, value: { ...numericValue, type: { engineType } } } }
    : fact);
  const envelope = createStudioEvidenceEnvelope({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    projectionId: projection.id,
    projectionHash: projection.contentHash,
    bindingHash: projection.bindingHash,
    project,
    authoritative: true,
    completion: "complete",
    facts: withoutScriptType,
    ...interval,
  }, projection);
  const grade = gradeStudioCapabilityAttestation(STUDIO_CAPABILITY_MANIFEST, STUDIO_CAPABILITY_MANIFEST_HASH, projection, envelope);
  assert.equal(grade.status, "incomplete");
  assert.equal(grade.mismatchedFacts, 0);
  assert.equal(grade.findings.some((finding) => finding.key === numeric.key && finding.code === "reflection_script_type_missing"), true);
});

test("attestation grades incomplete raw collection separately and preserves exact raw type dimensions", () => {
  const { projection, facts } = completeCapabilityAttestation();
  const target = facts.find((fact) => fact.kind === "reflection" && fact.result.status === "observed" && fact.result.value.type.instanceType === "Attachment");
  if (target === undefined || target.kind !== "reflection" || target.result.status !== "observed") throw new Error("missing Attachment reflection fixture");
  const targetValue = target.result.value;
  const unavailableFacts = facts.map((fact) => fact === target ? { ...fact, result: { status: "unavailable" as const, code: "reflection_service_denied" } } : fact);
  const unavailableEnvelope = createStudioEvidenceEnvelope({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    projectionId: projection.id,
    projectionHash: projection.contentHash,
    bindingHash: projection.bindingHash,
    project,
    authoritative: true,
    completion: "incomplete",
    facts: unavailableFacts,
    ...interval,
  }, projection);
  const incomplete = gradeStudioCapabilityAttestation(STUDIO_CAPABILITY_MANIFEST, STUDIO_CAPABILITY_MANIFEST_HASH, projection, unavailableEnvelope);
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.unavailableFacts, 1);
  assert.equal(incomplete.findings.find((entry) => entry.key === target.key)?.code, "reflection_unavailable");

  const wrongAttachmentFacts = facts.map((fact) => {
    if (fact !== target) return fact;
    return { ...fact, result: { status: "observed" as const, value: { ...targetValue, type: { engineType: "RefType", scriptType: "Instance", enumType: "Material", instanceType: "WrongAttachment" } } } };
  });
  const wrongAttachmentEnvelope = createStudioEvidenceEnvelope({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    projectionId: projection.id,
    projectionHash: projection.contentHash,
    bindingHash: projection.bindingHash,
    project,
    authoritative: true,
    completion: "complete",
    facts: wrongAttachmentFacts,
    ...interval,
  }, projection);
  const rejected = gradeStudioCapabilityAttestation(STUDIO_CAPABILITY_MANIFEST, STUDIO_CAPABILITY_MANIFEST_HASH, projection, wrongAttachmentEnvelope);
  const finding = rejected.findings.find((entry) => entry.key === target.key && entry.code === "reflection_instance_type_mismatch");
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(finding?.received?.status === "observed" ? finding.received.value.type : undefined, { engineType: "RefType", scriptType: "Instance", enumType: "Material", instanceType: "WrongAttachment" });
});

test("canonical values retain explicit false, float32 rounding, and negative zero", () => {
  const rounded = canonicalStudioValue({ kind: "number_f32", value: 1 / 3 });
  assert.equal(rounded.kind, "number_f32");
  if (rounded.kind === "number_f32") assert.equal(rounded.value, Math.fround(1 / 3));
  assert.equal(studioValuesEqual({ kind: "boolean", value: false }, { kind: "boolean", value: false }), true);
  assert.equal(studioValuesEqual({ kind: "number_f32", value: -0 }, { kind: "number_f32", value: 0 }), false);
  assert.throws(() => canonicalStudioValue({ kind: "number_f32", value: Number.NaN }));
  assert.throws(() => canonicalStudioValue({ kind: "color3_rgb8", r: 0, g: 2.5, b: 255 }));
});

test("empty evidence lists have one cross-language canonical hash", () => {
  const emptyListTarget = { kind: "instance" as const, stableId: "empty-list-instance", path: "Workspace/EmptyList", className: "Folder" };
  assert.equal(studioEvidenceEnvelopeHash({
    kind: "StudioEvidenceEnvelope",
    manifestHash: "a".repeat(64), projectionId: "empty-list-projection", projectionHash: "b".repeat(64), bindingHash: "c".repeat(64),
    project: { name: "Empty List Vector", placeId: 0, universeId: 0 }, authoritative: true,
    startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-09-01T00:00:00.000Z", completion: "complete",
    facts: [{ kind: "tags", key: studioEvidenceFactKey("tags", emptyListTarget), target: emptyListTarget, result: { status: "observed", value: [] } }],
  }), "cde2180ccb0b6a7008e3b8b717a80444c5713847657e1db968addb5246024829");
});

test("mutation evidence requires every projected fact and permits explicitly required absence", () => {
  const projection = compileMutationEvidenceProjection({
    id: "projection-mutation-1",
    project,
    binding: { sessionId: "session-1", changeSetHash: "change-1" },
    operations: [{
      id: "update-1",
      kind: "update",
      target,
      properties: { RequiresLineOfSight: { kind: "boolean", value: false } },
      removedAttributes: ["LegacyTag"],
    }],
  });
  const property: StudioEvidenceFact = {
    kind: "property", key: studioEvidenceFactKey("property", target, "RequiresLineOfSight"), target, propertyName: "RequiresLineOfSight", result: { status: "observed", value: { kind: "boolean", value: false } },
  };
  const removed: StudioEvidenceFact = { kind: "attribute", key: studioEvidenceFactKey("attribute", target, "LegacyTag"), target, attributeName: "LegacyTag", result: { status: "absent" } };
  const complete = createStudioEvidenceEnvelope({ manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH, projectionId: projection.id, projectionHash: projection.contentHash, bindingHash: projection.bindingHash, project, authoritative: true, completion: "complete", facts: [property, removed], ...interval }, projection);
  assertEvidenceAgainstProjection(complete, projection);
  assert.equal(createStudioStateRevision(complete, projection, interval.endedAt).stateHash.length, 64);

  const incomplete = createStudioEvidenceEnvelope({ manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH, projectionId: projection.id, projectionHash: projection.contentHash, bindingHash: projection.bindingHash, project, authoritative: true, completion: "incomplete", facts: [property], ...interval });
  assert.throws(() => assertEvidenceAgainstProjection(incomplete, projection), /missing required evidence fact/);
});

test("delete projections require an explicit absent structure fact", () => {
  const projection = compileMutationEvidenceProjection({
    id: "projection-delete-1",
    project,
    binding: { sessionId: "session-delete", changeSetHash: "change-delete" },
    operations: [{ id: "delete-1", kind: "delete", target }],
  });
  assert.deepEqual(projection.requirements, [{ key: studioEvidenceFactKey("structure", target), kind: "structure", target, expectedStatus: "absent" }]);
  const envelope = createStudioEvidenceEnvelope({ manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH, projectionId: projection.id, projectionHash: projection.contentHash, bindingHash: projection.bindingHash, project, authoritative: true, completion: "complete", facts: [{ kind: "structure", key: studioEvidenceFactKey("structure", target), target, result: { status: "absent" } }], ...interval }, projection);
  assertEvidenceAgainstProjection(envelope, projection);
});

test("state delta derivation exactly covers create, update, move, delete, source, and attributes", () => {
  const prompt: Extract<StudioEvidenceTarget, { kind: "instance" }> = { kind: "instance", stableId: "prompt-update", path: "Workspace/Door/Prompt", className: "ProximityPrompt" };
  const movingModel: Extract<StudioEvidenceTarget, { kind: "instance" }> = { kind: "instance", stableId: "moving-model", path: "Workspace/Moving", className: "Model" };
  const movingChild: Extract<StudioEvidenceTarget, { kind: "instance" }> = { kind: "instance", stableId: "moving-child", path: "Workspace/Moving/Prompt", className: "ProximityPrompt" };
  const deletedModel: Extract<StudioEvidenceTarget, { kind: "instance" }> = { kind: "instance", stableId: "deleted-model", path: "Workspace/DeleteMe", className: "Model" };
  const deletedChild: Extract<StudioEvidenceTarget, { kind: "instance" }> = { kind: "instance", stableId: "deleted-child", path: "Workspace/DeleteMe/Prompt", className: "ProximityPrompt" };
  const script: Extract<StudioEvidenceTarget, { kind: "instance" }> = { kind: "instance", stableId: "source-script", path: "ServerScriptService/Source", className: "Script" };
  const before = completeProjectState([
    { target: prompt, attributes: { Existing: true } },
    { target: movingModel }, { target: movingChild, attributes: { ChildFlag: false } },
    { target: deletedModel }, { target: deletedChild, attributes: { DeleteFlag: true } },
    { target: script, attributes: { OldSource: true } },
  ]);
  const createdRemote: Extract<StudioEvidenceTarget, { kind: "instance" }> = { kind: "instance", stableId: "new-remote", path: "Workspace/NewRemote", className: "RemoteEvent" };
  const createdScript: Extract<StudioEvidenceTarget, { kind: "instance" }> = { kind: "instance", stableId: "new-script", path: "ServerScriptService/NewScript", className: "Script" };
  const movedModel: Extract<StudioEvidenceTarget, { kind: "instance" }> = { ...movingModel, path: "Workspace/Moved" };
  const delta = deriveMutationStateDelta([
    { id: "create-remote", kind: "create", target: createdRemote, attributes: { Created: false } },
    { id: "create-script", kind: "create", target: createdScript, attributes: { CreatedSource: true }, sourceHash: "b".repeat(64) },
    { id: "update-prompt", kind: "update", target: prompt, properties: { RequiresLineOfSight: { kind: "boolean", value: false } }, attributes: { Added: false }, removedAttributes: ["Existing"] },
    { id: "move-model", kind: "move", target: movedModel, structure: { stableId: movedModel.stableId, path: movedModel.path, className: movedModel.className, parentPath: "Workspace" } },
    { id: "delete-model", kind: "delete", target: deletedModel },
    { id: "write-source", kind: "write_source", target: script, attributes: { NewSource: false }, removedAttributes: ["OldSource"], sourceHash: "c".repeat(64) },
  ], before.projection, before.envelope);
  const allowed = new Set(delta.allowedStateDelta);
  assert.deepEqual(delta.allowedStateDelta, [...delta.allowedStateDelta].sort());
  assert.equal(allowed.has(studioEvidenceFactKey("inventory", { kind: "project" })), true);
  assert.equal(allowed.has(studioEvidenceFactKey("property", prompt, "RequiresLineOfSight")), true);
  assert.equal(allowed.has(studioEvidenceFactKey("attribute_inventory", prompt)), true);
  assert.equal(allowed.has(studioEvidenceFactKey("attribute", prompt, "Added")), true);
  assert.equal(allowed.has(studioEvidenceFactKey("attribute", prompt, "Existing")), true);
  assert.equal(allowed.has(studioEvidenceFactKey("remote", createdRemote)), true);
  assert.equal(allowed.has(studioEvidenceFactKey("source_body", createdScript)), true);
  assert.equal(allowed.has(studioEvidenceFactKey("source_hash", script)), true);
  assert.equal(allowed.has(studioEvidenceFactKey("source_body", script)), true);
  assert.equal(allowed.has(studioEvidenceFactKey("structure", movingChild)), true);
  const movedChild: Extract<StudioEvidenceTarget, { kind: "instance" }> = { ...movingChild, path: "Workspace/Moved/Prompt" };
  assert.equal(allowed.has(studioEvidenceFactKey("property", movedChild, "RequiresLineOfSight")), true);
  assert.equal(allowed.has(studioEvidenceFactKey("property", deletedChild, "RequiresLineOfSight")), true);
  assert.deepEqual(delta.deletedSubtrees, [{ operationId: "delete-model", descendants: [deletedChild] }]);
});

test("state delta derivation rejects a partial before-state inventory", () => {
  const before = completeProjectState([{ target: { kind: "instance", stableId: "delete-root", path: "Workspace/Delete", className: "Model" } }]);
  const partial = createStudioEvidenceEnvelope({ ...before.envelope, completion: "incomplete" });
  assert.throws(() => deriveMutationStateDelta([{ id: "delete", kind: "delete", target: { kind: "instance", stableId: "delete-root", path: "Workspace/Delete", className: "Model" } }], before.projection, partial), /complete project-state evidence required/);
});

test("project-state evidence derives a view without a snapshot shape", () => {
  const projection = compileProjectStateProjection({ id: "projection-state-1", project, binding: { sessionId: "session-2", revisionHash: "revision-2" }, roots: ["Workspace"] });
  const folder: StudioEvidenceTarget = { kind: "instance", stableId: "folder-1", path: "Workspace/Evidence", className: "Folder" };
  const facts: StudioEvidenceFact[] = [
    { kind: "inventory", key: studioEvidenceFactKey("inventory", { kind: "project" }), target: { kind: "project" }, result: { status: "observed", value: [{ stableId: "folder-1", path: "Workspace/Evidence", className: "Folder", parentPath: "Workspace" }] } },
    { kind: "structure", key: studioEvidenceFactKey("structure", folder), target: folder, result: { status: "observed", value: { stableId: "folder-1", path: "Workspace/Evidence", className: "Folder", parentPath: "Workspace" } } },
    { kind: "attribute_inventory", key: studioEvidenceFactKey("attribute_inventory", folder), target: folder, result: { status: "observed", value: [] } },
    { kind: "tags", key: studioEvidenceFactKey("tags", folder), target: folder, result: { status: "observed", value: ["forge-evidence"] } },
  ];
  const envelope = createStudioEvidenceEnvelope({ manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH, projectionId: projection.id, projectionHash: projection.contentHash, bindingHash: projection.bindingHash, project, authoritative: true, completion: "complete", facts, ...interval }, projection);
  const state = projectStateFromEvidence(envelope, projection);
  assert.deepEqual(state.instances.map((entry) => entry.path), ["Workspace/Evidence"]);
  assert.deepEqual(state.instances[0]?.tags, ["forge-evidence"]);
  const unbound = createStudioEvidenceEnvelope({ manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH, projectionId: projection.id, projectionHash: projection.contentHash, bindingHash: projection.bindingHash, project, authoritative: true, completion: "complete", facts: [...facts, { kind: "diagnostic", key: "diagnostic:unbound", target: { kind: "project" }, result: { status: "observed", value: { code: "unbound", messageHash: "a".repeat(64) } } }], ...interval });
  assert.throws(() => assertEvidenceAgainstProjection(unbound, projection), /extra or unbound/);
});

test("state revisions compare facts across approval-bound projection identities", () => {
  const folder: Extract<StudioEvidenceTarget, { kind: "instance" }> = { kind: "instance", stableId: "revision-folder", path: "Workspace/Revision", className: "Folder" };
  const initial = completeProjectState([{ target: folder }]);
  const approvedProjection = compileProjectStateProjection({
    id: "creator-mutation-before-approved",
    project,
    binding: {
      sessionId: "creator-session-approved",
      changeSetHash: "creator-change-approved",
      approvalHash: "creator-approval-approved",
      revisionHash: "approved-revision",
      dashboardReviewHash: "approved-dashboard-view",
    },
    roots: ["ServerScriptService", "Workspace"],
  });
  const approvedEnvelope = createStudioEvidenceEnvelope({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    projectionId: approvedProjection.id,
    projectionHash: approvedProjection.contentHash,
    bindingHash: approvedProjection.bindingHash,
    project,
    authoritative: true,
    completion: "complete",
    facts: initial.envelope.facts,
    ...interval,
  }, approvedProjection);
  const initialRevision = createStudioStateRevision(initial.envelope, initial.projection, interval.endedAt);
  const approvedRevision = createStudioStateRevision(approvedEnvelope, approvedProjection, interval.endedAt);

  assert.notEqual(initialRevision.projectionHash, approvedRevision.projectionHash);
  assert.equal(studioStateDomainHash(initial.projection), studioStateDomainHash(approvedProjection));
  assert.equal(initialRevision.stateDomainHash, approvedRevision.stateDomainHash);
  assert.equal(initialRevision.stateHash, approvedRevision.stateHash);

  const changedFacts = approvedEnvelope.facts.map((fact) =>
    fact.kind === "tags"
      ? { ...fact, result: { status: "observed" as const, value: ["changed-in-studio"] } }
      : fact,
  );
  const changedEnvelope = createStudioEvidenceEnvelope({
    ...approvedEnvelope,
    facts: changedFacts,
  }, approvedProjection);
  assert.notEqual(
    createStudioStateRevision(changedEnvelope, approvedProjection, interval.endedAt).stateHash,
    initialRevision.stateHash,
  );
});

test("project-state projections use the manifest state-evidence byte ceiling", () => {
  const projection = compileProjectStateProjection({ id: "projection-state-byte-bound", project, binding: { sessionId: "session-state-byte-bound" }, roots: ["Workspace"] });
  assert.equal(projection.bounds.maximumBytes, STUDIO_CAPABILITY_MANIFEST.projectState.maximumEvidenceBytes);
  const generated = readFileSync(resolve("plugin/src/Forge/GeneratedStudioEvidence.luau"), "utf8");
  assert.match(generated, /projection\.scope\.mode == "project_state" and Generated\.manifest\.projectState\.maximumEvidenceBytes/);
  assert.match(
    generated,
    new RegExp(`Generated\\.connectorBuildHash = "${STUDIO_CONNECTOR_BUILD_HASH}"`),
  );
});

test("connector build identity changes with authored plugin runtime source", () => {
  const directory = mkdtempSync(join(tmpdir(), "forge-connector-identity-"));
  try {
    for (const path of [
      "scripts",
      "packages/studio-evidence/manifest",
      "packages/studio-evidence/catalog",
      "packages/studio-evidence/src",
      "packages/studio-protocol/src",
      "plugin",
    ]) mkdirSync(join(directory, path), { recursive: true });
    cpSync(resolve("scripts/generate-studio-evidence.mjs"), join(directory, "scripts/generate-studio-evidence.mjs"));
    cpSync(resolve("packages/studio-evidence/manifest/studio-capability-manifest.json"), join(directory, "packages/studio-evidence/manifest/studio-capability-manifest.json"));
    cpSync(resolve("packages/studio-evidence/manifest/studio-capability-policy.json"), join(directory, "packages/studio-evidence/manifest/studio-capability-policy.json"));
    cpSync(resolve("packages/studio-evidence/catalog/roblox-api-catalog.json"), join(directory, "packages/studio-evidence/catalog/roblox-api-catalog.json"));
    cpSync(resolve("packages/studio-evidence/src/index.ts"), join(directory, "packages/studio-evidence/src/index.ts"));
    cpSync(resolve("packages/studio-protocol/src/index.ts"), join(directory, "packages/studio-protocol/src/index.ts"));
    cpSync(resolve("plugin/src"), join(directory, "plugin/src"), { recursive: true });
    cpSync(resolve("plugin/default.project.json"), join(directory, "plugin/default.project.json"));
    const generator = join(directory, "scripts/generate-studio-evidence.mjs");
    execFileSync(process.execPath, [generator]);
    const generatedPath = join(directory, "packages/studio-evidence/src/generated.ts");
    const before = readFileSync(generatedPath, "utf8").match(/STUDIO_CONNECTOR_BUILD_HASH = "([0-9a-f]{64})"/)?.[1];
    appendFileSync(join(directory, "plugin/src/Forge/RuntimeCapabilityExecutor.luau"), "\n-- identity regression vector\n");
    execFileSync(process.execPath, [generator]);
    const after = readFileSync(generatedPath, "utf8").match(/STUDIO_CONNECTOR_BUILD_HASH = "([0-9a-f]{64})"/)?.[1];
    assert.ok(before && after);
    assert.notEqual(after, before);

    const afterPluginSource = after;
    appendFileSync(join(directory, "packages/studio-evidence/src/index.ts"), "\n// evidence contract identity regression vector\n");
    execFileSync(process.execPath, [generator]);
    const afterEvidenceContract = readFileSync(generatedPath, "utf8").match(/STUDIO_CONNECTOR_BUILD_HASH = "([0-9a-f]{64})"/)?.[1];
    assert.ok(afterEvidenceContract);
    assert.notEqual(afterEvidenceContract, afterPluginSource);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("catalog type namespaces and nullable Instance values remain proof-closed", () => {
  assert.equal(STUDIO_CAPABILITY_MANIFEST.classes.some((entry) => entry.properties.some((property) => property.name === "FontFace")), false);
  assert.equal(STUDIO_CAPABILITY_COVERAGE_REPORT.entries.find((entry) => entry.catalogEntryId === "enum:Font")?.disposition, "source_only");
  const referenceProperty = STUDIO_CAPABILITY_MANIFEST.classes.find((entry) => entry.name === "ObjectValue")?.properties.find((property) => property.name === "Value");
  assert.ok(referenceProperty);
  const nilReference = { kind: "instance_ref", state: "nil", expectedClass: "Instance" } as const;
  assert.doesNotThrow(() => canonicalStudioValue(nilReference, referenceProperty));
  assert.notEqual(
    canonicalStudioValueMaterial(nilReference),
    canonicalStudioValueMaterial({ kind: "instance_ref", state: "reference", stableId: "part", path: "Workspace/Part", className: "Part", expectedClass: "Instance" }),
  );
  assert.throws(
    () => canonicalStudioValue({ kind: "instance_ref", state: "reference", stableId: "folder", path: "Workspace/Folder", className: "Folder", expectedClass: "BasePart" }),
    /instance reference/i,
  );
});

test("immutable evidence validates against its stored manifest rather than today's policy", () => {
  const legacyProperty = { name: "LegacyFlag", codec: "boolean" as const, catalogType: { category: "primitive" as const, name: "boolean" }, reflection: { engineType: "bool", scriptType: "boolean" }, declaringClass: "Folder", proof: ["canonicalize", "validate", "preflight", "write", "read", "project", "compare"] as const };
  const storedManifest: StudioCapabilityManifest = {
    ...STUDIO_CAPABILITY_MANIFEST,
    classes: STUDIO_CAPABILITY_MANIFEST.classes.map((entry) => entry.name === "Folder" ? { ...entry, properties: [legacyProperty] } : entry),
  };
  const manifestHash = "f".repeat(64);
  const legacyTarget = { kind: "instance" as const, stableId: "legacy-folder", path: "Workspace/Legacy", className: "Folder" };
  const requirement = { kind: "property" as const, key: studioEvidenceFactKey("property", legacyTarget, "LegacyFlag"), target: legacyTarget, propertyName: "LegacyFlag", expected: { kind: "boolean" as const, value: false } };
  const projection = createStudioEvidenceProjection({ id: "stored-manifest-projection", manifestHash, purpose: "mutation_direct_readback", project, binding: { sessionId: "stored-manifest-session" }, requirements: [requirement], scope: { mode: "exact", roots: storedManifest.roots, requireCompleteInventory: false }, bounds: { maximumFacts: storedManifest.limits.maximumProjectionFacts, maximumBytes: storedManifest.limits.maximumProjectionBytes, roots: storedManifest.roots } }, storedManifest);
  const envelope = createStudioEvidenceEnvelope({ manifestHash, projectionId: projection.id, projectionHash: projection.contentHash, bindingHash: projection.bindingHash, project, authoritative: true, completion: "complete", facts: [{ kind: "property", key: requirement.key, target: legacyTarget, propertyName: "LegacyFlag", result: { status: "observed", value: { kind: "boolean", value: false } } }], ...interval }, projection, storedManifest);
  assert.doesNotThrow(() => assertStudioEvidenceEnvelope(envelope, projection, storedManifest));
  assert.throws(() => assertStudioEvidenceEnvelope(envelope, projection), /property outside manifest/i);
});

test("facts reject omitted observed payloads and unapproved extra fields", () => {
  assert.throws(() => assertStudioEvidenceFact({ kind: "property", key: "property:test", target, propertyName: "RequiresLineOfSight", result: { status: "observed" } }), /keys/);
  assert.throws(() => assertStudioEvidenceFact({ kind: "property", key: "property:test", target, propertyName: "RequiresLineOfSight", result: { status: "absent" }, invented: true }), /keys/);
});

test("Rojo seeds assign deterministic identities and persist transforms as CFrames", () => {
  const manifestClasses = new Set(STUDIO_CAPABILITY_MANIFEST.classes.map((entry) => entry.name));
  for (const fixture of ["examples/door-control/default.project.json", "examples/status-beacon/default.project.json", "examples/orbital-freight-airlock/default.project.json"]) {
    const parsed = JSON.parse(readFileSync(resolve(fixture), "utf8")) as { tree: Record<string, unknown> };
    const stableIds = new Set<string>();
    let applicable = 0;
    const visit = (node: unknown): void => {
      if (typeof node !== "object" || node === null || Array.isArray(node)) return;
      const record = node as Record<string, unknown>;
      const className = record.$className;
      if (typeof className === "string" && manifestClasses.has(className)) {
        applicable += 1;
        const stableId = (record.$attributes as Record<string, unknown> | undefined)?._forgeStableId;
        assert.equal(typeof stableId, "string", `${fixture} ${className} needs a stable identity`);
        assert.equal(stableIds.has(stableId as string), false, `${fixture} duplicates ${stableId}`);
        stableIds.add(stableId as string);
      }
      const properties = record.$properties as Record<string, unknown> | undefined;
      if (properties?.CFrame !== undefined) {
        assert.equal("Position" in properties, false, `${fixture} must not persist a derived Position`);
        assert.equal(Array.isArray(properties.CFrame) && properties.CFrame.length === 12 && properties.CFrame.every((value) => typeof value === "number" && Number.isFinite(value)), true, `${fixture} needs a finite 12-component CFrame`);
      }
      for (const [key, child] of Object.entries(record)) if (!key.startsWith("$")) visit(child);
    };
    visit(parsed.tree);
    assert.ok(applicable > 0, `${fixture} has no manifest-applicable instances`);
  }
});

test("Orbital Freight Airlock is an interconnected but solution-free creator seed", () => {
  const fixture = JSON.parse(readFileSync(resolve("examples/orbital-freight-airlock/default.project.json"), "utf8")) as { tree: Record<string, unknown> };
  const at = (path: string): Record<string, unknown> => {
    let current: unknown = fixture.tree;
    for (const segment of path.split("/")) current = (current as Record<string, unknown>)[segment];
    assert.equal(typeof current, "object", `${path} must exist in the seed`);
    assert.notEqual(current, null, `${path} must exist in the seed`);
    return current as Record<string, unknown>;
  };
  for (const path of [
    "Workspace/OrbitalFreightAirlock/OuterDoor",
    "Workspace/OrbitalFreightAirlock/InnerDoor",
    "Workspace/OrbitalFreightAirlock/PowerConsole",
    "Workspace/OrbitalFreightAirlock/CoolantValve",
    "Workspace/OrbitalFreightAirlock/CargoScanner",
    "Workspace/OrbitalFreightAirlock/EmergencyConsole",
    "Workspace/OrbitalFreightAirlock/Indicators/Power",
    "Workspace/OrbitalFreightAirlock/Indicators/Pressure",
    "Workspace/OrbitalFreightAirlock/Indicators/Clearance",
    "Workspace/PreservedScenery",
    "ReplicatedStorage/AirlockSystem",
    "StarterGui/AirlockHUD/Panel",
  ]) at(path);
  assert.deepEqual(Object.keys(at("ReplicatedStorage/AirlockSystem")).sort(), ["$attributes", "$className"]);
  assert.deepEqual(Object.keys(at("StarterGui/AirlockHUD/Panel")).sort(), ["$attributes", "$className"]);
  const forbidden = new Set(["ProximityPrompt", "RemoteEvent", "RemoteFunction", "Script", "LocalScript", "ModuleScript"]);
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    assert.equal(forbidden.has(String(record.$className)), false, `seed must not contain solution class ${String(record.$className)}`);
    assert.equal((record.$properties as Record<string, unknown> | undefined)?.Source, undefined, "seed must not contain source");
    for (const [key, child] of Object.entries(record)) if (!key.startsWith("$")) visit(child);
  };
  visit(fixture.tree);
});

test("one generated Studio limit policy supports ordinary and interconnected runs", () => {
  assert.deepEqual(STUDIO_CAPABILITY_MANIFEST.limits, {
    maximumOperations: 128,
    maximumProjectionBytes: 524_288,
    maximumProjectionFacts: 16_384,
    maximumRuntimeCalls: 128,
    maximumRuntimeMs: 300_000,
    maximumRuntimeResultBytes: 524_288,
    maximumRuntimeTargets: 64,
  });
  assert.equal(STUDIO_CAPABILITY_MANIFEST.projectState.maximumInstances, 2_048);
  assert.equal(STUDIO_CAPABILITY_MANIFEST.projectState.maximumEvidenceBytes, 8_388_608);
  for (const capability of STUDIO_CAPABILITY_MANIFEST.runtimeCapabilities.filter((entry) => entry.name.endsWith(".property_series") || entry.name.endsWith(".position_series")))
    assert.equal(capability.maximumSamples, 128);
});
