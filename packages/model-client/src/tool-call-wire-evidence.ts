import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { ModelToolCallWireEvidence } from "./contracts.js";

const MAX_DETAIL_CALLS = 128;
const MAX_IDENTIFIER_LENGTH = 256;
const SHA256 = /^[a-f0-9]{64}$/;

/** Only tool-call fields are hashed; response prose, reasoning and headers are excluded. */
export function captureToolCallWireEvidence(
  calls: readonly { id?: unknown; name?: unknown; arguments?: unknown }[],
  adaptedInputs?: readonly unknown[],
): ModelToolCallWireEvidence {
  const envelope = calls.map((call) => ({
    id: call.id ?? null,
    name: call.name ?? null,
    hasArguments: call.arguments !== undefined,
    arguments: call.arguments ?? null,
  }));
  return {
    kind: "ModelToolCallWireEvidence",
    envelopeHash: contentHash(stableJson(envelope)),
    totalCalls: calls.length,
    omittedCalls: Math.max(0, calls.length - MAX_DETAIL_CALLS),
    calls: calls.slice(0, MAX_DETAIL_CALLS).map((call, index) => {
      const raw = typeof call.arguments === "string" ? call.arguments : undefined;
      let jsonValidity: "valid" | "invalid" | "unavailable" = "unavailable";
      if (raw !== undefined) {
        try {
          JSON.parse(raw);
          jsonValidity = "valid";
        } catch {
          jsonValidity = "invalid";
        }
      }
      return {
        index,
        id: boundedIdentifier(call.id),
        name: boundedIdentifier(call.name),
        argumentsHash: raw === undefined ? null : contentHash(raw),
        argumentsBytes: raw === undefined ? null : Buffer.byteLength(raw, "utf8"),
        jsonValidity,
        invalidInputMatchesWire:
          jsonValidity === "invalid" && adaptedInputs !== undefined && index < adaptedInputs.length
            ? adaptedInputs[index] === raw
            : null,
      };
    }),
  };
}

/** The journal validates diagnostic facts independently of provider SDK types. */
export function assertModelToolCallWireEvidence(
  value: unknown,
): asserts value is ModelToolCallWireEvidence {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["kind", "envelopeHash", "totalCalls", "omittedCalls", "calls"]) ||
    value.kind !== "ModelToolCallWireEvidence" ||
    typeof value.envelopeHash !== "string" ||
    !SHA256.test(value.envelopeHash) ||
    !nonnegativeInteger(value.totalCalls) ||
    !nonnegativeInteger(value.omittedCalls) ||
    !Array.isArray(value.calls) ||
    value.calls.length !== Math.min(value.totalCalls as number, MAX_DETAIL_CALLS) ||
    value.omittedCalls !== (value.totalCalls as number) - value.calls.length
  )
    throw new Error("Invalid model tool-call wire evidence");
  for (const [index, row] of value.calls.entries()) {
    if (
      !isRecord(row) ||
      !exactKeys(row, [
        "index",
        "id",
        "name",
        "argumentsHash",
        "argumentsBytes",
        "jsonValidity",
        "invalidInputMatchesWire",
      ]) ||
      row.index !== index ||
      !validIdentifier(row.id) ||
      !validIdentifier(row.name) ||
      !["valid", "invalid", "unavailable"].includes(String(row.jsonValidity)) ||
      (row.invalidInputMatchesWire !== null && typeof row.invalidInputMatchesWire !== "boolean")
    )
      throw new Error("Invalid model tool-call wire evidence row");
    if (row.jsonValidity === "unavailable") {
      if (
        row.argumentsHash !== null ||
        row.argumentsBytes !== null ||
        row.invalidInputMatchesWire !== null
      )
        throw new Error("Unavailable wire arguments cannot carry derived facts");
    } else if (
      typeof row.argumentsHash !== "string" ||
      !SHA256.test(row.argumentsHash) ||
      !nonnegativeInteger(row.argumentsBytes) ||
      (row.jsonValidity !== "invalid" && row.invalidInputMatchesWire !== null)
    ) {
      throw new Error("Invalid model wire argument digest or comparison");
    }
  }
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH
    ? value
    : null;
}

function validIdentifier(value: unknown): boolean {
  return value === null || boundedIdentifier(value) === value;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
