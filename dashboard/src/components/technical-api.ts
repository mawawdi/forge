/**
 * Read-only technical endpoints deliberately remain outside dashboard state.
 * They are paged, user-initiated evidence inspection—not an alternate control
 * plane or a source of workflow authority.
 */
export async function getTechnicalJson(
  path: string,
  parameters: Readonly<Record<string, string | number | undefined>> = {},
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return requestJson(`${path}${query.size ? `?${query}` : ""}`);
}

export async function postTechnicalJson(path: string): Promise<Record<string, unknown>> {
  return requestJson(path, { method: "POST" });
}

async function requestJson(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...init.headers },
  });
  const body = await response.text();
  const parsed = parseJson(body);
  if (!response.ok) throw new Error(errorDetail(parsed, response.status));
  if (!isRecord(parsed)) throw new Error("Forge returned malformed technical evidence.");
  return parsed;
}

function parseJson(body: string): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function errorDetail(value: unknown, status: number): string {
  if (isRecord(value)) {
    if (typeof value.detail === "string") return value.detail;
    if (typeof value.message === "string") return value.message;
  }
  return `Technical evidence request failed (${status}).`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
