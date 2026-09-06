const MAX_DIAGNOSTIC_SCAN_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 500;

const ERROR_CODES = new Set([
  "invalid_request_error",
  "invalid_request",
  "invalid_argument",
  "invalid_json_schema",
  "invalid_function_parameters",
  "unsupported_parameter",
  "unsupported_value",
  "context_length_exceeded",
  "max_tokens_exceeded",
  "rate_limit_exceeded",
  "insufficient_quota",
  "insufficient_credits",
  "authentication_error",
  "invalid_api_key",
  "permission_denied",
  "model_not_found",
  "not_found_error",
  "overloaded_error",
  "server_error",
]);
const PARAMETERS = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "reasoning",
  "reasoning_content",
  "reasoning_details",
  "tool_call_id",
  "response_format",
  "model",
  "provider",
] as const;
const SCHEMA_KEYWORDS = [
  "additionalProperties",
  "required",
  "anyOf",
  "oneOf",
  "$ref",
  "pattern",
  "minItems",
  "maxItems",
  "enum",
  "const",
] as const;
const REASONS: readonly [RegExp, string][] = [
  [
    /invalid (?:json |tool |function |input )?schema|schema[^\n]{0,80}(?:invalid|unsupported)/i,
    "invalid or unsupported schema",
  ],
  [
    /(?:context.{0,30}(?:length|limit)|maximum.{0,20}(?:context|tokens)|too many tokens)/i,
    "context or token limit",
  ],
  [
    /(?:unsupported|unknown|unrecognized|not supported).{0,40}(?:parameter|argument|field)/i,
    "unsupported parameter",
  ],
  [/(?:tool|function).{0,30}(?:not supported|unsupported)/i, "unsupported tool calling"],
  [
    /(?:model|endpoint).{0,40}(?:not found|unavailable|no longer available)|no endpoints found/i,
    "model or endpoint unavailable",
  ],
  [/(?:rate limit|too many requests)/i, "rate limit"],
  [/(?:insufficient (?:credits|quota)|credit balance)/i, "insufficient credits or quota"],
  [
    /(?:reasoning_content|reasoning_details|reasoning content).{0,80}(?:missing|required|invalid|must)|(?:missing|required|invalid).{0,80}(?:reasoning_content|reasoning_details|reasoning content)/i,
    "reasoning continuation requirement",
  ],
  [
    /(?:tool_call_id|tool call.{0,20}(?:id|identifier)).{0,80}(?:invalid|missing|unknown|duplicate|match)|(?:invalid|missing|unknown|duplicate).{0,80}(?:tool_call_id|tool call.{0,20}(?:id|identifier))/i,
    "tool call identifier mismatch",
  ],
  [
    /(?:tool (?:message|result|response)|messages? with role.{0,10}tool).{0,100}(?:follow|preced|correspond|match)|(?:assistant|user|tool).{0,30}messages?.{0,60}(?:alternate|sequence|order)/i,
    "message sequence requirement",
  ],
  [
    /(?:request|payload|body).{0,40}(?:too large|size limit|exceeds.{0,10}limit)/i,
    "request size limit",
  ],
  [
    /(?:invalid|malformed).{0,30}json|json.{0,30}(?:parse|syntax).{0,30}error/i,
    "invalid request JSON",
  ],
];

/**
 * Preserve bounded diagnostic categories, never provider prose. Error text can
 * echo API keys, prompts, source, headers, or request bodies, so regex redaction
 * followed by copying that text would not establish a safe output boundary.
 * These are provider-reported hints, not host verification of the failure cause.
 */
export function safeProviderErrorMessage(
  base: string,
  error: { message: string; data?: unknown; responseBody?: string },
): string {
  const facts = new Set<string>();
  const messages = [error.message.slice(0, 2048)];
  const queue: { value: unknown; depth: number }[] = [{ value: error.data, depth: 0 }];
  // Some provider adapters validate away error metadata. Inspect the bounded raw
  // error envelope too, but emit only the same fixed diagnostic vocabulary.
  if (
    typeof error.responseBody === "string" &&
    error.responseBody.length <= MAX_DIAGNOSTIC_SCAN_BYTES &&
    Buffer.byteLength(error.responseBody, "utf8") <= MAX_DIAGNOSTIC_SCAN_BYTES
  ) {
    try {
      queue.push({ value: JSON.parse(error.responseBody), depth: 0 });
    } catch {
      messages.push(error.responseBody.slice(0, 2048));
    }
  }
  for (let index = 0; index < queue.length && index < 8; index++) {
    const entry = queue[index]!;
    if (!isRecord(entry.value) || entry.depth > 3) continue;
    const record = entry.value;
    for (const code of [record.code, record.type]) {
      if (typeof code === "string" && ERROR_CODES.has(code)) facts.add(`code=${code}`);
      else if (
        (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) ||
        (typeof code === "string" && /^[1-5][0-9]{2}$/.test(code))
      )
        facts.add(`code=${code}`);
    }
    if (typeof record.message === "string") messages.push(record.message.slice(0, 2048));
    if (typeof record.param === "string") {
      const parameter = PARAMETERS.find(
        (name) =>
          record.param === name ||
          (record.param as string).startsWith(`${name}[`) ||
          (record.param as string).startsWith(`${name}.`),
      );
      if (parameter) facts.add(`parameter=${parameter}`);
    }
    if (record.error !== undefined) queue.push({ value: record.error, depth: entry.depth + 1 });
    if (isRecord(record.metadata)) {
      let raw: unknown = record.metadata.raw;
      if (typeof raw === "string") {
        const rawText = raw;
        if (
          raw.length > MAX_DIAGNOSTIC_SCAN_BYTES ||
          Buffer.byteLength(raw, "utf8") > MAX_DIAGNOSTIC_SCAN_BYTES
        )
          continue;
        try {
          raw = JSON.parse(raw) as unknown;
        } catch {
          messages.push(rawText.slice(0, 2048));
          continue;
        }
      }
      queue.push({ value: raw, depth: entry.depth + 1 });
    }
  }
  const text = messages.join("\n").slice(0, MAX_DIAGNOSTIC_SCAN_BYTES);
  for (const [pattern, label] of REASONS) if (pattern.test(text)) facts.add(`mentions ${label}`);
  if (facts.has("mentions invalid or unsupported schema")) {
    for (const keyword of SCHEMA_KEYWORDS)
      if (text.includes(keyword)) facts.add(`keyword=${keyword}`);
  }
  // Every emitted diagnostic character comes from a fixed vocabulary or an
  // HTTP-range numeric code. The existing journal retains this exact message.
  const suffix = [...facts].slice(0, 8).join("; ");
  return `${base}${suffix ? ` Provider diagnostic: ${suffix}.` : ""}`.slice(
    0,
    MAX_DIAGNOSTIC_MESSAGE_BYTES,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
