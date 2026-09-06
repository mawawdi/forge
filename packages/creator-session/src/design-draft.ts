import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  DEFAULT_GAME_ADMISSION_POLICY,
  type GameAdmissionPolicy,
  type GameDesignSpec,
} from "../../game-ir/src/index.js";
import {
  assertBoundedGameJson,
  compareGameStrings,
  entityId,
  GAME_ADMISSION_POLICY_SCHEMA,
} from "../../game-ir/src/primitives.js";
import {
  creatorGameComponentSchema,
  creatorGameProposalDesignSchema,
  projectCreatorGameComponentInput,
  resolveCreatorGameComponentInput,
  type CreatorComponentRef,
  type CreatorGameComponentInput,
  type CreatorGameEnvironment,
} from "./game-authoring.js";

type Component = GameDesignSpec["components"][number];
interface Entry {
  ref: CreatorComponentRef;
  component: Component;
}
const READ_SCHEMA = z
  .object({ componentIds: z.array(entityId).min(1).max(16).optional() })
  .strict();

/** Planning declarations only. No candidate source, compiled inventory, approval or editor authority. */
export class CreatorDesignDraft {
  private readonly entries = new Map<string, Entry>();
  private revision = 0;
  private defining = false;
  private readonly defineSchema;
  private readonly policy: GameAdmissionPolicy;
  constructor(
    private readonly environment: CreatorGameEnvironment,
    policy: GameAdmissionPolicy = DEFAULT_GAME_ADMISSION_POLICY,
  ) {
    this.policy = GAME_ADMISSION_POLICY_SCHEMA.parse(policy);
    this.defineSchema = z
      .object({
        component: creatorGameComponentSchema(),
      })
      .strict();
  }

  get hash(): string {
    return contentHash(stableJson(this.refs()));
  }

  /** Complete host checkpoint state, independent of the paged model read interface. */
  snapshot(): { hash: string; refs: CreatorComponentRef[]; components: Component[] } {
    const refs = this.refs();
    return {
      hash: contentHash(stableJson(refs)),
      refs,
      components: refs.map((ref) => structuredClone(this.entries.get(ref.componentId)!.component)),
    };
  }

  /** Stable IDs replace draft declarations; only the host owns the commit version. */
  define(input: unknown): CreatorComponentRef {
    return this.commit(input);
  }

  /** Host-retained repair authority, never a field in the model's definition envelope. */
  defineAt(
    input: unknown,
    expected: { componentId: string; componentHash: string | null },
  ): CreatorComponentRef {
    return this.commit(input, expected);
  }

  private commit(
    input: unknown,
    expected?: { componentId: string; componentHash: string | null },
  ): CreatorComponentRef {
    if (this.defining) throw new Error("Draft component definition cannot be reentered");
    this.defining = true;
    const revision = this.revision;
    try {
      assertBoundedGameJson(input, this.policy);
      const value = this.defineSchema.parse(input);
      const current = this.entries.get(value.component.id);
      if (
        expected !== undefined &&
        (expected.componentId !== value.component.id ||
          expected.componentHash !== (current?.ref.componentHash ?? null))
      )
        throw new Error("Draft repair no longer matches its retained component version");
      const component = resolveCreatorGameComponentInput(value.component, this.policy);
      this.environment.validateComponent(component);
      const next = [...this.entries.values()]
        .filter((entry) => entry.ref.componentId !== component.id)
        .map((entry) => entry.component);
      next.push(component);
      this.assertComponentBudget(next);
      const ref = { componentId: component.id, componentHash: contentHash(stableJson(component)) };
      if (this.revision !== revision || this.entries.get(component.id) !== current)
        throw new Error("Draft changed during component validation; definition was not saved");
      if (current?.ref.componentHash === ref.componentHash) return { ...current.ref };
      if (!Number.isSafeInteger(revision + 1)) throw new Error("Draft revision is exhausted");
      this.entries.set(component.id, { ref, component });
      this.revision += 1;
      return { ...ref };
    } finally {
      this.defining = false;
    }
  }

  /** Omitted IDs returns only the complete bounded ref inventory; bodies are read explicitly. */
  read(input: unknown = {}): {
    refs: CreatorComponentRef[];
    components: CreatorGameComponentInput[];
  } {
    assertBoundedGameJson(input, this.policy);
    const { componentIds = [] } = READ_SCHEMA.parse(input);
    if (new Set(componentIds).size !== componentIds.length)
      throw new Error("Draft read component IDs must be unique");
    const components = [...componentIds].sort(compareGameStrings).map((id) => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error("Unknown draft component: " + id);
      return projectCreatorGameComponentInput(entry.component);
    });
    const result = { refs: this.refs(), components };
    assertBoundedGameJson(result, this.policy);
    return result;
  }

  /** Assemble one exact graph for the existing full admission/compiler/approval path. */
  assemble(input: unknown): GameDesignSpec {
    assertBoundedGameJson(input, this.policy);
    const { componentIds, ...metadata } = creatorGameProposalDesignSchema().parse(input);
    if (new Set(componentIds).size !== componentIds.length)
      throw new Error("Proposal component IDs must be unique");
    // Assembly is synchronous and returns detached bytes. Later draft edits can
    // neither alter this design nor the exact plan compiled from it for review.
    const components = componentIds
      .map((id) => {
        const entry = this.entries.get(id);
        if (!entry) throw new Error("Unknown draft component: " + id);
        return structuredClone(entry.component);
      })
      .sort((a, b) => compareGameStrings(a.id, b.id));
    this.assertComponentBudget(components);
    const design = { ...metadata, components } as GameDesignSpec;
    assertBoundedGameJson(design, this.policy);
    if (
      design.connections.length > this.policy.maximumConnections ||
      design.artifactDependencies.length > this.policy.maximumArtifactDependencies
    )
      throw new Error("Proposal graph exceeds the game admission policy");
    return design;
  }

  private refs(): CreatorComponentRef[] {
    return [...this.entries.values()]
      .map((entry) => ({ ...entry.ref }))
      .sort((a, b) => compareGameStrings(a.componentId, b.componentId));
  }

  private assertComponentBudget(components: Component[]): void {
    assertBoundedGameJson(components, this.policy);
    if (components.length > this.policy.maximumComponents)
      throw new Error("Draft component count exceeds the game admission policy");
    let files = 0;
    let bytes = 0;
    for (const component of components) {
      if (component.kind !== "source_package") continue;
      for (const file of component.files) {
        const declared =
          file.content.kind === "locked" ? file.content.utf8Bytes : file.content.maximumUtf8Bytes;
        files += 1;
        bytes += declared;
        if (
          files > this.policy.maximumFiles ||
          declared > this.policy.maximumFileSourceBytes ||
          !Number.isSafeInteger(bytes) ||
          bytes > this.policy.maximumDeclaredSourceBytes
        )
          throw new Error("Draft source declarations exceed the game admission policy");
      }
    }
  }
}
