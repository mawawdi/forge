import {
  ImmutableJsonArtifactStore,
  assertArtifactReference,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { DEFAULT_GAME_ADMISSION_POLICY } from "../../game-ir/src/index.js";
import { assertBoundedGameJson } from "../../game-ir/src/primitives.js";
import {
  blenderSceneSpecHandle,
  validateBlenderSceneSpec,
  type BlenderSceneHandle,
  type BlenderSceneSpec,
} from "../../visual-world/src/index.js";
import {
  assertApprovedSceneCompilationAuthorities,
  type ApprovedSceneCompilationAuthorities,
} from "./index.js";

export interface DurableApprovedSceneAuthorityRecord {
  readonly kind: "DurableApprovedSceneAuthorityRecord";
  readonly id: string;
  readonly hash: string;
  readonly scene: BlenderSceneHandle;
  readonly spec: BlenderSceneSpec;
  readonly authority: ApprovedSceneCompilationAuthorities;
  readonly retainedAt: string;
}

export interface DurableApprovedSceneAuthorityBinding {
  readonly scene: BlenderSceneHandle;
  readonly recordId: string;
  readonly recordHash: string;
  readonly artifact: ArtifactReference;
}

export interface ApprovedSceneAuthorityResolver {
  resolve(
    scene: BlenderSceneHandle,
  ):
    | { readonly scene: BlenderSceneSpec; readonly authority: ApprovedSceneCompilationAuthorities }
    | undefined;
}

/** Reconstructs exact approved scene authority from immutable retained records. */
export class DurableApprovedSceneAuthorityStore {
  constructor(private readonly artifacts: ImmutableJsonArtifactStore) {}

  async retain(input: {
    scene: BlenderSceneSpec;
    authority: ApprovedSceneCompilationAuthorities;
    retainedAt: string;
  }): Promise<DurableApprovedSceneAuthorityBinding> {
    const spec = validateBlenderSceneSpec(input.scene);
    assertApprovedSceneCompilationAuthorities(spec, input.authority);
    if (Number.isNaN(Date.parse(input.retainedAt)))
      throw new Error("Authority retention time is invalid");
    const scene = blenderSceneSpecHandle(spec);
    const material = {
      kind: "DurableApprovedSceneAuthorityRecord" as const,
      scene,
      spec,
      authority: structuredClone(input.authority),
      retainedAt: input.retainedAt,
    };
    const boundedMaterial: unknown = material;
    assertBoundedGameJson(boundedMaterial, DEFAULT_GAME_ADMISSION_POLICY);
    const hash = contentHash(stableJson(material));
    const record: DurableApprovedSceneAuthorityRecord = {
      ...material,
      id: `approved_scene_authority_${hash.slice(0, 24)}`,
      hash,
    };
    return {
      scene,
      recordId: record.id,
      recordHash: record.hash,
      artifact: await this.artifacts.write(record),
    };
  }

  async loadResolver(
    bindings: readonly DurableApprovedSceneAuthorityBinding[],
  ): Promise<ApprovedSceneAuthorityResolver> {
    const records = new Map<
      string,
      { readonly scene: BlenderSceneSpec; readonly authority: ApprovedSceneCompilationAuthorities }
    >();
    for (const binding of bindings) {
      assertBoundedGameJson(binding, DEFAULT_GAME_ADMISSION_POLICY);
      assertArtifactReference(binding.artifact);
      const value = await this.artifacts.read<DurableApprovedSceneAuthorityRecord>(
        binding.artifact,
        assertDurableApprovedSceneAuthorityRecord,
      );
      if (
        value.id !== binding.recordId ||
        value.hash !== binding.recordHash ||
        stableJson(value.scene) !== stableJson(binding.scene)
      )
        throw new Error("Durable scene authority binding identity mismatch");
      const key = stableJson(value.scene);
      if (records.has(key)) throw new Error("Durable scene authority is ambiguous");
      records.set(key, { scene: value.spec, authority: value.authority });
    }
    return Object.freeze({
      resolve(scene: BlenderSceneHandle) {
        const found = records.get(stableJson(scene));
        return found
          ? { scene: structuredClone(found.scene), authority: structuredClone(found.authority) }
          : undefined;
      },
    });
  }
}

function assertDurableApprovedSceneAuthorityRecord(
  value: unknown,
): asserts value is DurableApprovedSceneAuthorityRecord {
  assertBoundedGameJson(value, DEFAULT_GAME_ADMISSION_POLICY);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Durable scene authority record is malformed");
  const record = value as unknown as DurableApprovedSceneAuthorityRecord;
  if (
    record.kind !== "DurableApprovedSceneAuthorityRecord" ||
    typeof record.id !== "string" ||
    typeof record.hash !== "string" ||
    !Number.isFinite(Date.parse(record.retainedAt))
  )
    throw new Error("Durable scene authority record is malformed");
  const spec = validateBlenderSceneSpec(record.spec);
  if (stableJson(record.scene) !== stableJson(blenderSceneSpecHandle(spec)))
    throw new Error("Durable scene authority record has a stale scene handle");
  assertApprovedSceneCompilationAuthorities(spec, record.authority);
  const { id, hash, ...material } = record;
  const expectedHash = contentHash(stableJson(material));
  if (hash !== expectedHash || id !== `approved_scene_authority_${expectedHash.slice(0, 24)}`)
    throw new Error("Durable scene authority record identity mismatch");
}
