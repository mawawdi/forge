import type { StudioObjectIdentity } from "./project-index.js";

/**
 * Exhaustive, normalized accountability contracts for the official Roblox
 * Engine API.  The catalog records what Roblox documents; the coverage report
 * records what Forge can author or observe.  Neither document grants mutation
 * authority.  Only the proof-closed StudioCapabilityManifest does that.
 */

export interface RobloxApiCatalogSource {
  readonly kind: "RobloxApiCatalogSource";
  readonly repository: "https://github.com/Roblox/creator-docs.git";
  readonly commit: string;
  readonly engineReferencePath: "content/en-us/reference/engine";
  /** Tagged hash over every sorted class, datatype, enum, global, and library YAML path and its exact bytes. */
  readonly sourceTreeHash: string;
  readonly counts: RobloxApiCatalogCounts;
}

export interface RobloxApiCatalogCounts {
  readonly classes: number;
  readonly datatypes: number;
  readonly enums: number;
  readonly classProperties: number;
  readonly classMethods: number;
  readonly classEvents: number;
  readonly classCallbacks: number;
  readonly datatypeConstants: number;
  readonly datatypeConstructors: number;
  readonly datatypeFunctions: number;
  readonly datatypeMathOperations: number;
  readonly datatypeMethods: number;
  readonly datatypeProperties: number;
  readonly enumItems: number;
  readonly globalProperties: number;
  readonly globalFunctions: number;
  readonly libraries: number;
  readonly libraryProperties: number;
  readonly libraryFunctions: number;
}

export interface RobloxApiParameter {
  readonly name: string;
  readonly type: string;
  /** The exact non-null default represented by the official YAML. */
  readonly default?: string | number | boolean;
}

export interface RobloxApiReturn {
  readonly type: string;
}

export interface RobloxApiSecurity {
  readonly read?: string;
  readonly write?: string;
}

export interface RobloxApiSerialization {
  readonly canLoad: boolean;
  readonly canSave: boolean;
}

export type RobloxClassMemberKind = "property" | "method" | "event" | "callback";
export type RobloxDatatypeMemberKind =
  "constant" | "constructor" | "function" | "math_operation" | "method" | "property";

export interface RobloxClassMember {
  readonly id: string;
  readonly kind: RobloxClassMemberKind;
  readonly name: string;
  readonly declaringClass: string;
  readonly valueType?: string;
  readonly parameters?: readonly RobloxApiParameter[];
  readonly returns?: readonly RobloxApiReturn[];
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  readonly security?: RobloxApiSecurity;
  readonly serialization?: RobloxApiSerialization;
  readonly threadSafety?: string;
  readonly capabilities: readonly string[];
  /** Path relative to the pinned engine-reference root. */
  readonly sourceFile: string;
  readonly sourceFileHash: string;
}

export interface RobloxApiClass {
  readonly id: string;
  readonly name: string;
  readonly superclass?: string;
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  readonly members: readonly RobloxClassMember[];
  /** Path relative to the pinned engine-reference root. */
  readonly sourceFile: string;
  readonly sourceFileHash: string;
}

export interface RobloxDatatypeMember {
  readonly id: string;
  readonly kind: RobloxDatatypeMemberKind;
  readonly name: string;
  readonly declaringDatatype: string;
  readonly valueType?: string;
  readonly operandTypes?: readonly string[];
  readonly parameters?: readonly RobloxApiParameter[];
  readonly returns?: readonly RobloxApiReturn[];
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  /** Path relative to the pinned engine-reference root. */
  readonly sourceFile: string;
  readonly sourceFileHash: string;
}

export interface RobloxApiDatatype {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  readonly members: readonly RobloxDatatypeMember[];
  /** Path relative to the pinned engine-reference root. */
  readonly sourceFile: string;
  readonly sourceFileHash: string;
}

export interface RobloxApiEnumItem {
  readonly id: string;
  readonly name: string;
  readonly value: number;
  readonly tags: readonly string[];
  readonly deprecated: boolean;
}

export interface RobloxApiEnum {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  readonly items: readonly RobloxApiEnumItem[];
  /** Path relative to the pinned engine-reference root. */
  readonly sourceFile: string;
  readonly sourceFileHash: string;
}

export type RobloxGlobalMemberKind = "property" | "function";
export interface RobloxApiGlobalMember {
  readonly id: string;
  readonly kind: RobloxGlobalMemberKind;
  readonly name: string;
  readonly declaringScope: string;
  readonly valueType?: string;
  readonly parameters?: readonly RobloxApiParameter[];
  readonly returns?: readonly RobloxApiReturn[];
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  readonly sourceFile: string;
  readonly sourceFileHash: string;
}

export type RobloxLibraryMemberKind = "property" | "function";
export interface RobloxApiLibraryMember {
  readonly id: string;
  readonly kind: RobloxLibraryMemberKind;
  readonly name: string;
  readonly declaringLibrary: string;
  readonly valueType?: string;
  readonly parameters?: readonly RobloxApiParameter[];
  readonly returns?: readonly RobloxApiReturn[];
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  readonly sourceFile: string;
  readonly sourceFileHash: string;
}

export interface RobloxApiLibrary {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  readonly members: readonly RobloxApiLibraryMember[];
  readonly sourceFile: string;
  readonly sourceFileHash: string;
}

export interface RobloxApiCatalog {
  readonly kind: "RobloxApiCatalog";
  readonly source: RobloxApiCatalogSource;
  readonly classes: readonly RobloxApiClass[];
  readonly datatypes: readonly RobloxApiDatatype[];
  readonly enums: readonly RobloxApiEnum[];
  readonly globalMembers: readonly RobloxApiGlobalMember[];
  readonly libraries: readonly RobloxApiLibrary[];
  readonly counts: RobloxApiCatalogCounts;
  readonly contentHash: string;
}

export type StudioCapabilityDisposition =
  "authorable" | "observable_only" | "source_only" | "creator_reviewed" | "unsupported";

export type StudioCapabilityReason =
  | "proof_closed"
  | "catalog_only"
  | "class_not_enabled"
  | "class_not_creatable"
  | "service_root"
  | "deprecated"
  | "hidden"
  | "read_only"
  | "security_gated"
  | "not_serialized"
  | "unsupported_codec"
  | "reference_policy_missing"
  | "content_policy_missing"
  | "parent_policy_missing"
  | "structure_managed"
  | "detached_preflight_required"
  | "runtime_observation_supported"
  | "runtime_observation_missing"
  | "script_api"
  | "engine_or_external_authority"
  | "nondeterministic_behavior"
  | "creator_judgment";

export type RobloxApiCatalogEntryKind =
  | "class"
  | "class_property"
  | "class_method"
  | "class_event"
  | "class_callback"
  | "datatype"
  | "datatype_constant"
  | "datatype_constructor"
  | "datatype_function"
  | "datatype_math_operation"
  | "datatype_method"
  | "datatype_property"
  | "enum"
  | "enum_item"
  | "global_property"
  | "global_function"
  | "library"
  | "library_property"
  | "library_function";

export interface StudioCapabilityCoverageEntry {
  readonly catalogEntryId: string;
  readonly entryKind: RobloxApiCatalogEntryKind;
  readonly owner?: string;
  readonly name: string;
  readonly disposition: StudioCapabilityDisposition;
  readonly reason: StudioCapabilityReason;
  readonly authoringGroup?: string;
  readonly codec?: string;
  readonly inheritedBy?: readonly string[];
}

export interface StudioCapabilityCoverageSummary {
  readonly total: number;
  readonly byDisposition: Readonly<Record<StudioCapabilityDisposition, number>>;
  readonly byReason: Readonly<Partial<Record<StudioCapabilityReason, number>>>;
  readonly authorableClasses: number;
  readonly authorableProperties: number;
}

export interface StudioCapabilityCoverageReport {
  readonly kind: "StudioCapabilityCoverageReport";
  readonly catalogHash: string;
  readonly policyHash: string;
  readonly manifestHash: string;
  readonly entries: readonly StudioCapabilityCoverageEntry[];
  readonly summary: StudioCapabilityCoverageSummary;
  readonly contentHash: string;
}

/** A nil engine reference is an observed value, never missing evidence. */
export type StudioInstanceReference =
  | {
      readonly kind: "instance_ref";
      readonly state: "nil";
      readonly expectedClass: string;
    }
  | {
      readonly kind: "instance_ref";
      readonly state: "reference";
      /** Exact closed identity; path/class are display and preconditions only. */
      readonly identity: StudioObjectIdentity;
      readonly path: string;
      /** Exact observed class; `expectedClass` may name an ancestor constraint. */
      readonly className: string;
      readonly expectedClass: string;
    };

export type StudioAuthoringPropertyMode = "structure_only" | "proof_closed_supported_types";

export interface StudioAuthoringGroupPolicy {
  readonly name: string;
  readonly classes: readonly string[];
  readonly propertyMode: StudioAuthoringPropertyMode;
  readonly excludedProperties?: readonly string[];
}

export interface StudioCapabilityPolicy {
  readonly kind: "StudioCapabilityPolicy";
  readonly catalogCommit: string;
  readonly roots: readonly string[];
  readonly authoringContainers: readonly {
    readonly path: string;
    readonly className: string;
  }[];
  readonly operationKinds: readonly string[];
  readonly authoringGroups: readonly StudioAuthoringGroupPolicy[];
  readonly codecByApiType: Readonly<Record<string, string>>;
  readonly propertyDefaults: Readonly<{
    maximumUtf8Bytes: number;
    maximumEntries: number;
    maximumAbsoluteTranslation: number;
  }>;
  /** Catalog-derived structural or authority boundaries, never hidden fallbacks. */
  readonly propertyExclusions: Readonly<
    Record<
      string,
      Readonly<{
        reason:
          | "structure_managed"
          | "parent_policy_missing"
          | "engine_or_external_authority"
          | "nondeterministic_behavior";
      }>
    >
  >;
  readonly propertyOverrides: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly runtimeCapabilities: readonly Readonly<Record<string, unknown>>[];
  readonly limits: Readonly<Record<string, number>>;
}
