/**
 * The Studio evidence vocabulary deliberately has no dependency on a Studio
 * transport, a provider, or the creator coordinator.  It is the small common
 * language shared by the writer, reader, projection compiler, and replay.
 */
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST as GENERATED_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH as GENERATED_MANIFEST_HASH,
  STUDIO_CONNECTOR_BUILD_HASH as GENERATED_CONNECTOR_BUILD_HASH,
  STUDIO_CAPABILITY_COVERAGE_REPORT as GENERATED_COVERAGE_REPORT,
  STUDIO_CAPABILITY_COVERAGE_REPORT_HASH as GENERATED_COVERAGE_REPORT_HASH,
  STUDIO_EVIDENCE_VECTORS,
  PROJECT_IDENTITY_AUTHORITY_VECTORS,
  STUDIO_PROJECT_INDEX_CANONICAL_VECTORS,
  STUDIO_WRITABLE_CLASSES as GENERATED_WRITABLE_CLASSES,
  STUDIO_AUTHORING_ROOTS as GENERATED_AUTHORING_ROOTS,
  STUDIO_AUTHORING_CONTAINERS as GENERATED_AUTHORING_CONTAINERS,
  STUDIO_SCRIPT_CLASSES as GENERATED_SCRIPT_CLASSES,
  STUDIO_RESOLVABLE_CLASSES as GENERATED_RESOLVABLE_CLASSES,
} from "./generated.js";

export * from "./project-index.js";
export * from "./project-authority.js";
import {
  assertStudioObjectIdentity,
  studioObjectIdentityKey,
  type StudioObjectIdentity,
} from "./project-index.js";
import type { StudioCapabilityCoverageReport, StudioInstanceReference } from "./catalog.js";
import { isRobloxClassAssignableTo as catalogClassAssignableTo } from "./catalog-runtime.js";
export type {
  RobloxApiCatalog,
  RobloxApiCatalogCounts,
  RobloxApiCatalogEntryKind,
  RobloxApiCatalogSource,
  RobloxApiClass,
  RobloxApiDatatype,
  RobloxApiEnum,
  RobloxApiGlobalMember,
  RobloxApiLibrary,
  RobloxApiLibraryMember,
  RobloxClassMember,
  RobloxDatatypeMember,
  RobloxGlobalMemberKind,
  RobloxLibraryMemberKind,
  StudioCapabilityCoverageEntry,
  StudioCapabilityCoverageReport,
  StudioCapabilityCoverageSummary,
  StudioCapabilityDisposition,
  StudioCapabilityReason,
  StudioInstanceReference,
} from "./catalog.js";
export {
  ROBLOX_API_CATALOG,
  ROBLOX_API_CATALOG_HASH,
  getRobloxApiClass,
  isRobloxClassAssignableTo,
  resolveRobloxClassMembers,
  validateRobloxApiCatalog,
} from "./catalog-runtime.js";
export {
  getRobloxApiCatalogLookupEntry,
  lookupRobloxApiCatalog,
  type RobloxApiCatalogLookupEntry,
  type RobloxApiCatalogLookupRequest,
  type RobloxApiCatalogLookupResult,
} from "./catalog-query.js";

export type StudioOperationKind = "create" | "delete" | "edit_source" | "move" | "update";
/**
 * The storage-domain codec vocabulary shared by the TypeScript verifier and
 * generated Luau.  A codec is enabled for authoring only when a manifest row
 * declares the complete proof route; merely being represented here grants no
 * Studio authority.
 */
export const STUDIO_CODECS = [
  "boolean",
  "number_f32",
  "number_f64",
  "int32",
  "int64_decimal",
  "string_utf8",
  "content",
  "color3_rgb8",
  "vector2_f32",
  "vector3_f32",
  "cframe_f32x12",
  "udim",
  "udim2",
  "rect",
  "number_range",
  "number_sequence",
  "color_sequence",
  "brick_color",
  "font",
  "physical_properties",
  "axes",
  "faces",
  "ray",
  "instance_ref",
  "enum_name",
] as const;
export type StudioCodec = (typeof STUDIO_CODECS)[number];
export type StudioProofStage =
  "canonicalize" | "validate" | "preflight" | "write" | "read" | "project" | "compare";
export type StudioSourceRule = "forbidden" | "required_on_create_and_writeable";
/** The exact value-type identity recorded by the pinned official API catalog. */
export type StudioCatalogTypeCategory = "primitive" | "datatype" | "enum" | "class";
export interface StudioCatalogType {
  readonly category: StudioCatalogTypeCategory;
  readonly name: string;
}

/**
 * Closed ReflectionService compatibility obligations. EngineType describes
 * the engine/storage domain, while ScriptType describes the Luau-facing
 * domain. EnumType and InstanceType further constrain those reference kinds.
 */
export interface StudioReflectionTypeExpectation {
  readonly engineType: string;
  readonly scriptType: string;
  readonly enumType?: string;
  readonly instanceType?: string;
}

export interface StudioManifestProperty {
  readonly name: string;
  readonly codec: StudioCodec;
  /** Source type identity generated from the pinned official API catalog. */
  readonly catalogType: StudioCatalogType;
  /** Exact cross-domain ReflectionService contract generated for this row. */
  readonly reflection: StudioReflectionTypeExpectation;
  /** Catalog class which declares this property, including inherited rows. */
  readonly declaringClass: string;
  readonly serialized?: boolean;
  readonly allowed?: readonly string[];
  readonly minimum?: number;
  readonly minimumExclusive?: number;
  readonly maximum?: number;
  readonly maximumAbsoluteTranslation?: number;
  /** Optional minimum UTF-8 byte length for text/content property values. */
  readonly minimumUtf8Bytes?: number;
  readonly maximumUtf8Bytes?: number;
  /** Explicit sequence cap for variable-size, cross-language value codecs. */
  readonly maximumEntries?: number;
  /**
   * The generated property-specific capability admits the explicit canonical
   * nil value. This is deliberately per-property: sharing a codec never
   * implies that every property of that codec accepts nil.
   */
  readonly nullable: boolean;
  /** Ancestor constraint for a stable, Forge-owned Instance reference. */
  readonly referenceClass?: string;
  readonly proof: readonly StudioProofStage[];
}

export interface StudioManifestClass {
  readonly name: string;
  readonly creatable: boolean;
  readonly source: StudioSourceRule;
  readonly properties: readonly StudioManifestProperty[];
}

/**
 * Engine-owned topology that may serve as a mutation parent but is never
 * treated as a Forge-owned mutable project instance.
 */
export interface StudioAuthoringContainer {
  readonly path: string;
  readonly className: string;
}

export interface StudioCapabilityManifest {
  readonly kind: "StudioCapabilityManifest";
  /** Binds every manifest use to the exact generated/host evidence algebra. */
  readonly evidenceContractHash: string;
  readonly roots: readonly string[];
  readonly authoringContainers: readonly StudioAuthoringContainer[];
  readonly operationKinds: readonly StudioOperationKind[];
  readonly classes: readonly StudioManifestClass[];
  readonly attributes: {
    readonly codecs: readonly Extract<StudioCodec, "boolean" | "number_f32" | "string_utf8">[];
    readonly maximumCount: number;
    readonly maximumNameUtf8Bytes: number;
    readonly maximumStringUtf8Bytes: number;
    readonly reservedPrefix: string;
  };
  readonly source: {
    readonly maximumUtf8Bytes: number;
    readonly evidence: "sha256";
  };
  readonly runtimeCapabilities: readonly {
    readonly name: string;
    readonly result:
      | "vector3_f32"
      | "position_series_f32"
      | "manifest_property"
      | "manifest_property_series"
      | "instance_identity";
    readonly maximumSamples?: number;
    readonly minimumIntervalMs?: number;
    readonly maximumIntervalMs?: number;
  }[];
  readonly limits: {
    readonly maximumDiagnostics: number;
    readonly maximumOperations: number;
    readonly maximumProjectionFacts: number;
    readonly maximumProjectionBytes: number;
    readonly maximumRuntimeTargets: number;
    readonly maximumRuntimeCalls: number;
    readonly maximumRuntimeMs: number;
    readonly maximumRuntimeResultBytes: number;
  };
}

/** Canonical values are storage-domain values, not lossy JavaScript values. */
export interface StudioUdimValue {
  readonly scale: number;
  readonly offset: number;
}
export interface StudioNumberSequenceKeypoint {
  readonly time: number;
  readonly value: number;
  readonly envelope: number;
}
export interface StudioColorSequenceKeypoint {
  readonly time: number;
  readonly color: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
  };
}
/** Explicit engine nil; distinct from a missing evidence fact or an absent Instance reference. */
export interface StudioNilValue {
  readonly kind: "nil";
  /**
   * The exact manifest codec whose nil domain this represents. Instance
   * references retain their class-constrained `state: "nil"` representation.
   */
  readonly expectedCodec: Exclude<StudioCodec, "instance_ref">;
}
export type StudioValue =
  | StudioNilValue
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number_f32"; readonly value: number }
  | { readonly kind: "number_f64"; readonly value: number }
  | { readonly kind: "int32"; readonly value: number }
  | { readonly kind: "int64_decimal"; readonly value: string }
  | { readonly kind: "string_utf8"; readonly value: string }
  | { readonly kind: "content"; readonly value: string }
  | {
      readonly kind: "color3_rgb8";
      readonly r: number;
      readonly g: number;
      readonly b: number;
    }
  | { readonly kind: "vector2_f32"; readonly x: number; readonly y: number }
  | {
      readonly kind: "vector3_f32";
      readonly x: number;
      readonly y: number;
      readonly z: number;
    }
  | { readonly kind: "cframe_f32x12"; readonly components: readonly number[] }
  | { readonly kind: "udim"; readonly scale: number; readonly offset: number }
  | {
      readonly kind: "udim2";
      readonly x: StudioUdimValue;
      readonly y: StudioUdimValue;
    }
  | {
      readonly kind: "rect";
      readonly minX: number;
      readonly minY: number;
      readonly maxX: number;
      readonly maxY: number;
    }
  | {
      readonly kind: "number_range";
      readonly min: number;
      readonly max: number;
    }
  | {
      readonly kind: "number_sequence";
      readonly keypoints: readonly StudioNumberSequenceKeypoint[];
    }
  | {
      readonly kind: "color_sequence";
      readonly keypoints: readonly StudioColorSequenceKeypoint[];
    }
  | { readonly kind: "brick_color"; readonly name: string }
  | {
      readonly kind: "font";
      readonly family: string;
      readonly weight: string;
      readonly style: string;
    }
  | {
      readonly kind: "physical_properties";
      readonly density: number;
      readonly friction: number;
      readonly elasticity: number;
      readonly frictionWeight: number;
      readonly elasticityWeight: number;
    }
  | {
      readonly kind: "axes";
      readonly x: boolean;
      readonly y: boolean;
      readonly z: boolean;
    }
  | {
      readonly kind: "faces";
      readonly top: boolean;
      readonly bottom: boolean;
      readonly left: boolean;
      readonly right: boolean;
      readonly front: boolean;
      readonly back: boolean;
    }
  | {
      readonly kind: "ray";
      readonly origin: {
        readonly x: number;
        readonly y: number;
        readonly z: number;
      };
      readonly direction: {
        readonly x: number;
        readonly y: number;
        readonly z: number;
      };
    }
  | StudioInstanceReference
  | { readonly kind: "enum_name"; readonly value: string };

export type StudioPrimitiveValue = boolean | number | string;
export type StudioEvidencePurpose =
  | "mutation_preflight"
  | "mutation_direct_readback"
  | "runtime_evaluation"
  | "capability_attestation"
  | "creator_verification";

export interface StudioProjectIdentity {
  readonly name: string;
  readonly placeId: number;
  readonly universeId: number;
}
export type StudioEvidenceTarget =
  | { readonly kind: "project" }
  | {
      readonly kind: "instance";
      readonly identity: StudioObjectIdentity;
      readonly path: string;
      readonly className: string;
    };

export interface StudioStructureValue {
  readonly identity: StudioObjectIdentity;
  readonly path: string;
  readonly className: string;
  readonly parentIdentity?: StudioObjectIdentity;
  readonly parentPath?: string;
}
export interface StudioRuntimeResolutionValue {
  readonly path: string;
  readonly className: string;
}
export interface StudioPositionSample {
  readonly sequence: number;
  readonly elapsedMs: number;
  readonly value: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
}
/** Fixed-runtime samples of a manifest-authorized property; no callbacks run. */
export interface StudioManifestPropertySample {
  readonly sequence: number;
  readonly elapsedMs: number;
  readonly value: StudioValue;
}
/**
 * Raw ReflectionService type dimensions. They are transport evidence only;
 * interpreting them against the catalog belongs exclusively to the backend.
 */
export interface StudioReflectionTypeValue {
  readonly engineType?: string;
  readonly scriptType?: string;
  readonly enumType?: string;
  readonly instanceType?: string;
}
/** Reflection reports the plugin's present security context; it never expands the manifest. */
export interface StudioReflectionValue {
  readonly className: string;
  readonly propertyName: string;
  readonly owner: string;
  readonly type: StudioReflectionTypeValue;
  readonly inherited: boolean;
  readonly serialized: boolean;
  /** Sorted current-security permissions reported by ReflectionService. */
  readonly permits: readonly ("read" | "write")[];
}
export interface StudioRemoteValue {
  readonly name: string;
  readonly className: "RemoteEvent" | "RemoteFunction";
  readonly direction: "client_to_server" | "server_to_client";
}
export interface StudioDiagnosticValue {
  readonly code: string;
  readonly messageHash: string;
}

export type StudioFactResult<T> =
  | { readonly status: "observed"; readonly value: T }
  | { readonly status: "absent" }
  | { readonly status: "unavailable"; readonly code: string }
  | { readonly status: "read_error"; readonly code: string };

export type StudioEvidenceFact =
  | {
      readonly kind: "structure";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly result: StudioFactResult<StudioStructureValue>;
    }
  | {
      readonly kind: "property";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly propertyName: string;
      readonly result: StudioFactResult<StudioValue>;
    }
  | {
      readonly kind: "attribute_inventory";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly result: StudioFactResult<readonly string[]>;
    }
  | {
      readonly kind: "attribute";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly attributeName: string;
      readonly result: StudioFactResult<StudioPrimitiveValue>;
    }
  | {
      readonly kind: "source_hash";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly result: StudioFactResult<string>;
    }
  | {
      readonly kind: "tags";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly result: StudioFactResult<readonly string[]>;
    }
  | {
      readonly kind: "remote";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly result: StudioFactResult<StudioRemoteValue>;
    }
  | {
      readonly kind: "runtime_resolution";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly callId: string;
      readonly runtimeTargetId: string;
      readonly capability: "instance.resolve";
      readonly result: StudioFactResult<StudioRuntimeResolutionValue>;
    }
  | {
      readonly kind: "position";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly callId?: string;
      readonly runtimeTargetId?: string;
      readonly capability?: "base_part.position";
      readonly result: StudioFactResult<StudioValue & { readonly kind: "vector3_f32" }>;
    }
  | {
      readonly kind: "position_series";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly callId: string;
      readonly runtimeTargetId: string;
      readonly capability: "base_part.position_series";
      readonly result: StudioFactResult<readonly StudioPositionSample[]>;
    }
  | {
      readonly kind: "runtime_property";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly propertyName: string;
      readonly callId: string;
      readonly runtimeTargetId: string;
      readonly capability: "instance.property";
      readonly result: StudioFactResult<StudioValue>;
    }
  | {
      readonly kind: "runtime_property_series";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly propertyName: string;
      readonly callId: string;
      readonly runtimeTargetId: string;
      readonly capability: "instance.property_series";
      readonly result: StudioFactResult<readonly StudioManifestPropertySample[]>;
    }
  | {
      readonly kind: "diagnostic";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly result: StudioFactResult<StudioDiagnosticValue>;
    }
  | {
      readonly kind: "reflection";
      readonly key: string;
      readonly target: StudioEvidenceTarget;
      readonly result: StudioFactResult<StudioReflectionValue>;
    };

export type StudioFactKind = StudioEvidenceFact["kind"];
/** Every observed evidence payload is drawn from this closed value universe. */
export type StudioEvidenceValue =
  | StudioValue
  | StudioPrimitiveValue
  | StudioStructureValue
  | StudioRuntimeResolutionValue
  | StudioRemoteValue
  | StudioDiagnosticValue
  | StudioReflectionValue
  | readonly StudioPositionSample[]
  | readonly StudioManifestPropertySample[]
  | readonly string[];
export type StudioRequirementValue = StudioEvidenceValue;

/** A required fact is its stable key plus the only legal target and payload slot. */
export interface StudioEvidenceRequirement {
  readonly key: string;
  readonly kind: StudioFactKind;
  readonly target: StudioEvidenceTarget;
  readonly propertyName?: string;
  readonly attributeName?: string;
  readonly callId?: string;
  readonly runtimeTargetId?: string;
  readonly capability?:
    | "instance.resolve"
    | "base_part.position"
    | "base_part.position_series"
    | "instance.property"
    | "instance.property_series";
  /** `absent` is a legal postcondition only when the projection says so. */
  readonly expectedStatus?: "observed" | "absent";
  readonly expected?: StudioRequirementValue;
}

export interface StudioEvidenceBinding {
  readonly sessionId?: string;
  readonly changeSetHash?: string;
  readonly approvalHash?: string;
  readonly revisionHash?: string;
  readonly buildHash?: string;
  readonly dashboardReviewHash?: string;
  readonly executionPlanHash?: string;
  readonly nonceCommitment?: string;
  readonly pairingHash?: string;
  readonly attestationHash?: string;
  readonly [name: string]: string | undefined;
}

export interface StudioEvidenceBounds {
  readonly maximumFacts: number;
  readonly maximumBytes: number;
  readonly roots: readonly string[];
}
export interface StudioEvidenceScope {
  readonly roots: readonly string[];
}
export interface StudioEvidenceProjection {
  readonly kind: "StudioEvidenceProjection";
  readonly id: string;
  readonly manifestHash: string;
  readonly purpose: StudioEvidencePurpose;
  readonly project: StudioProjectIdentity;
  readonly binding: StudioEvidenceBinding;
  readonly bindingHash: string;
  readonly requirements: readonly StudioEvidenceRequirement[];
  readonly scope: StudioEvidenceScope;
  readonly bounds: StudioEvidenceBounds;
  /** Hash of every semantically relevant projection field, never a timestamp. */
  readonly contentHash: string;
}

export interface StudioEvidenceEnvelope {
  readonly kind: "StudioEvidenceEnvelope";
  readonly manifestHash: string;
  readonly projectionId: string;
  readonly projectionHash: string;
  readonly bindingHash: string;
  readonly project: StudioProjectIdentity;
  readonly authoritative: true;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly completion: "complete" | "incomplete";
  readonly facts: readonly StudioEvidenceFact[];
  readonly diagnostics?: readonly StudioDiagnosticValue[];
  readonly contentHash: string;
}

export type RuntimeEvidenceResult =
  | {
      readonly id: string;
      readonly capability: "instance.resolve";
      readonly targetId: string;
      readonly status: "resolved" | "missing" | "unavailable";
      readonly path?: string;
      readonly className?: string;
    }
  | {
      readonly id: string;
      readonly capability: "base_part.position";
      readonly targetId: string;
      readonly status: "ok" | "unavailable";
      readonly position?: {
        readonly x: number;
        readonly y: number;
        readonly z: number;
      };
    }
  | {
      readonly id: string;
      readonly capability: "base_part.position_series";
      readonly targetId: string;
      readonly status: "ok" | "unavailable";
      readonly samples?: readonly StudioPositionSample[];
    }
  | {
      readonly id: string;
      readonly capability: "instance.property";
      readonly targetId: string;
      readonly propertyName: string;
      readonly status: "ok" | "unavailable";
      readonly value?: StudioValue;
    }
  | {
      readonly id: string;
      readonly capability: "instance.property_series";
      readonly targetId: string;
      readonly propertyName: string;
      readonly status: "ok" | "unavailable";
      readonly samples?: readonly StudioManifestPropertySample[];
    };

export const STUDIO_CAPABILITY_MANIFEST = GENERATED_MANIFEST as StudioCapabilityManifest;
export const STUDIO_CAPABILITY_MANIFEST_HASH: string = GENERATED_MANIFEST_HASH;
export const STUDIO_CONNECTOR_BUILD_HASH: string = GENERATED_CONNECTOR_BUILD_HASH;
/** Exhaustive catalog accountability; it does not itself authorize mutation. */
export const STUDIO_CAPABILITY_COVERAGE_REPORT: StudioCapabilityCoverageReport =
  GENERATED_COVERAGE_REPORT as StudioCapabilityCoverageReport;
export const STUDIO_CAPABILITY_COVERAGE_REPORT_HASH: string = GENERATED_COVERAGE_REPORT_HASH;
export const STUDIO_WRITABLE_CLASSES = GENERATED_WRITABLE_CLASSES;
export const STUDIO_AUTHORING_ROOTS = GENERATED_AUTHORING_ROOTS;
export const STUDIO_AUTHORING_CONTAINERS =
  GENERATED_AUTHORING_CONTAINERS as readonly StudioAuthoringContainer[];
export const STUDIO_SCRIPT_CLASSES = GENERATED_SCRIPT_CLASSES;
export const STUDIO_RESOLVABLE_CLASSES = GENERATED_RESOLVABLE_CLASSES;
export { STUDIO_EVIDENCE_VECTORS };
export { PROJECT_IDENTITY_AUTHORITY_VECTORS };
export { STUDIO_PROJECT_INDEX_CANONICAL_VECTORS };
export {
  STUDIO_CREATOR_MUTATION_BINDING_SCHEMA,
  isStudioCreatorMutationBinding,
  matchesStudioCreatorMutationBinding,
  type StudioCreatorMutationBinding,
} from "./generated.js";

const PROOF_STAGES: readonly StudioProofStage[] = [
  "canonicalize",
  "validate",
  "preflight",
  "write",
  "read",
  "project",
  "compare",
];
const FACT_KINDS: readonly StudioFactKind[] = [
  "attribute",
  "attribute_inventory",
  "diagnostic",
  "position",
  "position_series",
  "property",
  "reflection",
  "remote",
  "runtime_property",
  "runtime_property_series",
  "runtime_resolution",
  "source_hash",
  "structure",
  "tags",
];
const PURPOSES: readonly StudioEvidencePurpose[] = [
  "mutation_preflight",
  "mutation_direct_readback",
  "runtime_evaluation",
  "capability_attestation",
  "creator_verification",
];

export function assertStudioCapabilityManifest(
  value: unknown,
): asserts value is StudioCapabilityManifest {
  const manifest = record(value, "StudioCapabilityManifest");
  exactKeys(
    manifest,
    [
      "kind",
      "evidenceContractHash",
      "roots",
      "authoringContainers",
      "operationKinds",
      "classes",
      "attributes",
      "source",
      "runtimeCapabilities",
      "limits",
    ],
    "StudioCapabilityManifest",
  );
  if (manifest.kind !== "StudioCapabilityManifest") fail("manifest kind");
  if (!hash(manifest.evidenceContractHash)) fail("manifest evidence contract hash");
  const roots = stringArray(manifest.roots, "manifest roots");
  sortedUnique(roots, "manifest roots");
  const containers = array(manifest.authoringContainers, "manifest authoring containers");
  let previousContainer = "";
  const containerPaths = new Set<string>();
  for (const entry of containers) {
    const container = record(entry, "manifest authoring container");
    exactKeys(container, ["path", "className"], "manifest authoring container");
    if (
      !nonEmpty(container.path) ||
      !nonEmpty(container.className) ||
      String(container.path) <= previousContainer
    )
      fail("manifest authoring container");
    const path = String(container.path);
    const pieces = path.split("/");
    if (
      pieces.some((piece) => piece.length === 0 || piece === "." || piece === "..") ||
      !roots.includes(pieces[0]!) ||
      pieces.at(-1) !== container.className
    )
      fail("manifest authoring container path or class");
    if (pieces.length > 1 && !containerPaths.has(pieces.slice(0, -1).join("/")))
      fail("manifest authoring container parent closure");
    previousContainer = path;
    containerPaths.add(path);
  }
  if (roots.some((root) => !containerPaths.has(root)))
    fail("manifest authoring root container closure");
  const operations = stringArray(manifest.operationKinds, "manifest operationKinds");
  sortedUnique(operations, "manifest operationKinds");
  if (
    !operations.every((entry) =>
      ["create", "delete", "edit_source", "move", "update"].includes(entry),
    )
  )
    fail("manifest operation kind");
  const classes = array(manifest.classes, "manifest classes");
  let previousClass = "";
  for (const entry of classes) {
    const item = record(entry, "manifest class");
    exactKeys(item, ["name", "creatable", "source", "properties"], "manifest class");
    if (
      !nonEmpty(item.name) ||
      item.name <= previousClass ||
      typeof item.creatable !== "boolean" ||
      !["forbidden", "required_on_create_and_writeable"].includes(String(item.source))
    )
      fail("manifest class");
    previousClass = item.name;
    const properties = array(item.properties, "manifest properties");
    let previousProperty = "";
    for (const propertyValue of properties) {
      const property = record(propertyValue, "manifest property");
      const allowed = [
        "name",
        "codec",
        "catalogType",
        "reflection",
        "declaringClass",
        "serialized",
        "allowed",
        "minimum",
        "minimumExclusive",
        "maximum",
        "maximumAbsoluteTranslation",
        "minimumUtf8Bytes",
        "maximumUtf8Bytes",
        "maximumEntries",
        "nullable",
        "referenceClass",
        "proof",
      ];
      exactKeys(
        property,
        allowed.filter((key) => property[key] !== undefined),
        "manifest property",
      );
      if (
        !nonEmpty(property.name) ||
        property.name <= previousProperty ||
        !isCodec(property.codec) ||
        !nonEmpty(property.declaringClass)
      )
        fail("manifest property");
      assertCatalogType(property.catalogType);
      const catalogType = property.catalogType as StudioCatalogType;
      assertReflectionTypeExpectation(property.reflection, catalogType);
      if ((property.codec === "enum_name") !== (catalogType.category === "enum"))
        fail("manifest property catalog type/codec");
      if (property.serialized !== undefined && typeof property.serialized !== "boolean")
        fail("manifest property serialization");
      if (typeof property.nullable !== "boolean") fail("manifest property nullability");
      if (property.nullable === true && property.codec === "instance_ref")
        fail("manifest instance reference uses typed nil");
      previousProperty = property.name;
      const proof = stringArray(property.proof, "manifest property proof");
      if (
        proof.length !== PROOF_STAGES.length ||
        PROOF_STAGES.some((stage, index) => proof[index] !== stage)
      )
        fail(`manifest closure for ${item.name}.${property.name}`);
      for (const numberKey of [
        "minimum",
        "minimumExclusive",
        "maximum",
        "maximumAbsoluteTranslation",
        "minimumUtf8Bytes",
        "maximumUtf8Bytes",
        "maximumEntries",
      ])
        if (
          property[numberKey] !== undefined &&
          (!finiteNumber(property[numberKey]) ||
            ([
              "maximumAbsoluteTranslation",
              "minimumUtf8Bytes",
              "maximumUtf8Bytes",
              "maximumEntries",
            ].includes(numberKey) &&
              Number(property[numberKey]) < 0) ||
            (["minimumUtf8Bytes", "maximumUtf8Bytes", "maximumEntries"].includes(numberKey) &&
              !Number.isSafeInteger(Number(property[numberKey]))))
        )
          fail("manifest property bound");
      if (
        property.minimumUtf8Bytes !== undefined &&
        !["string_utf8", "content"].includes(String(property.codec))
      )
        fail("manifest property UTF-8 minimum codec");
      if (
        property.minimumUtf8Bytes !== undefined &&
        property.maximumUtf8Bytes !== undefined &&
        Number(property.minimumUtf8Bytes) > Number(property.maximumUtf8Bytes)
      )
        fail("manifest property UTF-8 bounds");
      if (property.allowed !== undefined)
        sortedUnique(
          stringArray(property.allowed, "manifest property allowed"),
          "manifest property allowed",
        );
      if (
        property.codec === "enum_name" &&
        (!Array.isArray(property.allowed) || property.allowed.length === 0)
      )
        fail("manifest enum closure");
      if (property.codec === "instance_ref" && !nonEmpty(property.referenceClass))
        fail("manifest instance reference closure");
    }
  }
  const attributes = record(manifest.attributes, "manifest attributes");
  exactKeys(
    attributes,
    ["codecs", "maximumCount", "maximumNameUtf8Bytes", "maximumStringUtf8Bytes", "reservedPrefix"],
    "manifest attributes",
  );
  if (
    !stringArray(attributes.codecs, "attribute codecs").every((codec) =>
      ["boolean", "number_f32", "string_utf8"].includes(codec),
    ) ||
    !positiveInteger(attributes.maximumCount) ||
    !positiveInteger(attributes.maximumNameUtf8Bytes) ||
    !positiveInteger(attributes.maximumStringUtf8Bytes) ||
    !nonEmpty(attributes.reservedPrefix)
  )
    fail("manifest attributes");
  const source = record(manifest.source, "manifest source");
  exactKeys(source, ["maximumUtf8Bytes", "evidence"], "manifest source");
  if (!positiveInteger(source.maximumUtf8Bytes) || source.evidence !== "sha256")
    fail("manifest source");
  const runtime = array(manifest.runtimeCapabilities, "manifest runtimeCapabilities");
  let previousRuntime = "";
  for (const capabilityValue of runtime) {
    const capability = record(capabilityValue, "manifest runtime capability");
    if (
      !nonEmpty(capability.name) ||
      capability.name <= previousRuntime ||
      ![
        "vector3_f32",
        "position_series_f32",
        "manifest_property",
        "manifest_property_series",
        "instance_identity",
      ].includes(String(capability.result))
    )
      fail("manifest runtime capability");
    previousRuntime = capability.name;
  }
  const limits = record(manifest.limits, "manifest limits");
  const limitKeys = [
    "maximumDiagnostics",
    "maximumOperations",
    "maximumProjectionFacts",
    "maximumProjectionBytes",
    "maximumRuntimeTargets",
    "maximumRuntimeCalls",
    "maximumRuntimeMs",
    "maximumRuntimeResultBytes",
  ];
  exactKeys(limits, limitKeys, "manifest limits");
  for (const key of limitKeys) if (!positiveInteger(limits[key])) fail("manifest limits");
}

/** The backend's catalog-derived expectation for one reflected property. */
export interface StudioCapabilityAttestationExpected {
  readonly className: string;
  readonly propertyName: string;
  readonly owner: string;
  readonly inherited: boolean;
  readonly catalogType: StudioCatalogType;
  readonly reflection: StudioReflectionTypeExpectation;
  readonly serialized: boolean;
  readonly permits: readonly ("read" | "write")[];
}
/** A bounded, deterministic diagnostic; received values retain the raw type dimensions. */
export interface StudioCapabilityAttestationFinding {
  readonly key: string;
  readonly code: string;
  readonly expected?: StudioCapabilityAttestationExpected;
  readonly received?: StudioFactResult<StudioReflectionValue>;
}
export interface StudioCapabilityAttestationGrade {
  readonly status: "verified" | "rejected" | "incomplete";
  readonly totalFacts: number;
  readonly observedFacts: number;
  readonly unavailableFacts: number;
  readonly readErrorFacts: number;
  readonly mismatchedFacts: number;
  readonly missingFacts: number;
  readonly findingsTruncated: boolean;
  readonly findings: readonly StudioCapabilityAttestationFinding[];
  readonly detail: string;
}

const CAPABILITY_ATTESTATION_FINDING_LIMIT = 32;

/**
 * Grade a complete raw reflection artifact against the manifest generated
 * from the pinned API catalog. This is deliberately the only semantic type
 * comparison: Studio collects raw ReflectionService fields and never decides
 * whether aliases, enums, or class constraints match a capability.
 */
export function gradeStudioCapabilityAttestation(
  manifest: StudioCapabilityManifest,
  manifestHash: string,
  projection: StudioEvidenceProjection,
  envelope: StudioEvidenceEnvelope,
): StudioCapabilityAttestationGrade {
  assertStudioCapabilityManifest(manifest);
  assertStudioEvidenceProjection(projection, manifest);
  assertStudioEvidenceEnvelope(envelope, undefined, manifest);

  const expectedByKey = new Map<string, StudioCapabilityAttestationExpected>();
  for (const classDefinition of manifest.classes)
    for (const property of classDefinition.properties) {
      const key = studioEvidenceFactKey(
        "reflection",
        { kind: "project" },
        `${classDefinition.name}.${property.name}`,
      );
      expectedByKey.set(key, {
        className: classDefinition.name,
        propertyName: property.name,
        owner: property.declaringClass,
        inherited: property.declaringClass !== classDefinition.name,
        catalogType: property.catalogType,
        reflection: property.reflection,
        serialized: property.serialized ?? true,
        permits: ["read", "write"],
      });
    }

  const findings: StudioCapabilityAttestationFinding[] = [];
  const mismatchedKeys = new Set<string>();
  let allFindings = 0;
  const unavailableFacts = envelope.facts.filter(
    (fact) => fact.result.status === "unavailable",
  ).length;
  const readErrorFacts = envelope.facts.filter(
    (fact) => fact.result.status === "read_error",
  ).length;
  const observedFacts = envelope.facts.filter((fact) => fact.result.status === "observed").length;
  let missingFacts = 0;
  let incomplete = false;
  let rejected = false;
  const finding = (entry: StudioCapabilityAttestationFinding, kind: "incomplete" | "rejected") => {
    allFindings += 1;
    if (findings.length < CAPABILITY_ATTESTATION_FINDING_LIMIT) findings.push(entry);
    if (kind === "incomplete") incomplete = true;
    else {
      rejected = true;
      if (entry.key !== "attestation") mismatchedKeys.add(entry.key);
    }
  };
  const bindingFinding = (code: string) => finding({ key: "attestation", code }, "rejected");

  if (projection.purpose !== "capability_attestation")
    bindingFinding("projection_purpose_mismatch");
  if (projection.manifestHash !== manifestHash) bindingFinding("projection_manifest_hash_mismatch");
  if (envelope.manifestHash !== manifestHash) bindingFinding("envelope_manifest_hash_mismatch");
  if (envelope.projectionId !== projection.id) bindingFinding("envelope_projection_id_mismatch");
  if (envelope.projectionHash !== projection.contentHash)
    bindingFinding("envelope_projection_hash_mismatch");
  if (envelope.bindingHash !== projection.bindingHash)
    bindingFinding("envelope_binding_hash_mismatch");
  if (!sameProject(envelope.project, projection.project))
    bindingFinding("envelope_project_mismatch");
  if (envelope.completion !== "complete") {
    finding({ key: "attestation", code: "evidence_incomplete" }, "incomplete");
  }

  const requirements = new Map<string, StudioEvidenceRequirement>();
  for (const requirement of projection.requirements) {
    if (requirements.has(requirement.key)) {
      bindingFinding("duplicate_projection_requirement");
      continue;
    }
    requirements.set(requirement.key, requirement);
    const expected = expectedByKey.get(requirement.key);
    if (
      expected === undefined ||
      requirement.kind !== "reflection" ||
      requirement.target.kind !== "project" ||
      requirement.expectedStatus !== undefined ||
      requirement.expected !== undefined
    )
      bindingFinding("invalid_projection_requirement");
  }
  for (const [key, expected] of expectedByKey) {
    if (!requirements.has(key)) {
      missingFacts += 1;
      finding({ key, code: "missing_projection_requirement", expected }, "rejected");
    }
  }
  for (const key of requirements.keys())
    if (!expectedByKey.has(key)) bindingFinding("extra_projection_requirement");

  const facts = new Map<string, StudioEvidenceFact>();
  for (const fact of envelope.facts) {
    if (facts.has(fact.key)) {
      bindingFinding("duplicate_evidence_fact");
      continue;
    }
    facts.set(fact.key, fact);
  }
  for (const [key, expected] of expectedByKey) {
    const fact = facts.get(key);
    if (fact === undefined) {
      missingFacts += 1;
      finding({ key, code: "missing_reflection_fact", expected }, "incomplete");
      continue;
    }
    if (fact.kind !== "reflection" || fact.target.kind !== "project") {
      finding({ key, code: "reflection_fact_shape_mismatch", expected }, "rejected");
      continue;
    }
    if (fact.result.status === "unavailable") {
      finding(
        {
          key,
          code: "reflection_unavailable",
          expected,
          received: fact.result,
        },
        "incomplete",
      );
      continue;
    }
    if (fact.result.status === "read_error") {
      finding(
        { key, code: "reflection_read_error", expected, received: fact.result },
        "incomplete",
      );
      continue;
    }
    if (fact.result.status === "absent") {
      missingFacts += 1;
      finding(
        {
          key,
          code: "reflection_property_absent",
          expected,
          received: fact.result,
        },
        "incomplete",
      );
      continue;
    }
    const reflected = fact.result.value;
    if (
      reflected.className !== expected.className ||
      reflected.propertyName !== expected.propertyName
    ) {
      finding(
        {
          key,
          code: "reflection_identity_mismatch",
          expected,
          received: fact.result,
        },
        "rejected",
      );
      continue;
    }
    if (reflected.owner !== expected.owner)
      finding(
        {
          key,
          code: "reflection_owner_mismatch",
          expected,
          received: fact.result,
        },
        "rejected",
      );
    if (reflected.inherited !== expected.inherited)
      finding(
        {
          key,
          code: "reflection_inheritance_mismatch",
          expected,
          received: fact.result,
        },
        "rejected",
      );
    const typeFindings = reflectionTypeFindings(expected.reflection, reflected.type);
    for (const typeFinding of typeFindings)
      finding({ key, code: typeFinding.code, expected, received: fact.result }, typeFinding.kind);
    if (reflected.serialized !== expected.serialized)
      finding(
        {
          key,
          code: "reflection_serialization_mismatch",
          expected,
          received: fact.result,
        },
        "rejected",
      );
    for (const permit of expected.permits)
      if (!reflected.permits.includes(permit))
        finding(
          {
            key,
            code: `reflection_missing_${permit}_permit`,
            expected,
            received: fact.result,
          },
          "rejected",
        );
  }
  for (const [key, fact] of facts) {
    if (!expectedByKey.has(key)) {
      if (fact.result.status === "absent") missingFacts += 1;
      finding({ key, code: "unexpected_attestation_fact" }, "rejected");
    }
  }

  const status = rejected ? "rejected" : incomplete ? "incomplete" : "verified";
  const detail =
    status === "verified"
      ? "Capability attestation verified against the pinned catalog."
      : findings[0] === undefined
        ? "Capability attestation has no usable evidence."
        : `Capability attestation ${status}: ${findings[0].code}.`;
  return Object.freeze({
    status,
    totalFacts: envelope.facts.length,
    observedFacts,
    unavailableFacts,
    readErrorFacts,
    mismatchedFacts: mismatchedKeys.size,
    missingFacts,
    findingsTruncated: allFindings > findings.length,
    findings: Object.freeze(findings),
    detail,
  });
}

function reflectionTypeFindings(
  expected: StudioReflectionTypeExpectation,
  received: StudioReflectionTypeValue,
): readonly {
  readonly code: string;
  readonly kind: "incomplete" | "rejected";
}[] {
  const findings: { code: string; kind: "incomplete" | "rejected" }[] = [];
  const compareRequired = (
    dimension: "engineType" | "scriptType" | "enumType" | "instanceType",
    expectedValue: string,
  ): void => {
    const receivedValue = received[dimension];
    if (receivedValue === undefined)
      findings.push({
        code: `reflection_${reflectionDimensionName(dimension)}_missing`,
        kind: "incomplete",
      });
    else if (receivedValue !== expectedValue)
      findings.push({
        code: `reflection_${reflectionDimensionName(dimension)}_mismatch`,
        kind: "rejected",
      });
  };
  compareRequired("engineType", expected.engineType);
  compareRequired("scriptType", expected.scriptType);
  if (expected.enumType === undefined) {
    if (received.enumType !== undefined)
      findings.push({
        code: "reflection_unexpected_enum_type",
        kind: "rejected",
      });
  } else compareRequired("enumType", expected.enumType);
  if (expected.instanceType === undefined) {
    if (received.instanceType !== undefined)
      findings.push({
        code: "reflection_unexpected_instance_type",
        kind: "rejected",
      });
  } else compareRequired("instanceType", expected.instanceType);
  return findings;
}

function reflectionDimensionName(
  dimension: "engineType" | "scriptType" | "enumType" | "instanceType",
): string {
  return dimension.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

export function canonicalStudioValue(
  value: StudioValue,
  property?: StudioManifestProperty,
): StudioValue {
  assertStudioValue(value);
  let canonical: StudioValue;
  switch (value.kind) {
    case "nil":
      canonical = { kind: value.kind, expectedCodec: value.expectedCodec };
      break;
    case "boolean":
      canonical = { kind: value.kind, value: value.value };
      break;
    case "number_f32":
      canonical = { kind: value.kind, value: canonicalF32(value.value) };
      break;
    case "number_f64":
      canonical = { kind: value.kind, value: canonicalF64(value.value) };
      break;
    case "int32":
      canonical = { kind: value.kind, value: value.value };
      break;
    case "int64_decimal":
      canonical = { kind: value.kind, value: value.value };
      break;
    case "string_utf8":
      canonical = { kind: value.kind, value: value.value };
      break;
    case "content":
      canonical = { kind: value.kind, value: value.value };
      break;
    case "color3_rgb8":
      canonical = { kind: value.kind, r: value.r, g: value.g, b: value.b };
      break;
    case "vector2_f32":
      canonical = {
        kind: value.kind,
        x: canonicalF32(value.x),
        y: canonicalF32(value.y),
      };
      break;
    case "vector3_f32":
      canonical = {
        kind: value.kind,
        x: canonicalF32(value.x),
        y: canonicalF32(value.y),
        z: canonicalF32(value.z),
      };
      break;
    case "cframe_f32x12":
      canonical = {
        kind: value.kind,
        components: value.components.map(canonicalF32),
      };
      break;
    case "udim":
      canonical = {
        kind: value.kind,
        scale: canonicalF32(value.scale),
        offset: value.offset,
      };
      break;
    case "udim2":
      canonical = {
        kind: value.kind,
        x: canonicalUdim(value.x),
        y: canonicalUdim(value.y),
      };
      break;
    case "rect":
      canonical = {
        kind: value.kind,
        minX: canonicalF32(value.minX),
        minY: canonicalF32(value.minY),
        maxX: canonicalF32(value.maxX),
        maxY: canonicalF32(value.maxY),
      };
      break;
    case "number_range":
      canonical = {
        kind: value.kind,
        min: canonicalF32(value.min),
        max: canonicalF32(value.max),
      };
      break;
    case "number_sequence":
      canonical = {
        kind: value.kind,
        keypoints: value.keypoints.map((keypoint) => ({
          time: canonicalF32(keypoint.time),
          value: canonicalF32(keypoint.value),
          envelope: canonicalF32(keypoint.envelope),
        })),
      };
      break;
    case "color_sequence":
      canonical = {
        kind: value.kind,
        keypoints: value.keypoints.map((keypoint) => ({
          time: canonicalF32(keypoint.time),
          color: {
            r: keypoint.color.r,
            g: keypoint.color.g,
            b: keypoint.color.b,
          },
        })),
      };
      break;
    case "brick_color":
      canonical = { kind: value.kind, name: value.name };
      break;
    case "font":
      canonical = {
        kind: value.kind,
        family: value.family,
        weight: value.weight,
        style: value.style,
      };
      break;
    case "physical_properties":
      canonical = {
        kind: value.kind,
        density: canonicalF32(value.density),
        friction: canonicalF32(value.friction),
        elasticity: canonicalF32(value.elasticity),
        frictionWeight: canonicalF32(value.frictionWeight),
        elasticityWeight: canonicalF32(value.elasticityWeight),
      };
      break;
    case "axes":
      canonical = { kind: value.kind, x: value.x, y: value.y, z: value.z };
      break;
    case "faces":
      canonical = {
        kind: value.kind,
        top: value.top,
        bottom: value.bottom,
        left: value.left,
        right: value.right,
        front: value.front,
        back: value.back,
      };
      break;
    case "ray":
      canonical = {
        kind: value.kind,
        origin: canonicalVector3(value.origin),
        direction: canonicalVector3(value.direction),
      };
      break;
    case "instance_ref":
      canonical =
        value.state === "nil"
          ? {
              kind: value.kind,
              state: "nil",
              expectedClass: value.expectedClass,
            }
          : {
              kind: value.kind,
              state: "reference",
              identity: value.identity,
              path: value.path,
              className: value.className,
              expectedClass: value.expectedClass,
            };
      break;
    case "enum_name":
      canonical = { kind: value.kind, value: value.value };
      break;
  }
  if (property !== undefined) assertStudioValueForProperty(canonical, property);
  return canonical;
}

export function assertStudioValue(value: unknown): asserts value is StudioValue {
  const item = record(value, "StudioValue");
  if (item.kind !== "nil" && !isCodec(item.kind)) fail("StudioValue codec");
  switch (item.kind) {
    case "nil":
      exactKeys(item, ["kind", "expectedCodec"], "nil value");
      if (!isGenericNullableCodec(item.expectedCodec)) fail("nil value codec");
      return;
    case "boolean":
      exactKeys(item, ["kind", "value"], "boolean value");
      if (typeof item.value !== "boolean") fail("boolean value");
      return;
    case "number_f32":
      exactKeys(item, ["kind", "value"], "number value");
      if (!finiteNumber(item.value)) fail("number value");
      return;
    case "number_f64":
      exactKeys(item, ["kind", "value"], "number value");
      if (!finiteNumber(item.value)) fail("number value");
      return;
    case "int32":
      exactKeys(item, ["kind", "value"], "int32 value");
      if (
        typeof item.value !== "number" ||
        !Number.isInteger(item.value) ||
        item.value < -2_147_483_648 ||
        item.value > 2_147_483_647
      )
        fail("int32 value");
      return;
    case "int64_decimal":
      exactKeys(item, ["kind", "value"], "int64 value");
      if (!isInt64Decimal(item.value)) fail("int64 value");
      return;
    case "string_utf8":
      exactKeys(item, ["kind", "value"], "string value");
      if (!validUtf8(item.value)) fail("string value");
      return;
    case "content":
      exactKeys(item, ["kind", "value"], "content value");
      if (!validUtf8(item.value)) fail("content value");
      return;
    case "color3_rgb8":
      exactKeys(item, ["kind", "r", "g", "b"], "color value");
      for (const channel of [item.r, item.g, item.b]) if (!byte(channel)) fail("color value");
      return;
    case "vector2_f32":
      exactKeys(item, ["kind", "x", "y"], "vector value");
      for (const component of [item.x, item.y]) if (!finiteNumber(component)) fail("vector value");
      return;
    case "vector3_f32":
      exactKeys(item, ["kind", "x", "y", "z"], "vector value");
      for (const component of [item.x, item.y, item.z])
        if (!finiteNumber(component)) fail("vector value");
      return;
    case "cframe_f32x12":
      exactKeys(item, ["kind", "components"], "cframe value");
      const components = numberArray(item.components, "cframe components");
      if (components.length !== 12 || !components.every(finiteNumber)) fail("cframe value");
      return;
    case "udim":
      exactKeys(item, ["kind", "scale", "offset"], "udim value");
      assertUdim({ scale: item.scale, offset: item.offset }, "udim value");
      return;
    case "udim2":
      exactKeys(item, ["kind", "x", "y"], "udim2 value");
      assertUdim(item.x, "udim2 x");
      assertUdim(item.y, "udim2 y");
      return;
    case "rect":
      exactKeys(item, ["kind", "minX", "minY", "maxX", "maxY"], "rect value");
      if (
        ![item.minX, item.minY, item.maxX, item.maxY].every(finiteNumber) ||
        Number(item.minX) > Number(item.maxX) ||
        Number(item.minY) > Number(item.maxY)
      )
        fail("rect value");
      return;
    case "number_range":
      exactKeys(item, ["kind", "min", "max"], "number range value");
      if (!finiteNumber(item.min) || !finiteNumber(item.max) || Number(item.min) > Number(item.max))
        fail("number range value");
      return;
    case "number_sequence":
      exactKeys(item, ["kind", "keypoints"], "number sequence value");
      assertNumberSequence(item.keypoints);
      return;
    case "color_sequence":
      exactKeys(item, ["kind", "keypoints"], "color sequence value");
      assertColorSequence(item.keypoints);
      return;
    case "brick_color":
      exactKeys(item, ["kind", "name"], "brick color value");
      if (!nonEmpty(item.name) || !validUtf8(item.name)) fail("brick color value");
      return;
    case "font":
      exactKeys(item, ["kind", "family", "weight", "style"], "font value");
      if (
        ![item.family, item.weight, item.style].every(
          (entry) => nonEmpty(entry) && validUtf8(entry),
        )
      )
        fail("font value");
      return;
    case "physical_properties":
      exactKeys(
        item,
        ["kind", "density", "friction", "elasticity", "frictionWeight", "elasticityWeight"],
        "physical properties value",
      );
      if (
        ![
          item.density,
          item.friction,
          item.elasticity,
          item.frictionWeight,
          item.elasticityWeight,
        ].every(finiteNumber) ||
        Number(item.density) <= 0 ||
        [item.friction, item.elasticity, item.frictionWeight, item.elasticityWeight].some(
          (entry) => Number(entry) < 0 || Number(entry) > 1,
        )
      )
        fail("physical properties value");
      return;
    case "axes":
      exactKeys(item, ["kind", "x", "y", "z"], "axes value");
      if (![item.x, item.y, item.z].every((entry) => typeof entry === "boolean"))
        fail("axes value");
      return;
    case "faces":
      exactKeys(item, ["kind", "top", "bottom", "left", "right", "front", "back"], "faces value");
      if (
        ![item.top, item.bottom, item.left, item.right, item.front, item.back].every(
          (entry) => typeof entry === "boolean",
        )
      )
        fail("faces value");
      return;
    case "ray":
      exactKeys(item, ["kind", "origin", "direction"], "ray value");
      assertVector3(item.origin, "ray origin");
      assertVector3(item.direction, "ray direction");
      return;
    case "instance_ref":
      if (item.state === "nil") {
        exactKeys(item, ["kind", "state", "expectedClass"], "nil instance reference value");
        if (!nonEmpty(item.expectedClass)) fail("nil instance reference value");
        return;
      }
      exactKeys(
        item,
        ["kind", "state", "identity", "path", "className", "expectedClass"],
        "instance reference value",
      );
      if (
        item.state !== "reference" ||
        ![item.path, item.className, item.expectedClass].every(nonEmpty) ||
        !safeStudioPath(item.path) ||
        !catalogClassAssignableTo(String(item.className), String(item.expectedClass))
      )
        fail("instance reference value");
      assertStudioObjectIdentity(item.identity);
      return;
    case "enum_name":
      exactKeys(item, ["kind", "value"], "enum value");
      if (!nonEmpty(item.value) || !validUtf8(item.value)) fail("enum value");
      return;
  }
}

export function assertStudioValueForProperty(
  value: StudioValue,
  property: StudioManifestProperty,
): void {
  // This is a public boundary as well as an internal refinement. Validate the
  // closed value shape first so a caller cannot smuggle a malformed generic
  // nil through the property-specific branch below.
  assertStudioValue(value);
  if (value.kind === "nil") {
    if (property.nullable !== true || value.expectedCodec !== property.codec)
      fail(`StudioValue nil is not declared for ${property.name}`);
    return;
  }
  if (value.kind !== property.codec) fail(`StudioValue codec does not match ${property.name}`);
  if (
    (value.kind === "string_utf8" || value.kind === "content") &&
    (property.maximumUtf8Bytes === undefined ||
      utf8Length(value.value) > property.maximumUtf8Bytes ||
      (property.minimumUtf8Bytes !== undefined &&
        utf8Length(value.value) < property.minimumUtf8Bytes))
  )
    fail(`StudioValue string bound for ${property.name}`);
  // Enums are closed by their generated Enum definition. BrickColor is an
  // engine datatype, not an Enum: a curated property may optionally narrow it
  // to an allowlist, but an observed engine BrickColor remains valid when no
  // such policy exists. This exactly matches the generated Luau codec.
  if (
    value.kind === "enum_name" &&
    (property.allowed === undefined || !property.allowed.includes(value.value))
  )
    fail(`StudioValue allowlist for ${property.name}`);
  if (
    value.kind === "brick_color" &&
    property.allowed !== undefined &&
    !property.allowed.includes(value.name)
  )
    fail(`StudioValue allowlist for ${property.name}`);
  if (
    (value.kind === "number_sequence" || value.kind === "color_sequence") &&
    (property.maximumEntries === undefined || value.keypoints.length > property.maximumEntries)
  )
    fail(`StudioValue sequence bound for ${property.name}`);
  if (
    value.kind === "instance_ref" &&
    (property.referenceClass === undefined ||
      value.expectedClass !== property.referenceClass ||
      (value.state === "reference" &&
        !catalogClassAssignableTo(value.className, value.expectedClass)))
  )
    fail(`StudioValue reference class for ${property.name}`);
  const numbers = numericComponents(value);
  for (const numeric of numbers) {
    if (property.minimum !== undefined && numeric < property.minimum)
      fail(`StudioValue minimum for ${property.name}`);
    if (property.minimumExclusive !== undefined && numeric <= property.minimumExclusive)
      fail(`StudioValue exclusive minimum for ${property.name}`);
    if (property.maximum !== undefined && numeric > property.maximum)
      fail(`StudioValue maximum for ${property.name}`);
  }
  const translationBound = property.maximumAbsoluteTranslation;
  if (
    value.kind === "cframe_f32x12" &&
    translationBound !== undefined &&
    value.components.slice(0, 3).some((entry) => Math.abs(entry) > translationBound)
  )
    fail(`StudioValue translation bound for ${property.name}`);
}

/** Cross-language material: tags and UTF-8 byte lengths make concatenation unambiguous. */
export function canonicalStudioValueMaterial(value: StudioValue): string {
  const item = canonicalStudioValue(value);
  switch (item.kind) {
    case "nil":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("expected-codec", item.expectedCodec),
      );
    case "boolean":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("value", item.value ? "1" : "0"),
      );
    case "number_f32":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("bits", f32Bits(item.value)),
      );
    case "number_f64":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("bits", f64Bits(item.value)),
      );
    case "int32":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("value", String(item.value)),
      );
    case "int64_decimal":
      return tagged("studio-value", tagged("codec", item.kind), tagged("decimal", item.value));
    case "string_utf8":
      return tagged("studio-value", tagged("codec", item.kind), tagged("utf8", item.value));
    case "content":
      return tagged("studio-value", tagged("codec", item.kind), tagged("utf8", item.value));
    case "color3_rgb8":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("r", String(item.r)),
        tagged("g", String(item.g)),
        tagged("b", String(item.b)),
      );
    case "vector2_f32":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("x", f32Bits(item.x)),
        tagged("y", f32Bits(item.y)),
      );
    case "vector3_f32":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("x", f32Bits(item.x)),
        tagged("y", f32Bits(item.y)),
        tagged("z", f32Bits(item.z)),
      );
    case "cframe_f32x12":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("components", taggedSequence(item.components.map(f32Bits))),
      );
    case "udim":
      return tagged("studio-value", tagged("codec", item.kind), udimMaterial(item));
    case "udim2":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("x", udimMaterial(item.x)),
        tagged("y", udimMaterial(item.y)),
      );
    case "rect":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("min-x", f32Bits(item.minX)),
        tagged("min-y", f32Bits(item.minY)),
        tagged("max-x", f32Bits(item.maxX)),
        tagged("max-y", f32Bits(item.maxY)),
      );
    case "number_range":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("min", f32Bits(item.min)),
        tagged("max", f32Bits(item.max)),
      );
    case "number_sequence":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged(
          "keypoints",
          taggedSequence(
            item.keypoints.map((keypoint) =>
              tagged(
                "keypoint",
                tagged("time", f32Bits(keypoint.time)),
                tagged("value", f32Bits(keypoint.value)),
                tagged("envelope", f32Bits(keypoint.envelope)),
              ),
            ),
          ),
        ),
      );
    case "color_sequence":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged(
          "keypoints",
          taggedSequence(
            item.keypoints.map((keypoint) =>
              tagged(
                "keypoint",
                tagged("time", f32Bits(keypoint.time)),
                tagged("color", colorMaterial(keypoint.color)),
              ),
            ),
          ),
        ),
      );
    case "brick_color":
      return tagged("studio-value", tagged("codec", item.kind), tagged("name", item.name));
    case "font":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("family", item.family),
        tagged("weight", item.weight),
        tagged("style", item.style),
      );
    case "physical_properties":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("density", f32Bits(item.density)),
        tagged("friction", f32Bits(item.friction)),
        tagged("elasticity", f32Bits(item.elasticity)),
        tagged("friction-weight", f32Bits(item.frictionWeight)),
        tagged("elasticity-weight", f32Bits(item.elasticityWeight)),
      );
    case "axes":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("x", item.x ? "1" : "0"),
        tagged("y", item.y ? "1" : "0"),
        tagged("z", item.z ? "1" : "0"),
      );
    case "faces":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("top", item.top ? "1" : "0"),
        tagged("bottom", item.bottom ? "1" : "0"),
        tagged("left", item.left ? "1" : "0"),
        tagged("right", item.right ? "1" : "0"),
        tagged("front", item.front ? "1" : "0"),
        tagged("back", item.back ? "1" : "0"),
      );
    case "ray":
      return tagged(
        "studio-value",
        tagged("codec", item.kind),
        tagged("origin", vector3Material(item.origin)),
        tagged("direction", vector3Material(item.direction)),
      );
    case "instance_ref":
      return item.state === "nil"
        ? tagged(
            "studio-value",
            tagged("codec", item.kind),
            tagged("state", "nil"),
            tagged("expected-class", item.expectedClass),
          )
        : tagged(
            "studio-value",
            tagged("codec", item.kind),
            tagged("state", "reference"),
            tagged("identity", studioObjectIdentityKey(item.identity)),
            tagged("path", item.path),
            tagged("class", item.className),
            tagged("expected-class", item.expectedClass),
          );
    case "enum_name":
      return tagged("studio-value", tagged("codec", item.kind), tagged("name", item.value));
  }
}

export function studioValuesEqual(left: StudioValue, right: StudioValue): boolean {
  return canonicalStudioValueMaterial(left) === canonicalStudioValueMaterial(right);
}
export function studioEvidenceFactKey(
  kind: StudioFactKind,
  target: StudioEvidenceTarget,
  name?: string,
): string {
  const targetMaterial =
    target.kind === "project"
      ? "project"
      : `${studioObjectIdentityKey(target.identity)}@${target.path}:${target.className}`;
  return `${kind}:${targetMaterial}${name === undefined ? "" : `:${name}`}`;
}

export function studioEvidenceBindingHash(binding: StudioEvidenceBinding): string {
  const entries = Object.entries(binding)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => compareText(left, right));
  for (const [key, value] of entries)
    if (!nonEmpty(key) || !nonEmpty(value)) fail("evidence binding");
  return contentHash(
    tagged(
      "binding",
      taggedSequence(
        entries.map(([key, value]) => tagged("entry", tagged("key", key), tagged("value", value))),
      ),
    ),
  );
}

export function studioEvidenceProjectionMaterial(
  projection:
    Omit<StudioEvidenceProjection, "contentHash" | "bindingHash"> | StudioEvidenceProjection,
): string {
  return tagged(
    "StudioEvidenceProjection",
    tagged("id", projection.id),
    tagged("manifest", projection.manifestHash),
    tagged("purpose", projection.purpose),
    projectMaterial(projection.project),
    tagged("binding", studioEvidenceBindingHash(projection.binding)),
    tagged("requirements", taggedSequence(projection.requirements.map(requirementMaterial))),
    scopeMaterial(projection.scope),
    boundsMaterial(projection.bounds),
  );
}
export function studioEvidenceProjectionHash(
  projection:
    Omit<StudioEvidenceProjection, "contentHash" | "bindingHash"> | StudioEvidenceProjection,
): string {
  return contentHash(studioEvidenceProjectionMaterial(projection));
}

export function createStudioEvidenceProjection(
  input: Omit<StudioEvidenceProjection, "kind" | "contentHash" | "bindingHash">,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): StudioEvidenceProjection {
  const requirements = [...input.requirements].sort((left, right) =>
    compareText(left.key, right.key),
  );
  const bindingHash = studioEvidenceBindingHash(input.binding);
  const candidate: StudioEvidenceProjection = {
    kind: "StudioEvidenceProjection",
    ...input,
    requirements,
    bindingHash,
    contentHash: "",
  };
  const contentHash = studioEvidenceProjectionHash(candidate);
  const projection = { ...candidate, contentHash };
  assertStudioEvidenceProjection(projection, manifest);
  return projection;
}

export function assertStudioEvidenceProjection(
  value: unknown,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): asserts value is StudioEvidenceProjection {
  const projection = record(value, "StudioEvidenceProjection");
  exactKeys(
    projection,
    [
      "kind",
      "id",
      "manifestHash",
      "purpose",
      "project",
      "binding",
      "bindingHash",
      "requirements",
      "scope",
      "bounds",
      "contentHash",
    ],
    "StudioEvidenceProjection",
  );
  if (
    projection.kind !== "StudioEvidenceProjection" ||
    !nonEmpty(projection.id) ||
    !hash(projection.manifestHash) ||
    !PURPOSES.includes(projection.purpose as StudioEvidencePurpose) ||
    !hash(projection.bindingHash) ||
    !hash(projection.contentHash)
  )
    fail("StudioEvidenceProjection");
  assertProject(projection.project);
  assertBinding(projection.binding);
  if (
    studioEvidenceBindingHash(projection.binding as StudioEvidenceBinding) !==
    projection.bindingHash
  )
    fail("projection binding hash");
  const requirements = array(projection.requirements, "projection requirements");
  if (requirements.length > manifest.limits.maximumProjectionFacts) fail("projection fact bound");
  let previous = "";
  const keys = new Set<string>();
  for (const requirement of requirements) {
    assertRequirement(requirement);
    const typed = requirement as StudioEvidenceRequirement;
    if ((previous !== "" && compareText(typed.key, previous) <= 0) || keys.has(typed.key))
      fail("projection requirement order");
    previous = typed.key;
    keys.add(typed.key);
  }
  assertScope(projection.scope, manifest);
  assertBounds(projection.bounds, manifest);
  if (
    studioEvidenceProjectionHash(projection as unknown as StudioEvidenceProjection) !==
    projection.contentHash
  )
    fail("projection content hash");
}

export function studioEvidenceFactMaterial(
  fact: StudioEvidenceFact,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): string {
  assertStudioEvidenceFact(fact, manifest);
  const named =
    fact.kind === "property"
      ? tagged("property", fact.propertyName)
      : fact.kind === "attribute"
        ? tagged("attribute", fact.attributeName)
        : fact.kind === "runtime_property" || fact.kind === "runtime_property_series"
          ? tagged(
              "runtime",
              tagged("property", fact.propertyName),
              tagged("call", fact.callId),
              tagged("target", fact.runtimeTargetId),
              tagged("capability", fact.capability),
            )
          : fact.kind === "runtime_resolution" || fact.kind === "position_series"
            ? tagged(
                "runtime",
                tagged("call", fact.callId),
                tagged("target", fact.runtimeTargetId),
                tagged("capability", fact.capability),
              )
            : fact.kind === "position" && fact.callId !== undefined
              ? tagged(
                  "runtime",
                  tagged("call", fact.callId),
                  tagged("target", fact.runtimeTargetId ?? ""),
                  tagged("capability", fact.capability ?? ""),
                )
              : "";
  return tagged(
    "StudioEvidenceFact",
    tagged("kind", fact.kind),
    tagged("key", fact.key),
    targetMaterial(fact.target),
    named,
    factResultMaterial(fact.result),
  );
}
export function studioEvidenceEnvelopeMaterial(
  envelope: Omit<StudioEvidenceEnvelope, "contentHash"> | StudioEvidenceEnvelope,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): string {
  return tagged(
    "StudioEvidenceEnvelope",
    tagged("manifest", envelope.manifestHash),
    tagged("projection", envelope.projectionHash),
    tagged("projection-id", envelope.projectionId),
    tagged("binding", envelope.bindingHash),
    projectMaterial(envelope.project),
    tagged("authoritative", envelope.authoritative ? "1" : "0"),
    tagged("started", envelope.startedAt),
    tagged("ended", envelope.endedAt),
    tagged("completion", envelope.completion),
    tagged(
      "facts",
      taggedSequence(envelope.facts.map((fact) => studioEvidenceFactMaterial(fact, manifest))),
    ),
    tagged("diagnostics", taggedSequence((envelope.diagnostics ?? []).map(diagnosticMaterial))),
  );
}
export function studioEvidenceEnvelopeHash(
  envelope: Omit<StudioEvidenceEnvelope, "contentHash"> | StudioEvidenceEnvelope,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): string {
  return contentHash(studioEvidenceEnvelopeMaterial(envelope, manifest));
}

export function createStudioEvidenceEnvelope(
  input: Omit<StudioEvidenceEnvelope, "kind" | "contentHash">,
  projection?: StudioEvidenceProjection,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): StudioEvidenceEnvelope {
  const facts = [...input.facts].sort(compareFacts);
  const diagnostics =
    input.diagnostics === undefined
      ? undefined
      : [...input.diagnostics].sort((left, right) =>
          compareText(diagnosticMaterial(left), diagnosticMaterial(right)),
        );
  const candidate: StudioEvidenceEnvelope =
    diagnostics === undefined
      ? { kind: "StudioEvidenceEnvelope", ...input, facts, contentHash: "" }
      : {
          kind: "StudioEvidenceEnvelope",
          ...input,
          facts,
          diagnostics,
          contentHash: "",
        };
  const envelope = {
    ...candidate,
    contentHash: studioEvidenceEnvelopeHash(candidate, manifest),
  };
  assertStudioEvidenceEnvelope(envelope, projection, manifest);
  return envelope;
}

export function assertStudioEvidenceFact(
  value: unknown,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): asserts value is StudioEvidenceFact {
  const fact = record(value, "StudioEvidenceFact");
  if (!FACT_KINDS.includes(fact.kind as StudioFactKind) || !nonEmpty(fact.key))
    fail("StudioEvidenceFact");
  assertTarget(fact.target);
  assertFactResult(fact.result, String(fact.kind));
  const expectedKeys: Record<StudioFactKind, readonly string[]> = {
    structure: ["kind", "key", "target", "result"],
    property: ["kind", "key", "target", "propertyName", "result"],
    attribute_inventory: ["kind", "key", "target", "result"],
    attribute: ["kind", "key", "target", "attributeName", "result"],
    source_hash: ["kind", "key", "target", "result"],
    tags: ["kind", "key", "target", "result"],
    remote: ["kind", "key", "target", "result"],
    runtime_resolution: [
      "kind",
      "key",
      "target",
      "callId",
      "runtimeTargetId",
      "capability",
      "result",
    ],
    position: ["kind", "key", "target", "callId", "runtimeTargetId", "capability", "result"],
    position_series: ["kind", "key", "target", "callId", "runtimeTargetId", "capability", "result"],
    runtime_property: [
      "kind",
      "key",
      "target",
      "propertyName",
      "callId",
      "runtimeTargetId",
      "capability",
      "result",
    ],
    runtime_property_series: [
      "kind",
      "key",
      "target",
      "propertyName",
      "callId",
      "runtimeTargetId",
      "capability",
      "result",
    ],
    diagnostic: ["kind", "key", "target", "result"],
    reflection: ["kind", "key", "target", "result"],
  };
  const optional = fact.kind === "position" ? ["callId", "runtimeTargetId", "capability"] : [];
  exactKeys(
    fact,
    expectedKeys[fact.kind as StudioFactKind].filter(
      (key) => !optional.includes(key) || fact[key] !== undefined,
    ),
    "StudioEvidenceFact",
  );
  if (
    (fact.kind === "property" && !nonEmpty(fact.propertyName)) ||
    (fact.kind === "attribute" && !nonEmpty(fact.attributeName))
  )
    fail("named StudioEvidenceFact");
  if (
    fact.kind === "runtime_resolution" &&
    (fact.capability !== "instance.resolve" ||
      !nonEmpty(fact.callId) ||
      !nonEmpty(fact.runtimeTargetId))
  )
    fail("runtime resolution fact");
  if (
    fact.kind === "position_series" &&
    (fact.capability !== "base_part.position_series" ||
      !nonEmpty(fact.callId) ||
      !nonEmpty(fact.runtimeTargetId))
  )
    fail("position series fact");
  if (
    fact.kind === "runtime_property" &&
    (fact.capability !== "instance.property" ||
      !nonEmpty(fact.propertyName) ||
      !nonEmpty(fact.callId) ||
      !nonEmpty(fact.runtimeTargetId))
  )
    fail("runtime property fact");
  if (
    fact.kind === "runtime_property_series" &&
    (fact.capability !== "instance.property_series" ||
      !nonEmpty(fact.propertyName) ||
      !nonEmpty(fact.callId) ||
      !nonEmpty(fact.runtimeTargetId))
  )
    fail("runtime property series fact");
  if (
    fact.kind === "position" &&
    ((fact.callId !== undefined &&
      (!nonEmpty(fact.callId) ||
        !nonEmpty(fact.runtimeTargetId) ||
        fact.capability !== "base_part.position")) ||
      (fact.callId === undefined &&
        (fact.runtimeTargetId !== undefined || fact.capability !== undefined)))
  )
    fail("position fact");
  const typedFact = fact as unknown as StudioEvidenceFact;
  if (typedFact.result.status === "observed") assertFactObservedValue(typedFact, manifest);
}

export function assertStudioEvidenceEnvelope(
  value: unknown,
  projection?: StudioEvidenceProjection,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): asserts value is StudioEvidenceEnvelope {
  const envelope = record(value, "StudioEvidenceEnvelope");
  exactKeys(
    envelope,
    [
      "kind",
      "manifestHash",
      "projectionId",
      "projectionHash",
      "bindingHash",
      "project",
      "authoritative",
      "startedAt",
      "endedAt",
      "completion",
      "facts",
      "contentHash",
      ...(envelope.diagnostics === undefined ? [] : ["diagnostics"]),
    ],
    "StudioEvidenceEnvelope",
  );
  if (
    envelope.kind !== "StudioEvidenceEnvelope" ||
    !hash(envelope.manifestHash) ||
    !nonEmpty(envelope.projectionId) ||
    !hash(envelope.projectionHash) ||
    !hash(envelope.bindingHash) ||
    envelope.authoritative !== true ||
    !["complete", "incomplete"].includes(String(envelope.completion)) ||
    !hash(envelope.contentHash)
  )
    fail("StudioEvidenceEnvelope");
  assertProject(envelope.project);
  assertInterval(envelope.startedAt, envelope.endedAt);
  const facts = array(envelope.facts, "evidence facts");
  let previous: StudioEvidenceFact | undefined;
  const keys = new Set<string>();
  for (const fact of facts) {
    assertStudioEvidenceFact(fact, manifest);
    const typed = fact as StudioEvidenceFact;
    if (
      keys.has(typed.key) ||
      (previous !== undefined &&
        compareText(
          studioEvidenceFactMaterial(previous, manifest),
          studioEvidenceFactMaterial(typed, manifest),
        ) >= 0)
    )
      fail("evidence fact ordering");
    keys.add(typed.key);
    previous = typed;
  }
  if (
    facts.length > manifest.limits.maximumProjectionFacts ||
    utf8Length(
      studioEvidenceEnvelopeMaterial(envelope as unknown as StudioEvidenceEnvelope, manifest),
    ) > manifest.limits.maximumProjectionBytes
  )
    fail("evidence bounds");
  if (envelope.diagnostics !== undefined) {
    const diagnostics = array(envelope.diagnostics, "evidence diagnostics");
    if (diagnostics.length > manifest.limits.maximumDiagnostics) fail("evidence diagnostics bound");
    for (const diagnostic of diagnostics) assertDiagnostic(diagnostic);
  }
  if (
    studioEvidenceEnvelopeHash(envelope as unknown as StudioEvidenceEnvelope, manifest) !==
    envelope.contentHash
  )
    fail("evidence content hash");
  if (projection !== undefined)
    assertEvidenceAgainstProjection(
      envelope as unknown as StudioEvidenceEnvelope,
      projection,
      manifest,
    );
}

export function assertEvidenceAgainstProjection(
  envelope: StudioEvidenceEnvelope,
  projection: StudioEvidenceProjection,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): void {
  assertStudioEvidenceEnvelope(envelope, undefined, manifest);
  assertStudioEvidenceProjection(projection, manifest);
  if (
    envelope.manifestHash !== projection.manifestHash ||
    envelope.projectionId !== projection.id ||
    envelope.projectionHash !== projection.contentHash ||
    envelope.bindingHash !== projection.bindingHash ||
    !sameProject(envelope.project, projection.project)
  )
    fail("evidence projection binding");
  if (
    envelope.facts.length > projection.bounds.maximumFacts ||
    utf8Length(studioEvidenceEnvelopeMaterial(envelope, manifest)) > projection.bounds.maximumBytes
  )
    fail("evidence projection bounds");
  const facts = new Map(envelope.facts.map((fact) => [fact.key, fact]));
  for (const requirement of projection.requirements) {
    const fact = facts.get(requirement.key);
    if (fact === undefined || !factMatchesRequirement(fact, requirement))
      fail("missing required evidence fact");
  }
  if (facts.size !== projection.requirements.length) fail("extra evidence fact");
  // Completeness means authoritative coverage, never agreement with the
  // projection. Both observed and absent facts are replayable evidence;
  // pure graders decide whether either one satisfies the expectation.
  if (
    envelope.completion === "complete" &&
    envelope.facts.some(
      (fact) => fact.result.status === "unavailable" || fact.result.status === "read_error",
    )
  )
    fail("complete evidence includes unavailable fact");
  if (envelope.completion === "complete" && envelope.facts.length !== facts.size)
    fail("complete evidence duplicates");
}

export interface MutationEvidenceOperation {
  readonly id: string;
  readonly kind: StudioOperationKind;
  /** Exact post-mutation identity and structure used by direct readback. */
  readonly target: StudioEvidenceTarget;
  /**
   * Exact pre-mutation target for every move and for any transaction that
   * enrolls an ephemeral Studio object into Forge's durable identity
   * namespace. This is evidence, not an alias: replay must prove the exact
   * before/post object transition (or approved deletion).
   */
  readonly beforeTarget?: StudioEvidenceTarget;
  readonly properties?: Readonly<Record<string, StudioValue>>;
  readonly attributes?: Readonly<Record<string, StudioPrimitiveValue>>;
  readonly removedAttributes?: readonly string[];
  readonly sourceHash?: string;
  /** Optional explicit postcondition when a move/create carries a parent path. */
  readonly structure?: StudioStructureValue;
  /** Delete operations compile an absent structure postcondition by default. */
  readonly structureStatus?: "observed" | "absent";
  /**
   * A parent delete also removes descendants that are present in the complete
   * project index. Those descendant rows are proof obligations, not extra
   * authoring capabilities: Forge may prove their structural absence without
   * claiming that their class has a writable manifest surface.
   */
  readonly consequentialStructureOnly?: true;
}
export interface MutationEvidenceProjectionInput {
  readonly id: string;
  readonly project: StudioProjectIdentity;
  readonly binding: StudioEvidenceBinding;
  readonly operations: readonly MutationEvidenceOperation[];
  readonly purpose?: Extract<
    StudioEvidencePurpose,
    "mutation_preflight" | "mutation_direct_readback"
  >;
}
export function compileMutationEvidenceProjection(
  input: MutationEvidenceProjectionInput,
): StudioEvidenceProjection {
  return compileMutationEvidenceProjectionForManifest(
    input,
    STUDIO_CAPABILITY_MANIFEST,
    STUDIO_CAPABILITY_MANIFEST_HASH,
  );
}

/**
 * Provider-free replay compiles against the immutable manifest artifact that
 * governed the recorded attempt. Current authoring always uses the wrapper
 * above, so callers cannot silently widen live Studio authority.
 */
export function compileMutationEvidenceProjectionForManifest(
  input: MutationEvidenceProjectionInput,
  manifest: StudioCapabilityManifest,
  manifestHash: string,
): StudioEvidenceProjection {
  assertStudioCapabilityManifest(manifest);
  if (contentHash(stableJson(manifest)) !== manifestHash) fail("manifest hash");
  let authoredOperations = 0;
  let consequentialOperations = 0;
  for (const operation of input.operations) {
    if (operation.consequentialStructureOnly === true) consequentialOperations += 1;
    else authoredOperations += 1;
  }
  if (
    authoredOperations === 0 ||
    authoredOperations > manifest.limits.maximumOperations ||
    consequentialOperations > manifest.limits.maximumProjectionFacts
  )
    fail("mutation operation bound");
  const requirements: StudioEvidenceRequirement[] = [];
  const transitionAfterByBefore = new Map<string, string>();
  const transitionBeforeByAfter = new Map<string, string>();
  const transitionTargetByBefore = new Map<string, string>();
  const transitionDispositionByBefore = new Map<string, "deleted" | "retained">();
  for (const operation of input.operations) {
    if (!nonEmpty(operation.id) || operation.target.kind !== "instance")
      fail("mutation operation target");
    const target = operation.target;
    assertTarget(target);
    if (operation.beforeTarget !== undefined) {
      assertTarget(operation.beforeTarget);
      if (
        operation.beforeTarget.kind !== "instance" ||
        operation.kind === "create" ||
        operation.consequentialStructureOnly === true ||
        operation.beforeTarget.className !== target.className
      )
        fail("mutation identity transition");
      const beforeId = studioObjectIdentityKey(operation.beforeTarget.identity);
      const afterId = studioObjectIdentityKey(target.identity);
      if (operation.kind === "move") {
        if (operation.beforeTarget.path === target.path) fail("mutation move before target");
      } else if (
        operation.beforeTarget.path !== target.path ||
        operation.beforeTarget.identity.kind !== "studio_ephemeral" ||
        target.identity.kind !== "forge_attribute" ||
        beforeId === afterId
      ) {
        fail("mutation identity transition");
      }
      if (beforeId !== afterId) {
        if (
          operation.beforeTarget.identity.kind !== "studio_ephemeral" ||
          target.identity.kind !== "forge_attribute"
        )
          fail("mutation identity transition");
        const existingAfter = transitionAfterByBefore.get(beforeId);
        const existingBefore = transitionBeforeByAfter.get(afterId);
        if (
          (existingAfter !== undefined && existingAfter !== afterId) ||
          (existingBefore !== undefined && existingBefore !== beforeId)
        )
          fail("mutation identity transition collision");
        transitionAfterByBefore.set(beforeId, afterId);
        transitionBeforeByAfter.set(afterId, beforeId);
      }
      const targetMaterial = stableJson(target);
      const disposition = operation.kind === "delete" ? "deleted" : "retained";
      const existingTarget = transitionTargetByBefore.get(beforeId);
      const existingDisposition = transitionDispositionByBefore.get(beforeId);
      if (
        (existingTarget !== undefined && existingTarget !== targetMaterial) ||
        (existingDisposition !== undefined && existingDisposition !== disposition)
      )
        fail("mutation before target conflict");
      transitionTargetByBefore.set(beforeId, targetMaterial);
      transitionDispositionByBefore.set(beforeId, disposition);
    } else if (operation.kind === "move") {
      fail("mutation move before target");
    }
    const manifestClass = manifest.classes.find((entry) => entry.name === target.className);
    if (operation.consequentialStructureOnly === true) {
      if (
        operation.kind !== "delete" ||
        operation.beforeTarget !== undefined ||
        operation.structureStatus !== "absent" ||
        operation.structure !== undefined ||
        operation.properties !== undefined ||
        operation.attributes !== undefined ||
        operation.removedAttributes !== undefined ||
        operation.sourceHash !== undefined
      )
        fail("consequential structure proof");
      requirements.push({
        key: studioEvidenceFactKey("structure", target),
        kind: "structure",
        target,
        expectedStatus: "absent",
      });
      continue;
    }
    if (manifestClass === undefined) fail("mutation class outside manifest");
    const expectedStructure: StudioStructureValue = operation.structure ?? {
      identity: target.identity,
      path: target.path,
      className: target.className,
    };
    const structureStatus =
      operation.structureStatus ?? (operation.kind === "delete" ? "absent" : "observed");
    if (
      operation.kind === "delete" ||
      operation.kind === "create" ||
      operation.kind === "move" ||
      operation.structure !== undefined ||
      operation.structureStatus !== undefined
    ) {
      requirements.push({
        key: studioEvidenceFactKey("structure", target),
        kind: "structure",
        target,
        expectedStatus: structureStatus,
        ...(structureStatus === "observed" ? { expected: expectedStructure } : {}),
      });
    }
    for (const [name, value] of Object.entries(operation.properties ?? {}).sort(([left], [right]) =>
      compareText(left, right),
    )) {
      const property = manifestClass.properties.find((candidate) => candidate.name === name);
      if (property === undefined) fail(`mutation property outside manifest: ${name}`);
      assertStudioValueForProperty(value, property);
      requirements.push({
        key: studioEvidenceFactKey("property", target, name),
        kind: "property",
        target,
        propertyName: name,
        expected: canonicalStudioValue(value, property),
      });
    }
    for (const [name, value] of Object.entries(operation.attributes ?? {}).sort(([left], [right]) =>
      compareText(left, right),
    )) {
      assertAttribute(name, value, manifest);
      requirements.push({
        key: studioEvidenceFactKey("attribute", target, name),
        kind: "attribute",
        target,
        attributeName: name,
        expected: canonicalPrimitive(value),
      });
    }
    for (const name of [...(operation.removedAttributes ?? [])].sort()) {
      assertAttributeName(name, manifest);
      requirements.push({
        key: studioEvidenceFactKey("attribute", target, name),
        kind: "attribute",
        target,
        attributeName: name,
        expectedStatus: "absent",
      });
    }
    if (operation.sourceHash !== undefined) {
      if (!hash(operation.sourceHash)) fail("mutation source hash");
      requirements.push({
        key: studioEvidenceFactKey("source_hash", target),
        kind: "source_hash",
        target,
        expected: operation.sourceHash,
      });
    }
  }
  const roots = [...manifest.roots];
  return createStudioEvidenceProjection(
    {
      id: input.id,
      manifestHash,
      purpose: input.purpose ?? "mutation_direct_readback",
      project: input.project,
      binding: input.binding,
      requirements,
      scope: { roots },
      bounds: {
        maximumFacts: manifest.limits.maximumProjectionFacts,
        maximumBytes: manifest.limits.maximumProjectionBytes,
        roots,
      },
    },
    manifest,
  );
}

export interface RuntimeEvidenceCall {
  readonly id: string;
  readonly targetId: string;
  readonly target: StudioEvidenceTarget;
  readonly capability:
    | "instance.resolve"
    | "base_part.position"
    | "base_part.position_series"
    | "instance.property"
    | "instance.property_series";
  /** Required precisely by the two fixed manifest-property capability kinds. */
  readonly propertyName?: string;
}
export interface RuntimeEvidenceProjectionInput {
  readonly id: string;
  readonly project: StudioProjectIdentity;
  readonly binding: StudioEvidenceBinding;
  readonly calls: readonly RuntimeEvidenceCall[];
  readonly purpose?: Extract<StudioEvidencePurpose, "runtime_evaluation" | "creator_verification">;
}
export function compileRuntimeEvidenceProjection(
  input: RuntimeEvidenceProjectionInput,
): StudioEvidenceProjection {
  if (
    input.calls.length === 0 ||
    input.calls.length > STUDIO_CAPABILITY_MANIFEST.limits.maximumRuntimeCalls
  )
    fail("runtime call bound");
  const targetIds = new Set<string>();
  const requirements: StudioEvidenceRequirement[] = [];
  for (const call of input.calls) {
    if (!nonEmpty(call.id) || !nonEmpty(call.targetId)) fail("runtime call");
    targetIds.add(call.targetId);
    const kind: StudioFactKind =
      call.capability === "instance.resolve"
        ? "runtime_resolution"
        : call.capability === "base_part.position"
          ? "position"
          : call.capability === "base_part.position_series"
            ? "position_series"
            : call.capability === "instance.property"
              ? "runtime_property"
              : "runtime_property_series";
    const propertyName = call.propertyName;
    if (
      (kind === "runtime_property" || kind === "runtime_property_series") &&
      (!nonEmpty(propertyName) ||
        call.target.kind !== "instance" ||
        manifestPropertyFor(call.target.className, propertyName) === undefined)
    )
      fail("runtime manifest property");
    requirements.push({
      key: studioEvidenceFactKey(kind, call.target, call.id),
      kind,
      target: call.target,
      callId: call.id,
      runtimeTargetId: call.targetId,
      capability: call.capability,
      ...(propertyName === undefined ? {} : { propertyName }),
    });
  }
  if (targetIds.size > STUDIO_CAPABILITY_MANIFEST.limits.maximumRuntimeTargets)
    fail("runtime target bound");
  const roots = [...STUDIO_AUTHORING_ROOTS];
  return createStudioEvidenceProjection({
    id: input.id,
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    purpose: input.purpose ?? "runtime_evaluation",
    project: input.project,
    binding: input.binding,
    requirements,
    scope: { roots },
    bounds: {
      maximumFacts: STUDIO_CAPABILITY_MANIFEST.limits.maximumRuntimeCalls,
      maximumBytes: STUDIO_CAPABILITY_MANIFEST.limits.maximumRuntimeResultBytes,
      roots,
    },
  });
}

export function runtimeResultsFromEvidence(
  envelope: StudioEvidenceEnvelope,
  projection?: StudioEvidenceProjection,
): RuntimeEvidenceResult[] {
  if (projection !== undefined) assertEvidenceAgainstProjection(envelope, projection);
  else assertStudioEvidenceEnvelope(envelope);
  const results: RuntimeEvidenceResult[] = [];
  for (const fact of envelope.facts) {
    if (fact.kind === "runtime_resolution") {
      if (fact.result.status === "observed")
        results.push({
          id: fact.callId,
          capability: fact.capability,
          targetId: fact.runtimeTargetId,
          status: "resolved",
          path: fact.result.value.path,
          className: fact.result.value.className,
        });
      else
        results.push({
          id: fact.callId,
          capability: fact.capability,
          targetId: fact.runtimeTargetId,
          status: fact.result.status === "absent" ? "missing" : "unavailable",
        });
    } else if (fact.kind === "position" && fact.callId !== undefined) {
      results.push(
        fact.result.status === "observed"
          ? {
              id: fact.callId,
              capability: "base_part.position",
              targetId: fact.runtimeTargetId!,
              status: "ok",
              position: {
                x: fact.result.value.x,
                y: fact.result.value.y,
                z: fact.result.value.z,
              },
            }
          : {
              id: fact.callId,
              capability: "base_part.position",
              targetId: fact.runtimeTargetId!,
              status: "unavailable",
            },
      );
    } else if (fact.kind === "position_series") {
      results.push(
        fact.result.status === "observed"
          ? {
              id: fact.callId,
              capability: fact.capability,
              targetId: fact.runtimeTargetId,
              status: "ok",
              samples: fact.result.value,
            }
          : {
              id: fact.callId,
              capability: fact.capability,
              targetId: fact.runtimeTargetId,
              status: "unavailable",
            },
      );
    } else if (fact.kind === "runtime_property") {
      results.push(
        fact.result.status === "observed"
          ? {
              id: fact.callId,
              capability: fact.capability,
              targetId: fact.runtimeTargetId,
              propertyName: fact.propertyName,
              status: "ok",
              value: fact.result.value,
            }
          : {
              id: fact.callId,
              capability: fact.capability,
              targetId: fact.runtimeTargetId,
              propertyName: fact.propertyName,
              status: "unavailable",
            },
      );
    } else if (fact.kind === "runtime_property_series") {
      results.push(
        fact.result.status === "observed"
          ? {
              id: fact.callId,
              capability: fact.capability,
              targetId: fact.runtimeTargetId,
              propertyName: fact.propertyName,
              status: "ok",
              samples: fact.result.value,
            }
          : {
              id: fact.callId,
              capability: fact.capability,
              targetId: fact.runtimeTargetId,
              propertyName: fact.propertyName,
              status: "unavailable",
            },
      );
    }
  }
  return results.sort((left, right) => left.id.localeCompare(right.id));
}

export function serializeStudioEvidenceProjection(value: StudioEvidenceProjection): string {
  assertStudioEvidenceProjection(value);
  return stableCanonicalJson(value);
}

function assertRequirement(value: unknown): asserts value is StudioEvidenceRequirement {
  const requirement = record(value, "StudioEvidenceRequirement");
  const keys = [
    "key",
    "kind",
    "target",
    "propertyName",
    "attributeName",
    "callId",
    "runtimeTargetId",
    "capability",
    "expectedStatus",
    "expected",
  ].filter((key) => requirement[key] !== undefined);
  exactKeys(requirement, keys, "StudioEvidenceRequirement");
  if (!nonEmpty(requirement.key) || !FACT_KINDS.includes(requirement.kind as StudioFactKind))
    fail("StudioEvidenceRequirement");
  assertTarget(requirement.target);
  for (const key of ["propertyName", "attributeName", "callId", "runtimeTargetId"])
    if (requirement[key] !== undefined && !nonEmpty(requirement[key]))
      fail("StudioEvidenceRequirement");
  if (
    requirement.expectedStatus !== undefined &&
    requirement.expectedStatus !== "observed" &&
    requirement.expectedStatus !== "absent"
  )
    fail("StudioEvidenceRequirement result status");
}
function assertScope(
  value: unknown,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): asserts value is StudioEvidenceScope {
  const scope = record(value, "StudioEvidenceScope");
  exactKeys(scope, ["roots"], "StudioEvidenceScope");
  const roots = stringArray(scope.roots, "scope roots");
  sortedUnique(roots, "scope roots");
  for (const root of roots) if (!manifest.roots.includes(root)) fail("scope root");
}
function assertBounds(
  value: unknown,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): asserts value is StudioEvidenceBounds {
  const bounds = record(value, "StudioEvidenceBounds");
  exactKeys(bounds, ["maximumFacts", "maximumBytes", "roots"], "StudioEvidenceBounds");
  if (!positiveInteger(bounds.maximumFacts) || !positiveInteger(bounds.maximumBytes))
    fail("StudioEvidenceBounds");
  if (
    Number(bounds.maximumFacts) > manifest.limits.maximumProjectionFacts ||
    Number(bounds.maximumBytes) > manifest.limits.maximumProjectionBytes
  )
    fail("StudioEvidenceBounds");
  stringArray(bounds.roots, "bounds roots");
}
function assertBinding(value: unknown): asserts value is StudioEvidenceBinding {
  const binding = record(value, "StudioEvidenceBinding");
  for (const [key, entry] of Object.entries(binding))
    if (!nonEmpty(key) || (entry !== undefined && !nonEmpty(entry))) fail("StudioEvidenceBinding");
}
function assertTarget(value: unknown): asserts value is StudioEvidenceTarget {
  const target = record(value, "StudioEvidenceTarget");
  if (target.kind === "project") {
    exactKeys(target, ["kind"], "project target");
    return;
  }
  if (target.kind !== "instance") fail("StudioEvidenceTarget");
  exactKeys(target, ["kind", "identity", "path", "className"], "instance target");
  assertStudioObjectIdentity(target.identity);
  if (!safeStudioPath(target.path) || !nonEmpty(target.className)) fail("instance target");
}
function assertProject(value: unknown): asserts value is StudioProjectIdentity {
  const project = record(value, "StudioProjectIdentity");
  exactKeys(project, ["name", "placeId", "universeId"], "StudioProjectIdentity");
  if (
    !nonEmpty(project.name) ||
    !nonNegativeInteger(project.placeId) ||
    !nonNegativeInteger(project.universeId)
  )
    fail("StudioProjectIdentity");
}
function assertFactResult(value: unknown, kind: string): void {
  const result = record(value, "Studio fact result");
  if (result.status === "observed") {
    exactKeys(result, ["status", "value"], "observed fact result");
    return;
  }
  if (result.status === "absent") {
    exactKeys(result, ["status"], "absent fact result");
    return;
  }
  if (result.status === "unavailable" || result.status === "read_error") {
    exactKeys(result, ["status", "code"], "unavailable fact result");
    if (!nonEmpty(result.code)) fail(`${kind} fact result`);
    return;
  }
  fail(`${kind} fact result`);
}
function assertFactObservedValue(
  fact: StudioEvidenceFact,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): void {
  if (fact.result.status !== "observed") return;
  const value: unknown = fact.result.value;
  switch (fact.kind) {
    case "structure":
      assertStructure(value);
      return;
    case "property":
      assertStudioValue(value);
      const property =
        fact.target.kind === "instance"
          ? manifestPropertyFor(fact.target.className, fact.propertyName, manifest)
          : undefined;
      if (property === undefined) fail("property outside manifest");
      assertStudioValueForProperty(value as StudioValue, property);
      return;
    case "attribute_inventory":
      sortedUnique(stringArray(value, "attribute inventory"), "attribute inventory");
      return;
    case "attribute":
      assertAttribute(fact.attributeName, value, manifest);
      return;
    case "source_hash":
      if (!hash(value)) fail("source hash");
      return;
    case "tags":
      sortedUnique(stringArray(value, "tags"), "tags");
      return;
    case "remote":
      assertRemote(value);
      return;
    case "runtime_resolution":
      assertRuntimeResolution(value);
      return;
    case "position":
      assertStudioValue(value);
      if ((value as StudioValue).kind !== "vector3_f32") fail("position");
      return;
    case "position_series":
      assertPositionSeries(value);
      return;
    case "runtime_property":
      assertRuntimeProperty(value, fact.target, fact.propertyName, manifest);
      return;
    case "runtime_property_series":
      assertRuntimePropertySeries(value, fact.target, fact.propertyName, manifest);
      return;
    case "diagnostic":
      assertDiagnostic(value);
      return;
    case "reflection":
      assertReflection(value);
      return;
  }
}
function factMatchesRequirement(
  fact: StudioEvidenceFact,
  requirement: StudioEvidenceRequirement,
): boolean {
  return (
    fact.kind === requirement.kind &&
    fact.key === requirement.key &&
    sameTarget(fact.target, requirement.target) &&
    (requirement.propertyName === undefined ||
      ((fact.kind === "property" ||
        fact.kind === "runtime_property" ||
        fact.kind === "runtime_property_series") &&
        fact.propertyName === requirement.propertyName)) &&
    (requirement.attributeName === undefined ||
      (fact.kind === "attribute" && fact.attributeName === requirement.attributeName)) &&
    (requirement.callId === undefined ||
      ("callId" in fact && fact.callId === requirement.callId)) &&
    (requirement.runtimeTargetId === undefined ||
      ("runtimeTargetId" in fact && fact.runtimeTargetId === requirement.runtimeTargetId)) &&
    (requirement.capability === undefined ||
      ("capability" in fact && fact.capability === requirement.capability))
  );
}
function factResultMaterial(result: StudioFactResult<unknown>): string {
  if (result.status === "observed")
    return tagged(
      "result",
      tagged("status", result.status),
      tagged("value", canonicalDataMaterial(result.value)),
    );
  return result.status === "absent"
    ? tagged("result", tagged("status", result.status))
    : tagged("result", tagged("status", result.status), tagged("code", result.code));
}
function requirementMaterial(requirement: StudioEvidenceRequirement): string {
  return tagged(
    "requirement",
    tagged("key", requirement.key),
    tagged("kind", requirement.kind),
    targetMaterial(requirement.target),
    tagged("property", requirement.propertyName ?? ""),
    tagged("attribute", requirement.attributeName ?? ""),
    tagged("call", requirement.callId ?? ""),
    tagged("runtime-target", requirement.runtimeTargetId ?? ""),
    tagged("capability", requirement.capability ?? ""),
    tagged("expected-status", requirement.expectedStatus ?? "observed"),
    tagged(
      "expected",
      requirement.expected === undefined ? "" : canonicalDataMaterial(requirement.expected),
    ),
  );
}
function projectMaterial(project: StudioProjectIdentity): string {
  return tagged(
    "project",
    tagged("name", project.name),
    tagged("place", String(project.placeId)),
    tagged("universe", String(project.universeId)),
  );
}
function targetMaterial(target: StudioEvidenceTarget): string {
  return target.kind === "project"
    ? tagged("target", "project")
    : tagged(
        "target",
        tagged("identity", studioObjectIdentityKey(target.identity)),
        tagged("path", target.path),
        tagged("class", target.className),
      );
}
function scopeMaterial(scope: StudioEvidenceScope): string {
  return tagged(
    "scope",
    tagged("roots", taggedSequence(scope.roots.map((root) => tagged("root", root)))),
  );
}
function boundsMaterial(bounds: StudioEvidenceBounds): string {
  return tagged(
    "bounds",
    tagged("facts", String(bounds.maximumFacts)),
    tagged("bytes", String(bounds.maximumBytes)),
    tagged("roots", taggedSequence(bounds.roots.map((root) => tagged("root", root)))),
  );
}
function diagnosticMaterial(value: StudioDiagnosticValue): string {
  assertDiagnostic(value);
  return tagged("diagnostic", tagged("code", value.code), tagged("hash", value.messageHash));
}
function compareFacts(left: StudioEvidenceFact, right: StudioEvidenceFact): number {
  return compareText(studioEvidenceFactMaterial(left), studioEvidenceFactMaterial(right));
}
function assertStructure(value: unknown): asserts value is StudioStructureValue {
  const structure = record(value, "structure");
  const keys = [
    "identity",
    "path",
    "className",
    ...(structure.parentIdentity === undefined ? [] : ["parentIdentity"]),
    ...(structure.parentPath === undefined ? [] : ["parentPath"]),
  ];
  exactKeys(structure, keys, "structure");
  assertStudioObjectIdentity(structure.identity);
  if (structure.parentIdentity !== undefined) assertStudioObjectIdentity(structure.parentIdentity);
  if (
    !safeStudioPath(structure.path) ||
    !nonEmpty(structure.className) ||
    (structure.parentPath !== undefined && !safeStudioPath(structure.parentPath))
  )
    fail("structure");
}
function assertRemote(value: unknown): asserts value is StudioRemoteValue {
  const remote = record(value, "remote");
  exactKeys(remote, ["name", "className", "direction"], "remote");
  if (
    !nonEmpty(remote.name) ||
    !["RemoteEvent", "RemoteFunction"].includes(String(remote.className)) ||
    !["client_to_server", "server_to_client"].includes(String(remote.direction))
  )
    fail("remote");
}
function assertRuntimeResolution(value: unknown): asserts value is StudioRuntimeResolutionValue {
  const resolution = record(value, "runtime resolution");
  exactKeys(resolution, ["path", "className"], "runtime resolution");
  if (!safeStudioPath(resolution.path) || !nonEmpty(resolution.className))
    fail("runtime resolution");
}
function assertPositionSeries(value: unknown): asserts value is readonly StudioPositionSample[] {
  const samples = array(value, "position series");
  let previous = -1;
  for (const sampleValue of samples) {
    const sample = record(sampleValue, "position sample");
    exactKeys(sample, ["sequence", "elapsedMs", "value"], "position sample");
    const typed = sample as unknown as StudioPositionSample;
    if (
      !nonNegativeInteger(typed.sequence) ||
      typed.sequence <= previous ||
      !nonNegativeInteger(typed.elapsedMs)
    )
      fail("position sample");
    previous = typed.sequence;
    assertStudioValue({
      kind: "vector3_f32",
      ...record(typed.value, "position sample value"),
    });
  }
}
function assertRuntimeProperty(
  value: unknown,
  target: StudioEvidenceTarget,
  propertyName: string,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): void {
  if (target.kind !== "instance") fail("runtime property target");
  const property = manifestPropertyFor(target.className, propertyName, manifest);
  if (property === undefined || property.codec === "instance_ref")
    fail("runtime property outside manifest");
  assertStudioValue(value);
  assertStudioValueForProperty(value as StudioValue, property);
}
function assertRuntimePropertySeries(
  value: unknown,
  target: StudioEvidenceTarget,
  propertyName: string,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): asserts value is readonly StudioManifestPropertySample[] {
  const samples = array(value, "runtime property series");
  let previous = -1;
  for (const sampleValue of samples) {
    const sample = record(sampleValue, "runtime property sample");
    exactKeys(sample, ["sequence", "elapsedMs", "value"], "runtime property sample");
    if (
      !nonNegativeInteger(sample.sequence) ||
      Number(sample.sequence) <= previous ||
      !nonNegativeInteger(sample.elapsedMs)
    )
      fail("runtime property sample");
    previous = Number(sample.sequence);
    assertRuntimeProperty(sample.value, target, propertyName, manifest);
  }
}
function assertDiagnostic(value: unknown): asserts value is StudioDiagnosticValue {
  const diagnostic = record(value, "diagnostic");
  exactKeys(diagnostic, ["code", "messageHash"], "diagnostic");
  if (!nonEmpty(diagnostic.code) || !hash(diagnostic.messageHash)) fail("diagnostic");
}
function assertCatalogType(value: unknown): asserts value is StudioCatalogType {
  const catalogType = record(value, "catalog type");
  exactKeys(catalogType, ["category", "name"], "catalog type");
  if (
    !(["primitive", "datatype", "enum", "class"] as string[]).includes(
      String(catalogType.category),
    ) ||
    !nonEmpty(catalogType.name)
  )
    fail("catalog type");
}
function assertReflectionTypeExpectation(
  value: unknown,
  catalogType: StudioCatalogType,
): asserts value is StudioReflectionTypeExpectation {
  const reflection = record(value, "reflection type expectation");
  exactKeys(
    reflection,
    [
      "engineType",
      "scriptType",
      ...(reflection.enumType === undefined ? [] : ["enumType"]),
      ...(reflection.instanceType === undefined ? [] : ["instanceType"]),
    ],
    "reflection type expectation",
  );
  if (
    !nonEmpty(reflection.engineType) ||
    !nonEmpty(reflection.scriptType) ||
    (reflection.enumType !== undefined && !nonEmpty(reflection.enumType)) ||
    (reflection.instanceType !== undefined && !nonEmpty(reflection.instanceType))
  )
    fail("reflection type expectation");
  if (
    (catalogType.category === "enum") !== (reflection.enumType !== undefined) ||
    (catalogType.category === "class") !== (reflection.instanceType !== undefined)
  )
    fail("reflection type expectation category");
}
function assertReflectionType(value: unknown): asserts value is StudioReflectionTypeValue {
  const type = record(value, "reflection type");
  exactKeys(
    type,
    [
      ...(type.engineType === undefined ? [] : ["engineType"]),
      ...(type.scriptType === undefined ? [] : ["scriptType"]),
      ...(type.enumType === undefined ? [] : ["enumType"]),
      ...(type.instanceType === undefined ? [] : ["instanceType"]),
    ],
    "reflection type",
  );
  if (
    (type.engineType !== undefined && !nonEmpty(type.engineType)) ||
    (type.scriptType !== undefined && !nonEmpty(type.scriptType)) ||
    (type.enumType !== undefined && !nonEmpty(type.enumType)) ||
    (type.instanceType !== undefined && !nonEmpty(type.instanceType))
  )
    fail("reflection type");
}
function assertReflection(value: unknown): asserts value is StudioReflectionValue {
  const reflection = record(value, "reflection");
  exactKeys(
    reflection,
    ["className", "propertyName", "owner", "type", "inherited", "serialized", "permits"],
    "reflection",
  );
  if (
    !nonEmpty(reflection.className) ||
    !nonEmpty(reflection.propertyName) ||
    !nonEmpty(reflection.owner) ||
    typeof reflection.inherited !== "boolean" ||
    typeof reflection.serialized !== "boolean"
  )
    fail("reflection");
  assertReflectionType(reflection.type);
  const permits = stringArray(reflection.permits, "reflection permits");
  if (!permits.every((entry) => entry === "read" || entry === "write")) fail("reflection permits");
  sortedUnique(permits, "reflection permits");
}
function assertAttributeName(
  name: string,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): void {
  if (
    !nonEmpty(name) ||
    utf8Length(name) > manifest.attributes.maximumNameUtf8Bytes ||
    name.startsWith(manifest.attributes.reservedPrefix)
  )
    fail("attribute name");
}
function assertAttribute(
  name: string,
  value: unknown,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): asserts value is StudioPrimitiveValue {
  assertAttributeName(name, manifest);
  if (typeof value === "boolean") return;
  if (typeof value === "number") {
    canonicalF32(value);
    return;
  }
  if (
    typeof value === "string" &&
    validUtf8(value) &&
    utf8Length(value) <= manifest.attributes.maximumStringUtf8Bytes
  )
    return;
  fail("attribute value");
}
function canonicalPrimitive(value: StudioPrimitiveValue): StudioPrimitiveValue {
  return typeof value === "number" ? canonicalF32(value) : value;
}
function manifestClassFor(
  className: string,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): StudioManifestClass | undefined {
  return manifest.classes.find((entry) => entry.name === className);
}
function manifestPropertyFor(
  className: string,
  propertyName: string,
  manifest: StudioCapabilityManifest = STUDIO_CAPABILITY_MANIFEST,
): StudioManifestProperty | undefined {
  return manifestClassFor(className, manifest)?.properties.find(
    (entry) => entry.name === propertyName,
  );
}
function canonicalDataMaterial(value: unknown): string {
  if (isStudioValue(value)) return tagged("studio", canonicalStudioValueMaterial(value));
  if (value === null) return tagged("null", "");
  if (typeof value === "boolean") return tagged("bool", value ? "1" : "0");
  if (typeof value === "string") {
    if (!validUtf8(value)) fail("canonical string");
    return tagged("utf8", value);
  }
  if (typeof value === "number") return tagged("f64", f64Bits(value));
  if (Array.isArray(value))
    return tagged("array", taggedSequence(value.map(canonicalDataMaterial)));
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      compareText(left, right),
    );
    return tagged(
      "object",
      taggedSequence(
        entries.map(([key, entry]) =>
          tagged("entry", tagged("key", key), tagged("value", canonicalDataMaterial(entry))),
        ),
      ),
    );
  }
  fail("canonical data");
}
function stableCanonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCanonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableCanonicalJson(entry)}`)
      .join(",")}}`;
  fail("JSON serialization");
}
function tagged(tag: string, material: string, ...rest: string[]): string {
  const payload = rest.length === 0 ? material : [material, ...rest].join("");
  return `${utf8Length(tag)}:${tag}${utf8Length(payload)}:${payload}`;
}
function taggedSequence(parts: readonly string[]): string {
  return tagged("sequence", tagged("count", String(parts.length)), ...parts);
}
function f32Bits(value: number): string {
  const canonical = canonicalF32(value);
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, canonical, false);
  return view.getUint32(0, false).toString(16).padStart(8, "0");
}
function f64Bits(value: number): string {
  if (!Number.isFinite(value)) fail("non-finite number");
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return `${view.getUint32(0, false).toString(16).padStart(8, "0")}${view.getUint32(4, false).toString(16).padStart(8, "0")}`;
}
function canonicalF32(value: number): number {
  if (!Number.isFinite(value)) fail("non-finite f32");
  const result = Math.fround(value);
  if (!Number.isFinite(result)) fail("f32 overflow");
  return result;
}
function canonicalF64(value: number): number {
  if (!Number.isFinite(value)) fail("non-finite f64");
  return value;
}
function isInt64Decimal(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|-?[1-9][0-9]*)$/.test(value)) return false;
  const parsed = BigInt(value);
  // Roblox exposes int64 through Luau's IEEE-754 number. Values beyond the
  // exact integer domain cannot satisfy write/read/compare closure.
  return parsed >= -9_007_199_254_740_991n && parsed <= 9_007_199_254_740_991n;
}
function assertUdim(value: unknown, label: string): asserts value is StudioUdimValue {
  const udim = record(value, label);
  exactKeys(udim, ["scale", "offset"], label);
  if (
    !finiteNumber(udim.scale) ||
    !Number.isInteger(udim.offset) ||
    Number(udim.offset) < -2_147_483_648 ||
    Number(udim.offset) > 2_147_483_647
  )
    fail(label);
}
function canonicalUdim(value: StudioUdimValue): StudioUdimValue {
  assertUdim(value, "udim value");
  return { scale: canonicalF32(value.scale), offset: value.offset };
}
function assertVector3(
  value: unknown,
  label: string,
): asserts value is {
  readonly x: number;
  readonly y: number;
  readonly z: number;
} {
  const vector = record(value, label);
  exactKeys(vector, ["x", "y", "z"], label);
  if (![vector.x, vector.y, vector.z].every(finiteNumber)) fail(label);
}
function canonicalVector3(value: { readonly x: number; readonly y: number; readonly z: number }): {
  readonly x: number;
  readonly y: number;
  readonly z: number;
} {
  assertVector3(value, "vector3 value");
  return {
    x: canonicalF32(value.x),
    y: canonicalF32(value.y),
    z: canonicalF32(value.z),
  };
}
function assertNumberSequence(
  value: unknown,
): asserts value is readonly StudioNumberSequenceKeypoint[] {
  const keypoints = array(value, "number sequence keypoints");
  if (keypoints.length < 2) fail("number sequence keypoints");
  let previous = -1;
  for (const entry of keypoints) {
    const keypoint = record(entry, "number sequence keypoint");
    exactKeys(keypoint, ["time", "value", "envelope"], "number sequence keypoint");
    if (
      ![keypoint.time, keypoint.value, keypoint.envelope].every(finiteNumber) ||
      Number(keypoint.time) < 0 ||
      Number(keypoint.time) > 1 ||
      Number(keypoint.time) <= previous ||
      Number(keypoint.envelope) < 0
    )
      fail("number sequence keypoint");
    previous = Number(keypoint.time);
  }
  if (
    (keypoints[0] as StudioNumberSequenceKeypoint).time !== 0 ||
    (keypoints.at(-1) as StudioNumberSequenceKeypoint).time !== 1
  )
    fail("number sequence endpoints");
}
function assertColorSequence(
  value: unknown,
): asserts value is readonly StudioColorSequenceKeypoint[] {
  const keypoints = array(value, "color sequence keypoints");
  if (keypoints.length < 2) fail("color sequence keypoints");
  let previous = -1;
  for (const entry of keypoints) {
    const keypoint = record(entry, "color sequence keypoint");
    exactKeys(keypoint, ["time", "color"], "color sequence keypoint");
    const color = record(keypoint.color, "color sequence color");
    exactKeys(color, ["r", "g", "b"], "color sequence color");
    if (
      !finiteNumber(keypoint.time) ||
      Number(keypoint.time) < 0 ||
      Number(keypoint.time) > 1 ||
      Number(keypoint.time) <= previous ||
      ![color.r, color.g, color.b].every(byte)
    )
      fail("color sequence keypoint");
    previous = Number(keypoint.time);
  }
  if (
    (keypoints[0] as StudioColorSequenceKeypoint).time !== 0 ||
    (keypoints.at(-1) as StudioColorSequenceKeypoint).time !== 1
  )
    fail("color sequence endpoints");
}
function numericComponents(value: StudioValue): readonly number[] {
  switch (value.kind) {
    case "number_f32":
    case "number_f64":
    case "int32":
      return [value.value];
    case "vector2_f32":
      return [value.x, value.y];
    case "vector3_f32":
      return [value.x, value.y, value.z];
    case "cframe_f32x12":
      return value.components;
    case "udim":
      return [value.scale, value.offset];
    case "udim2":
      return [value.x.scale, value.x.offset, value.y.scale, value.y.offset];
    case "rect":
      return [value.minX, value.minY, value.maxX, value.maxY];
    case "number_range":
      return [value.min, value.max];
    case "number_sequence":
      return value.keypoints.flatMap((entry) => [entry.time, entry.value, entry.envelope]);
    case "color_sequence":
      return value.keypoints.flatMap((entry) => [
        entry.time,
        entry.color.r,
        entry.color.g,
        entry.color.b,
      ]);
    case "physical_properties":
      return [
        value.density,
        value.friction,
        value.elasticity,
        value.frictionWeight,
        value.elasticityWeight,
      ];
    case "ray":
      return [
        value.origin.x,
        value.origin.y,
        value.origin.z,
        value.direction.x,
        value.direction.y,
        value.direction.z,
      ];
    default:
      return [];
  }
}
function udimMaterial(value: StudioUdimValue): string {
  return tagged(
    "udim",
    tagged("scale", f32Bits(value.scale)),
    tagged("offset", String(value.offset)),
  );
}
function colorMaterial(value: {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}): string {
  return tagged(
    "color",
    tagged("r", String(value.r)),
    tagged("g", String(value.g)),
    tagged("b", String(value.b)),
  );
}
function vector3Material(value: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): string {
  return tagged(
    "vector3",
    tagged("x", f32Bits(value.x)),
    tagged("y", f32Bits(value.y)),
    tagged("z", f32Bits(value.z)),
  );
}
function validUtf8(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  );
}
function utf8Length(value: string): number {
  if (!validUtf8(value)) fail("invalid UTF-8");
  return new TextEncoder().encode(value).byteLength;
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(label);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(label);
  return value;
}
function stringArray(value: unknown, label: string): string[] {
  const entries = array(value, label);
  if (!entries.every(nonEmpty)) fail(label);
  return entries as string[];
}
function numberArray(value: unknown, label: string): number[] {
  const entries = array(value, label);
  if (!entries.every((entry) => typeof entry === "number")) fail(label);
  return entries as number[];
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index]))
    fail(`${label} keys`);
}
function sortedUnique(entries: readonly string[], label: string): void {
  if (
    entries.some((entry, index) => index > 0 && compareText(entries[index - 1]!, entry) >= 0) ||
    new Set(entries).size !== entries.length
  )
    fail(`${label} order`);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && validUtf8(value);
}
function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function nonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function byte(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function isCodec(value: unknown): value is StudioCodec {
  return typeof value === "string" && (STUDIO_CODECS as readonly string[]).includes(value);
}
function isGenericNullableCodec(value: unknown): value is Exclude<StudioCodec, "instance_ref"> {
  return isCodec(value) && value !== "instance_ref";
}
function isStudioValue(value: unknown): value is StudioValue {
  try {
    assertStudioValue(value);
    return true;
  } catch {
    return false;
  }
}
function safeStudioPath(value: unknown): value is string {
  return (
    nonEmpty(value) &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}
function sameTarget(left: StudioEvidenceTarget, right: StudioEvidenceTarget): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "project" ||
      right.kind === "project" ||
      (studioObjectIdentityKey(left.identity) === studioObjectIdentityKey(right.identity) &&
        left.path === right.path &&
        left.className === right.className))
  );
}
function sameProject(left: StudioProjectIdentity, right: StudioProjectIdentity): boolean {
  return (
    left.name === right.name &&
    left.placeId === right.placeId &&
    left.universeId === right.universeId
  );
}
/** Lua sorts strings as UTF-8 bytes; use the same order rather than locale or UTF-16 order. */
function compareText(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
function assertInterval(startedAt: unknown, endedAt: unknown): void {
  if (
    !canonicalIso(startedAt) ||
    !canonicalIso(endedAt) ||
    Date.parse(endedAt) < Date.parse(startedAt)
  )
    fail("authoritative interval");
}
function canonicalIso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function fail(message: string): never {
  throw new Error(`Invalid Studio evidence: ${message}`);
}

// Validate the generated source on module load. It turns an accidentally stale
// or manually edited generated table into a deterministic startup failure.
assertStudioCapabilityManifest(STUDIO_CAPABILITY_MANIFEST);
