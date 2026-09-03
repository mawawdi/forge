import { AGENT_ACTIVITY_DETAIL_MAX_BYTES } from "../../creator-conversation/src/contracts.js";

/** Short display text only; the journal retains the complete tool input/error. */
export function activityDetail(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= AGENT_ACTIVITY_DETAIL_MAX_BYTES) return text;
  const suffix = "…";
  const limit = AGENT_ACTIVITY_DETAIL_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
  let bytes = 0;
  let result = "";
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit) break;
    result += character;
    bytes += size;
  }
  return result + suffix;
}

export function failedActivityDetail(message: string | undefined): string {
  let text = message ?? "This step couldn't finish.";
  // Some tool failures contain structured diagnostics. Show their explanation;
  // object IDs, inspected paths, and the full payload belong in run details.
  try {
    const detail: unknown = JSON.parse(text);
    if (
      typeof detail === "object" &&
      detail !== null &&
      "message" in detail &&
      typeof detail.message === "string"
    )
      text = detail.message;
  } catch {
    // Plain-text tool errors already contain the explanation.
  }
  return activityDetail(text);
}
