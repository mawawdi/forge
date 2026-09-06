import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { PinnedLuauAstDocument } from "./toolchain.js";

type Node = Record<string, unknown>;
export interface LuauDeclarationOutline {
  kind: "LuauDeclarationOutline";
  sourceHash: string;
  astHash: string;
  hash: string;
  complete: boolean;
  declarations: Array<{
    kind: "type" | "function" | "return";
    startByte: number;
    endByte: number;
    text: string;
    documentation?: string;
  }>;
  limitations: readonly string[];
}

/** Exact declaration excerpts from pinned parser positions. No module evaluation or inferred exports. */
export function createLuauDeclarationOutline(
  document: PinnedLuauAstDocument,
  source: string,
  maximumBytes = 24 * 1024,
): LuauDeclarationOutline {
  if (
    contentHash(source) !== document.sourceHash ||
    Buffer.byteLength(source) !== document.utf8Bytes
  )
    throw new Error("Declaration outline source does not match the parsed document");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1024 || maximumBytes > 128 * 1024)
    throw new Error("Invalid declaration outline byte bound");
  const envelope = record(document.ast);
  const root = record(envelope?.root);
  if (root?.type !== "AstStatBlock" || !Array.isArray(root.body))
    throw new Error("Declaration outline requires the pinned parser document envelope");
  const bytes = Buffer.from(source);
  const starts = [0];
  for (let index = 0; index < bytes.length; index++)
    if (bytes[index] === 10) starts.push(index + 1);
  const point = (line: number, column: number) => {
    const start = starts[line];
    const end = starts[line + 1] === undefined ? bytes.length : starts[line + 1]! - 1;
    if (start === undefined || column < 0 || start + column > end)
      throw new Error("Parser position is outside its exact source");
    return start + column;
  };
  const range = (location: unknown) => {
    if (typeof location !== "string") throw new Error("Missing parser source location");
    const match = /^(\d+),(\d+) - (\d+),(\d+)$/.exec(location);
    if (!match) throw new Error("Unsupported parser source location");
    const start = point(Number(match[1]), Number(match[2]));
    const end = point(Number(match[3]), Number(match[4]));
    if (end < start) throw new Error("Reversed parser source location");
    return { start, end };
  };
  const excerpt = (start: number, end: number) => {
    const text = bytes.subarray(start, end).toString("utf8");
    if (!Buffer.from(text).equals(bytes.subarray(start, end)))
      throw new Error("Parser source range splits a UTF-8 character");
    return text;
  };
  const comments = Array.isArray(envelope?.commentLocations)
    ? envelope.commentLocations.map((value) => range(record(value)?.location))
    : [];
  const documentation = (start: number) => {
    let cursor = start;
    const retained: string[] = [];
    for (let index = comments.length - 1; index >= 0; index--) {
      const comment = comments[index]!;
      if (comment.end > cursor) continue;
      const gap = excerpt(comment.end, cursor);
      if (!/^\s*$/.test(gap) || (gap.match(/\n/g)?.length ?? 0) > 1) break;
      const lineStart = bytes.lastIndexOf(10, comment.start - 1) + 1;
      if (!/^\s*$/.test(excerpt(lineStart, comment.start))) break;
      retained.unshift(excerpt(comment.start, comment.end));
      cursor = comment.start;
    }
    return retained.length === 0 ? undefined : retained.join("\n");
  };
  const declarations: LuauDeclarationOutline["declarations"] = [];
  let complete = true;
  let retainedBytes = 0;
  for (const value of root.body) {
    const node = record(value);
    if (!node) throw new Error("Invalid top-level parser node");
    const kind =
      node.type === "AstStatTypeAlias"
        ? "type"
        : node.type === "AstStatFunction"
          ? "function"
          : node.type === "AstStatReturn"
            ? "return"
            : undefined;
    if (!kind) continue;
    // Returning an anonymous function would inline its implementation into this API brief.
    if (kind === "return" && containsFunction(node)) continue;
    const location = range(node.location);
    const end =
      kind === "function" ? range(record(record(node.func)?.body)?.location).start : location.end;
    if (end < location.start || end > location.end)
      throw new Error("Function signature is outside its declaration");
    const docs = documentation(location.start);
    const declaration: LuauDeclarationOutline["declarations"][number] = {
      kind,
      startByte: location.start,
      endByte: end,
      text: excerpt(location.start, end),
      ...(docs ? { documentation: docs } : {}),
    };
    const size = Buffer.byteLength(stableJson(declaration));
    if (retainedBytes + size > maximumBytes || declarations.length >= 128) {
      complete = false;
      break;
    }
    declarations.push(declaration);
    retainedBytes += size;
  }
  const payload = {
    kind: "LuauDeclarationOutline" as const,
    sourceHash: document.sourceHash,
    astHash: contentHash(stableJson(document.ast)),
    complete,
    declarations,
    limitations: [
      "Exact top-level type aliases, member-function signatures and return statements only. These excerpts do not infer exports or evaluate code.",
      "Function bodies, return expressions containing functions, local functions, assignments and nested declarations are omitted. Read the hash-bound module source for behavior or any API not established here.",
      "Types and source comments are author declarations, not runtime validation or native evidence.",
    ],
  };
  return { ...payload, hash: contentHash(stableJson(payload)) };
}

function record(value: unknown): Node | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Node)
    : undefined;
}

function containsFunction(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsFunction);
  const node = record(value);
  return (
    node !== undefined &&
    (node.type === "AstExprFunction" || Object.values(node).some(containsFunction))
  );
}
