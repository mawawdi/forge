import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { DEFAULT_GAME_ADMISSION_POLICY } from "../../game-ir/src/index.js";
import { assertBoundedGameJson, entityId } from "../../game-ir/src/primitives.js";

const MAXIMUM_REPAIR_BYTES = 32 * 1024;
const MAXIMUM_ATTEMPT_READ_BYTES = 16 * 1024;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const segment = z.union([
  z
    .string()
    .min(1)
    .max(128)
    .refine((value) => !forbiddenKeys.has(value), "Unsafe repair path"),
  z.number().int().min(0).max(65535),
]);
const attemptIdSchema = z.string().regex(/^creator_component_attempt_[a-f0-9]{64}$/);
const syntaxAttemptIdSchema = z.string().regex(/^creator_component_syntax_[a-f0-9]{64}$/);
const pathSchema = z.array(segment).min(2).max(32);
export const CREATOR_COMPONENT_READ_SHAPE = {
  componentIds: z.array(z.string().min(1)).min(1).max(16).optional(),
  attemptId: attemptIdSchema.optional(),
  path: z.array(segment).min(1).max(32).optional(),
  syntaxAttemptId: syntaxAttemptIdSchema.optional(),
  offset: z.number().int().nonnegative().optional(),
};
export type CreatorComponentReadInput = z.infer<z.ZodObject<typeof CREATOR_COMPONENT_READ_SHAPE>>;
function creatorComponentRepairShape(value: z.ZodType) {
  return {
    attemptId: attemptIdSchema,
    edits: z
      .array(
        z.discriminatedUnion("op", [
          z.object({ op: z.literal("replace"), path: pathSchema, value }).strict(),
          z.object({ op: z.literal("remove"), path: pathSchema }).strict(),
          z.object({ op: z.literal("add"), path: pathSchema, value }).strict(),
        ]),
      )
      .min(1)
      .max(64),
  };
}

export const CREATOR_COMPONENT_REPAIR_SHAPE = creatorComponentRepairShape(z.json());
export const CREATOR_COMPONENT_REPAIR_ENVELOPE_SHAPE = creatorComponentRepairShape(
  z.unknown().describe("Required replacement or addition value; must be valid JSON."),
);
const repairSchema = z.object(CREATOR_COMPONENT_REPAIR_SHAPE).strict();
export type CreatorComponentRepairInput = z.infer<typeof repairSchema>;
export interface CreatorComponentBinding {
  componentId: string;
  componentHash: string | null;
}
export interface CreatorComponentRepairScope {
  sessionId: string;
  projectCaptureHash: string;
  capabilitiesHash: string;
}
export interface CreatorComponentAttempt {
  kind: "CreatorComponentAttempt";
  id: string;
  hash: string;
  authority: "untrusted_model_attempt";
  scope: CreatorComponentRepairScope;
  binding: CreatorComponentBinding;
  input: unknown;
  inputHash: string;
  diagnostic: { code: string; message: string };
  provenance?: CreatorComponentRepairInput;
}

/** Untrusted draft material only. Successful refs still come exclusively from CreatorDesignDraft. */
export class CreatorComponentRepairStore {
  private readonly attempts = new Map<string, { record: CreatorComponentAttempt; bytes: number }>();
  private readonly syntaxAttempts = new Map<
    string,
    {
      input: string;
      inputHash: string;
      bytes: number;
      diagnostic: CreatorComponentAttempt["diagnostic"];
    }
  >();
  private bytes = 0;
  private readonly scope: CreatorComponentRepairScope;
  constructor(scope: CreatorComponentRepairScope) {
    if (
      !scope.sessionId.trim() ||
      !/^[a-f0-9]{64}$/.test(scope.projectCaptureHash) ||
      !/^[a-f0-9]{64}$/.test(scope.capabilitiesHash)
    )
      throw new Error("Invalid component repair scope");
    this.scope = structuredClone(scope);
  }

  retain(
    input: unknown,
    diagnostic: CreatorComponentAttempt["diagnostic"],
    binding: CreatorComponentBinding,
    provenance?: CreatorComponentRepairInput,
  ): Pick<CreatorComponentAttempt, "id" | "hash" | "binding"> | undefined {
    assertBoundedGameJson(input, DEFAULT_GAME_ADMISSION_POLICY);
    if (!isRecord(input) || !isRecord(input.component)) return undefined;
    const id = entityId.safeParse(input.component.id);
    if (!id.success || id.data !== binding.componentId) return undefined;
    if (binding.componentHash !== null && !/^[a-f0-9]{64}$/.test(binding.componentHash))
      throw new Error("Invalid retained component binding");
    if (provenance) {
      const derived = this.prepare(provenance);
      if (
        stableJson(derived.input) !== stableJson(input) ||
        stableJson(derived.expected) !== stableJson(binding)
      )
        throw new Error(
          "Repair provenance does not reproduce the exact retained input and binding",
        );
    }
    const payload = {
      authority: "untrusted_model_attempt" as const,
      scope: this.scope,
      binding,
      input,
      inputHash: contentHash(stableJson(input)),
      diagnostic,
      ...(provenance ? { provenance } : {}),
    };
    assertBoundedGameJson(payload as unknown, DEFAULT_GAME_ADMISSION_POLICY);
    const hash = contentHash(stableJson(payload));
    const record: CreatorComponentAttempt = structuredClone({
      kind: "CreatorComponentAttempt",
      id: `creator_component_attempt_${hash}`,
      hash,
      ...payload,
    });
    const bytes = Buffer.byteLength(stableJson(record), "utf8");
    if (!this.attempts.has(record.id)) {
      if (this.bytes + bytes > DEFAULT_GAME_ADMISSION_POLICY.maximumJsonBytes) return undefined;
      this.attempts.set(record.id, { record, bytes });
      this.bytes += bytes;
    }
    return { id: record.id, hash, binding: { ...binding } };
  }

  prepare(input: unknown): {
    input: unknown;
    expected: CreatorComponentBinding;
    provenance: CreatorComponentRepairInput;
  } {
    assertBoundedGameJson(input, DEFAULT_GAME_ADMISSION_POLICY);
    if (Buffer.byteLength(stableJson(input), "utf8") > MAXIMUM_REPAIR_BYTES)
      throw new Error("Component repair exceeds 32 KiB; redefine a larger structural change");
    const request = repairSchema.parse(input);
    const base = this.attempts.get(request.attemptId)?.record;
    if (!base)
      throw new Error(
        "Component repair attempt is absent or superseded; define the component again",
      );
    const paths = request.edits.map((edit) => edit.path);
    for (let index = 0; index < paths.length; index++) {
      const path = paths[index]!;
      if (path[0] !== "component" || ["id", "kind", "definition"].includes(String(path[1])))
        throw new Error("Repair cannot change component identity; redefine the component");
      if (paths.slice(0, index).some((other) => isPrefix(other, path) || isPrefix(path, other)))
        throw new Error("Component repair paths must be distinct and non-overlapping");
    }
    const candidate = structuredClone(base.input);
    // Paths always address the original attempt. Replace first, then remove array
    // entries in descending index order so an earlier removal cannot shift a later target.
    const targets = paths.map((path, index) =>
      existingTarget(candidate, path, request.edits[index]!.op === "add"),
    );
    targets.forEach((target, index) => {
      const edit = request.edits[index]!;
      if (edit.op === "remove") return;
      const value = structuredClone(edit.value);
      if (Array.isArray(target.parent)) target.parent[target.key as number] = value;
      else target.parent[target.key as string] = value;
    });
    const removals = targets.filter((_target, index) => request.edits[index]!.op === "remove");
    const groups = new Map<object, typeof removals>();
    for (const target of removals)
      groups.set(target.parent, [...(groups.get(target.parent) ?? []), target]);
    for (const group of groups.values()) {
      if (Array.isArray(group[0]!.parent))
        group.sort((left, right) => Number(right.key) - Number(left.key));
      for (const target of group) {
        if (Array.isArray(target.parent)) target.parent.splice(target.key as number, 1);
        else delete target.parent[target.key as string];
      }
    }
    assertBoundedGameJson(candidate, DEFAULT_GAME_ADMISSION_POLICY);
    return {
      input: candidate,
      expected: { ...base.binding },
      provenance: structuredClone(request),
    };
  }

  clear(componentId: string): void {
    for (const [id, attempt] of this.attempts) {
      if (attempt.record.binding.componentId !== componentId) continue;
      this.attempts.delete(id);
      this.bytes -= attempt.bytes;
    }
  }

  bindingFor(attemptId: unknown): CreatorComponentBinding | undefined {
    const record = typeof attemptId === "string" ? this.attempts.get(attemptId)?.record : undefined;
    return record ? { ...record.binding } : undefined;
  }

  latestFor(componentId: string): string | undefined {
    let latest: string | undefined;
    for (const [id, { record }] of this.attempts)
      if (record.binding.componentId === componentId) latest = id;
    return latest;
  }

  /** Malformed arguments have no inferred component identity and cannot be repaired as JSON. */
  retainSyntax(input: string, diagnostic: CreatorComponentAttempt["diagnostic"]) {
    const bytes = Buffer.byteLength(input, "utf8");
    if (Buffer.from(input, "utf8").toString("utf8") !== input)
      throw new Error("Syntax attempt contains invalid Unicode text");
    const inputHash = contentHash(input);
    const id = `creator_component_syntax_${contentHash(stableJson({ scope: this.scope, inputHash, diagnostic }))}`;
    if (!this.syntaxAttempts.has(id)) {
      if (this.bytes + bytes > DEFAULT_GAME_ADMISSION_POLICY.maximumJsonBytes) return undefined;
      this.syntaxAttempts.set(id, {
        input,
        inputHash,
        bytes,
        diagnostic: structuredClone(diagnostic),
      });
      this.bytes += bytes;
    }
    return { id, inputHash, bytes };
  }

  readSyntax(syntaxAttemptId: unknown, requestedOffset: unknown = 0) {
    const id = syntaxAttemptIdSchema.parse(syntaxAttemptId);
    const offset = z.number().int().nonnegative().parse(requestedOffset);
    const record = this.syntaxAttempts.get(id);
    if (!record)
      throw new Error(
        "Syntax attempt is absent; use the exact retained syntaxAttemptId from its checkpoint",
      );
    const bytes = Buffer.from(record.input, "utf8");
    if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80))
      throw new Error(
        "Syntax read offset must be a UTF-8 boundary; copy nextOffset from the previous read",
      );
    let end = Math.min(offset + MAXIMUM_ATTEMPT_READ_BYTES, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    return {
      kind: "CreatorComponentSyntaxAttemptRead" as const,
      authority: "untrusted_model_attempt" as const,
      syntaxAttemptId: id,
      inputHash: record.inputHash,
      diagnostic: structuredClone(record.diagnostic),
      totalBytes: record.bytes,
      offset,
      text: bytes.subarray(offset, end).toString("utf8"),
      nextOffset: end < bytes.length ? end : null,
    };
  }

  /** Untrusted failed input is never returned as a saved component or approved reference. */
  read(attemptId: unknown, requestedPath: unknown = ["component"]) {
    const id = attemptIdSchema.parse(attemptId);
    const path = z.array(segment).min(1).max(32).parse(requestedPath);
    if (path[0] !== "component") throw new Error("Attempt reads must start with component");
    const record = this.attempts.get(id)?.record;
    if (!record)
      throw new Error(
        "Component repair attempt is absent or superseded; read saved components or define it again",
      );
    const selected = readAttemptValue(record.input, path);
    if (!selected.present)
      throw new Error("Attempt read path is absent; inspect its existing parent");
    return {
      kind: "CreatorComponentAttemptRead" as const,
      authority: "untrusted_model_attempt" as const,
      attemptId: record.id,
      inputHash: record.inputHash,
      componentId: record.binding.componentId,
      diagnostic: structuredClone(record.diagnostic),
      selected: { path, ...boundedAttemptValue(selected.value, MAXIMUM_ATTEMPT_READ_BYTES) },
    };
  }

  inputFor(attemptId: string): unknown {
    const record = this.attempts.get(attemptId)?.record;
    if (!record) throw new Error("Component repair attempt is absent or superseded");
    return structuredClone(record.input);
  }

  /** Exact provenance for offline verification, never accepted design components. */
  snapshot(): CreatorComponentAttempt[] {
    return [...this.attempts.values()].map(({ record }) => structuredClone(record));
  }
}

export function readAttemptValue(
  input: unknown,
  path: readonly PropertyKey[],
): { present: false } | { present: true; value: unknown } {
  let value = input;
  for (const key of path) {
    if (Array.isArray(value) && typeof key !== "number") return { present: false };
    if (
      typeof key === "symbol" ||
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    )
      return { present: false };
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return { present: true, value };
}

export function boundedAttemptValue(value: unknown, maximumBytes = 512) {
  const bytes = Buffer.byteLength(stableJson(value), "utf8");
  if (bytes <= maximumBytes) return { status: "present" as const, value: structuredClone(value) };
  return {
    status: "not_loaded" as const,
    bytes,
    valueType: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    ...(Array.isArray(value)
      ? { length: value.length }
      : isRecord(value)
        ? { keys: Object.keys(value).sort().slice(0, 64), keyCount: Object.keys(value).length }
        : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isPrefix(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): boolean {
  return left.length <= right.length && left.every((value, index) => value === right[index]);
}
function existingTarget(
  value: unknown,
  path: readonly (string | number)[],
  add = false,
): {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
} {
  let parent = value;
  for (let index = 0; index < path.length; index++) {
    const key = path[index]!;
    if (add && index === path.length - 1) {
      if (!isRecord(parent) || typeof key !== "string" || Object.hasOwn(parent, key))
        throw new Error(
          "Repair add requires an absent named property of an existing object; array insertion is unavailable",
        );
      return { parent, key };
    }
    if (Array.isArray(parent)) {
      if (typeof key !== "number" || !Object.hasOwn(parent, key))
        throw new Error("Repair array index must already exist");
    } else if (!isRecord(parent) || typeof key !== "string" || !Object.hasOwn(parent, key)) {
      throw new Error(
        "Repair property must already exist; use a complete definition for structural changes",
      );
    }
    if (index === path.length - 1) return { parent, key };
    parent = Array.isArray(parent) ? parent[key as number] : parent[key as string];
  }
  throw new Error("Repair path is empty");
}
