import type { CreatorControlDiscovery } from "../../creator-control/src/index.js";
import {
  assertCreatorWorkAdmission,
  type CreatorWorkAdmission,
} from "../../creator-conversation/src/index.js";
import { stableJson } from "../../contracts/src/index.js";

export interface CreatorControlClientOptions {
  readonly fetchImpl?: typeof fetch;
}

/**
 * Submit one foreground creator command. Only the exact asynchronous admission
 * contract proves that the service durably accepted work; a generic successful
 * HTTP status is deliberately insufficient.
 */
export async function submitCreatorControlWork(
  discovery: CreatorControlDiscovery,
  path: "/api/control/turn" | "/api/control/action",
  body: unknown,
  options: CreatorControlClientOptions = {},
): Promise<CreatorWorkAdmission> {
  const response = await (options.fetchImpl ?? fetch)(
    `http://${discovery.host}:${discovery.port}${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${discovery.bearerToken}`,
        "content-type": "application/json",
      },
      body: stableJson(body),
    },
  );
  if (response.status !== 202) {
    const message = await responseMessage(response);
    throw new Error(message ?? `Creator service returned HTTP ${response.status}; expected 202`);
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    throw new Error("Creator service returned an invalid 202 admission body");
  }
  try {
    assertCreatorWorkAdmission(payload);
  } catch {
    throw new Error("Creator service returned an invalid 202 admission contract");
  }
  return payload;
}

async function responseMessage(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as unknown;
    return isRecord(payload) && typeof payload.message === "string" ? payload.message : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
