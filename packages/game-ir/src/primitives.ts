import { z } from "zod";
import { types } from "node:util";

export const entityId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export function compareGameStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export type GameJsonValue =
  null | boolean | number | string | GameJsonValue[] | { [key: string]: GameJsonValue };

/** Admission resources, not restrictions on the semantics of an experience. */
export const GAME_ADMISSION_POLICY_SCHEMA = z
  .object({
    maximumJsonBytes: z.number().int().positive().safe(),
    maximumJsonDepth: z.number().int().positive().max(64),
    maximumJsonNodes: z.number().int().positive().safe(),
    maximumStringUtf8Bytes: z.number().int().positive().safe(),
    maximumComponents: z.number().int().positive().safe(),
    maximumFiles: z.number().int().positive().safe(),
    maximumDeclaredSourceBytes: z.number().int().positive().safe(),
    maximumFileSourceBytes: z.number().int().positive().safe(),
    maximumConnections: z.number().int().positive().safe(),
    maximumArtifactDependencies: z.number().int().positive().safe(),
    maximumDefinitions: z.number().int().positive().safe(),
  })
  .strict();
export type GameAdmissionPolicy = z.infer<typeof GAME_ADMISSION_POLICY_SCHEMA>;
export const DEFAULT_GAME_ADMISSION_POLICY: Readonly<GameAdmissionPolicy> = Object.freeze({
  maximumJsonBytes: 1024 * 1024,
  maximumJsonDepth: 32,
  maximumJsonNodes: 50_000,
  maximumStringUtf8Bytes: 64 * 1024,
  maximumComponents: 256,
  maximumFiles: 4096,
  maximumDeclaredSourceBytes: 32 * 1024 * 1024,
  maximumFileSourceBytes: 512 * 1024,
  maximumConnections: 4096,
  maximumArtifactDependencies: 4096,
  maximumDefinitions: 128,
});

export class GameAdmissionError extends Error {
  constructor(
    readonly code: string,
    readonly subject: string,
    detail: string,
  ) {
    super(detail);
  }
}

/** Validate descriptors and budgets before recursive schema parsing or hashing. */
export function assertBoundedGameJson(
  value: unknown,
  policy: GameAdmissionPolicy,
): asserts value is GameJsonValue {
  const active = new Set<object>();
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  const invalid = (detail: string): never => {
    throw new GameAdmissionError("invalid_json", "$", detail);
  };
  const addBytes = (count: number): void => {
    bytes += count;
    if (bytes > policy.maximumJsonBytes)
      throw new GameAdmissionError("resource_limit", "$", "Canonical JSON byte budget exceeded");
  };
  const stringBytes = (text: string): void => {
    if (Buffer.byteLength(text, "utf8") > policy.maximumStringUtf8Bytes)
      throw new GameAdmissionError("resource_limit", "$", "JSON string byte budget exceeded");
    for (let index = 0; index < text.length; index++) {
      const unit = text.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) invalid("JSON strings must contain valid Unicode");
      } else if (unit >= 0xdc00 && unit <= 0xdfff)
        invalid("JSON strings must contain valid Unicode");
    }
    addBytes(Buffer.byteLength(JSON.stringify(text), "utf8"));
  };
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.exit) {
      active.delete(item.value as object);
      continue;
    }
    if (++nodes > policy.maximumJsonNodes || item.depth > policy.maximumJsonDepth)
      throw new GameAdmissionError("resource_limit", "$", "JSON node or depth budget exceeded");
    const current = item.value;
    if (current === null) {
      addBytes(4);
      continue;
    }
    if (typeof current === "string") {
      stringBytes(current);
      continue;
    }
    if (typeof current === "boolean") {
      addBytes(current ? 4 : 5);
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0))
        invalid("JSON numbers must be finite and canonical");
      addBytes(JSON.stringify(current).length);
      continue;
    }
    if (typeof current !== "object") invalid("Only plain JSON data is admissible");
    const object = current as object;
    if (types.isProxy(object)) invalid("Proxies are not plain JSON data");
    if (active.has(object)) invalid("JSON cycles are forbidden");
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object) as unknown;
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      invalid("Only regular JSON objects and arrays are admissible");
    const descriptors = Object.getOwnPropertyDescriptors(object);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) invalid("Symbol properties are forbidden");
    const entries = Object.entries(descriptors).filter(([key]) => !array || key !== "length");
    if (
      entries.length > policy.maximumJsonNodes - nodes ||
      stack.length + entries.length > policy.maximumJsonNodes
    )
      throw new GameAdmissionError("resource_limit", "$", "JSON node budget exceeded");
    if (array) {
      const length = descriptors.length?.value as unknown;
      if (
        typeof length !== "number" ||
        length !== entries.length ||
        entries.some(([key], index) => key !== String(index))
      )
        invalid("Arrays must be dense and have no extra properties");
    }
    active.add(object);
    stack.push({ value: object, depth: item.depth, exit: true });
    addBytes(2 + Math.max(0, entries.length - 1));
    for (const [key, descriptor] of entries) {
      if (!descriptor.enumerable || !("value" in descriptor))
        invalid("Accessors and non-enumerable properties are forbidden");
      // Zod record parsing drops this key; reject rather than silently reseal different data.
      if (key === "__proto__") invalid("The __proto__ key cannot be preserved by schema admission");
      if (!array) {
        stringBytes(key);
        addBytes(1);
      }
      stack.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
}
