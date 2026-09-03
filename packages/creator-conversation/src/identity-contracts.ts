import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { CreatorProjectIdentity } from "./contracts.js";

/** Host-authored proof of the creator's explicit local-to-published choice. */
export interface CreatorPublishedIdentityContinuityReceipt {
  readonly kind: "CreatorPublishedIdentityContinuityReceipt";
  readonly id: string;
  readonly hash: string;
  readonly choice: "continue_conversation" | "start_new_conversation";
  readonly sourceConversationId: string;
  readonly sourceConversationHash: string;
  readonly localIdentity: Extract<CreatorProjectIdentity, { readonly kind: "local_linked" }>;
  readonly publishedIdentity: Extract<CreatorProjectIdentity, { readonly kind: "published" }>;
  readonly controlViewId: string;
  readonly controlViewHash: string;
  readonly actionInstanceId: string;
  readonly requestHash: string;
  readonly createdAt: string;
}

export function sealCreatorPublishedIdentityContinuityReceipt(
  draft: Omit<CreatorPublishedIdentityContinuityReceipt, "kind" | "hash">,
): CreatorPublishedIdentityContinuityReceipt {
  const canonical = JSON.parse(
    stableJson({ kind: "CreatorPublishedIdentityContinuityReceipt", ...draft }),
  ) as Omit<CreatorPublishedIdentityContinuityReceipt, "hash">;
  const receipt = { ...canonical, hash: contentHash(stableJson(canonical)) };
  assertCreatorPublishedIdentityContinuityReceipt(receipt);
  return receipt;
}

export function assertCreatorPublishedIdentityContinuityReceipt(
  value: unknown,
): asserts value is CreatorPublishedIdentityContinuityReceipt {
  if (!isRecord(value) || value.kind !== "CreatorPublishedIdentityContinuityReceipt")
    throw new Error("Invalid CreatorPublishedIdentityContinuityReceipt");
  assertId(value.id, "published continuity receipt ID");
  assertHash(value.hash, "published continuity receipt hash");
  if (
    !(["continue_conversation", "start_new_conversation"] as const).includes(
      value.choice as "continue_conversation" | "start_new_conversation",
    )
  )
    throw new Error("Invalid published continuity choice");
  assertId(value.sourceConversationId, "published continuity source conversation");
  assertHash(value.sourceConversationHash, "published continuity source hash");
  if (
    !isRecord(value.localIdentity) ||
    value.localIdentity.kind !== "local_linked" ||
    typeof value.localIdentity.forgeProjectId !== "string" ||
    !ID_PATTERN.test(value.localIdentity.forgeProjectId)
  )
    throw new Error("Invalid published continuity local identity");
  if (
    !isRecord(value.publishedIdentity) ||
    value.publishedIdentity.kind !== "published" ||
    typeof value.publishedIdentity.universeId !== "string" ||
    !POSITIVE_INTEGER_PATTERN.test(value.publishedIdentity.universeId) ||
    typeof value.publishedIdentity.placeId !== "string" ||
    !POSITIVE_INTEGER_PATTERN.test(value.publishedIdentity.placeId)
  )
    throw new Error("Invalid published continuity platform identity");
  assertId(value.controlViewId, "published continuity control view");
  assertHash(value.controlViewHash, "published continuity control hash");
  assertId(value.actionInstanceId, "published continuity action");
  assertHash(value.requestHash, "published continuity request");
  canonicalIso(value.createdAt, "published continuity createdAt");
  const { hash, ...payload } = value;
  if (contentHash(stableJson(payload)) !== hash)
    throw new Error("Invalid CreatorPublishedIdentityContinuityReceipt content identity");
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

function canonicalIso(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value)
    throw new Error(`Invalid ${label}`);
  return timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
