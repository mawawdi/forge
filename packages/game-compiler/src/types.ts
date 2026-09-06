import type {
  CreatorPlanChange,
  CreatorSourceWriteBlobBinding,
  CreatorProjectIndexView,
  StudioChangeOperation,
  StudioInstanceTarget,
} from "../../creator-session/src/index.js";
import type { CreatorTransactionTopologyNode } from "../../creator-session/src/transaction-topology.js";
import type {
  StudioEvidenceProjection,
  StudioProjectIdentity,
  StudioValue,
} from "../../studio-evidence/src/index.js";
import type { GameDataSchema, GameDesignSpec, GameSourceContent } from "../../game-ir/src/index.js";

export interface GameValueSlot {
  readonly id: string;
  readonly propertyName: string;
  readonly schema: GameDataSchema;
}

/** Structural compiler output uses the existing creator change algebra. */
export interface GameInventoryItem {
  readonly id: string;
  readonly componentId: string;
  /** Stable component output alias, unique within the component; never a Studio identity. */
  readonly outputId?: string;
  readonly change: CreatorPlanChange;
  readonly lockedProperties: Readonly<Record<string, StudioValue>>;
  readonly valueSlots: readonly GameValueSlot[];
  readonly source?: { readonly fileId: string; readonly content: GameSourceContent };
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly removedAttributes: readonly string[];
  /** Required operation order; component content dependencies remain in the design DAG. */
  readonly dependencies: readonly string[];
  readonly atomicGroup?: string;
  /** Exact observed creator-index object hash, required for existing object mutation. */
  readonly beforeHash?: string;
  readonly beforeSourceHash?: string;
  readonly beforeSourceBytes?: number;
}

export interface GameComponentCompilerInput {
  readonly componentId: string;
  readonly projectId: string;
  readonly project: StudioProjectIdentity;
  readonly designHash: string;
  readonly initialTopology: readonly CreatorTransactionTopologyNode[];
  readonly observation?: CreatorProjectIndexView;
}

export interface GameComponentOutput {
  readonly id: string;
  readonly operationId: string;
}

/** The sole direct-component compiler result shape. */
export interface GameComponentCompilation {
  readonly inventory: readonly GameInventoryItem[];
  readonly outputs: readonly GameComponentOutput[];
  readonly observedSources: readonly GameObservedSourceArtifact[];
}
/** Revision-bound source dependencies already present in the observed editor. */
export interface GameObservedSourceArtifact {
  readonly componentId: string;
  readonly fileId: string;
  readonly target: StudioInstanceTarget;
  readonly sourceHash: string;
  readonly utf8Bytes: number;
  readonly imports: readonly { readonly componentId: string; readonly fileId: string }[];
}

export interface GameCompilerPolicy {
  readonly maximumOperations: number;
  readonly maximumCanonicalBytes: number;
  readonly maximumSourceBytes: number;
  readonly maximumPartitions: number;
  readonly maximumPartitionOperations: number;
  readonly maximumPartitionFacts: number;
  readonly maximumPartitionBytes: number;
}

export interface GamePlan {
  readonly kind: "GamePlan";
  readonly id: string;
  readonly hash: string;
  readonly design: GameDesignSpec;
  readonly designHash: string;
  readonly projectId: string;
  readonly project: StudioProjectIdentity;
  readonly sessionId: string;
  readonly observedRevisionHash: string;
  readonly manifestHash: string;
  readonly compilerAbi: string;
  readonly policy: GameCompilerPolicy;
  readonly initialTopology: readonly CreatorTransactionTopologyNode[];
  readonly inventory: readonly GameInventoryItem[];
  readonly observedSources: readonly GameObservedSourceArtifact[];
  readonly visualBindings: readonly import("../../visual-world/src/index.js").GamePlanVisualBindings[];
}

export interface GameBuildArtifact {
  readonly kind: "source" | "operation" | "dependency_source";
  readonly hash: string;
  /** Content plus recursively bound dependency inputs; safe for local check reuse. */
  readonly inputHash: string;
  readonly componentId: string;
  readonly operationId?: string;
  readonly fileId?: string;
  readonly dependencyHashes: readonly string[];
  readonly utf8Bytes: number;
}

export interface GameBuildPartition {
  readonly id: string;
  readonly hash: string;
  readonly ordinal: number;
  readonly operationIds: readonly string[];
  readonly expectedBeforeTopologyHash: string;
  readonly expectedAfterTopologyHash: string;
  readonly previousPartitionHash?: string;
  readonly preflight: GameEvidenceTemplate;
  readonly readback: GameEvidenceTemplate;
}

/** No live revision, approval binding or native observation is fabricated here. */
export interface GameEvidenceTemplate {
  readonly kind: "GameEvidenceTemplate";
  readonly purpose: StudioEvidenceProjection["purpose"];
  readonly requirements: StudioEvidenceProjection["requirements"];
  readonly scope: StudioEvidenceProjection["scope"];
  readonly factCount: number;
  readonly canonicalBytes: number;
}

export interface GameBuildGraph {
  readonly kind: "GameBuildGraph";
  readonly id: string;
  readonly hash: string;
  readonly planId: string;
  readonly planHash: string;
  readonly acceptanceHash: string;
  readonly observedRevisionHash: string;
  readonly operations: readonly StudioChangeOperation[];
  readonly sourceWriteBlobs: readonly CreatorSourceWriteBlobBinding[];
  readonly artifacts: readonly GameBuildArtifact[];
  readonly partitions: readonly GameBuildPartition[];
  readonly localChecks: {
    readonly status: "eligible" | "rejected" | "incomplete";
    readonly artifactHashes: readonly string[];
  };
}
