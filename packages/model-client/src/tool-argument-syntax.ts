import type { ModelToolArgumentSyntaxError } from "./contracts.js";

/** Inspect known raw wire arguments. Never unwrap strings, repair JSON, or infer truncation. */
export function diagnoseToolArgumentJson(raw: string): ModelToolArgumentSyntaxError | null {
  try {
    JSON.parse(raw);
    return null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Parser prose can echo arbitrarily large input. Retain only its numeric offset.
    const match = /\bposition (\d+)\b/.exec(error.message);
    const offset = match ? Number(match[1]) : null;
    const position =
      offset !== null && Number.isSafeInteger(offset) && offset >= 0 && offset <= raw.length
        ? offset
        : null;
    if (position === null)
      return {
        kind: "invalid_json",
        positionUtf16: null,
        line: null,
        column: null,
        vicinity: null,
      };

    let line = 1;
    let lineStart = 0;
    for (let index = 0; index < position; index++) {
      if (raw[index] === "\n") {
        line++;
        lineStart = index + 1;
      }
    }
    // At most 120 UTF-16 units: at most 720 UTF-8 bytes once JSON-escaped,
    // including control characters. Avoid slicing a surrogate pair in half.
    let start = Math.max(0, position - 60);
    let end = Math.min(raw.length, position + 60);
    if (start > 0 && /[\uDC00-\uDFFF]/u.test(raw[start]!)) start++;
    if (end < raw.length && /[\uD800-\uDBFF]/u.test(raw[end - 1]!)) end--;
    return {
      kind: "invalid_json",
      positionUtf16: position,
      line,
      column: position - lineStart + 1,
      vicinity: { startUtf16: start, text: raw.slice(start, end) },
    };
  }
}

export function toolArgumentSyntaxMessage(diagnostic: ModelToolArgumentSyntaxError): string {
  const location =
    diagnostic.positionUtf16 === null
      ? " (the parser did not provide an offset)"
      : ` at zero-based UTF-16 offset ${diagnostic.positionUtf16} (line ${diagnostic.line}, column ${diagnostic.column})`;
  const vicinity = diagnostic.vicinity
    ? ` Nearby raw text starting at UTF-16 offset ${diagnostic.vicinity.startUtf16}: ${JSON.stringify(diagnostic.vicinity.text)}.`
    : "";
  return `Malformed JSON tool arguments${location}.${vicinity} No tool in this batch ran. Correct the JSON syntax and resend arguments matching the tool schema.`;
}
