import { createHash } from "node:crypto";
import type { ModelMessage } from "./contracts.js";

export interface ModelImage {
  readonly mimeType: "image/png";
  readonly base64: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

export const MODEL_IMAGE_LIMITS = Object.freeze({
  maximumCount: 4,
  maximumBytesPerImage: 4 * 1024 * 1024,
  maximumTotalBytes: 8 * 1024 * 1024,
  maximumDimension: 8192,
  maximumPixels: 16 * 1024 * 1024,
});

/** Transport integrity checks. Full PNG decoding and capture provenance belong to the host. */
export function assertModelImages(value: unknown): asserts value is readonly ModelImage[] {
  if (!Array.isArray(value) || value.length > MODEL_IMAGE_LIMITS.maximumCount)
    throw new Error("Model images exceed the admitted image count.");
  let total = 0;
  for (const image of value) {
    if (!image || typeof image !== "object" || Array.isArray(image))
      throw new Error("Invalid model image record.");
    const keys = ["mimeType", "base64", "sha256", "width", "height"];
    const descriptors = Object.getOwnPropertyDescriptors(image);
    if (
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !descriptors[key] || !("value" in descriptors[key]!))
    )
      throw new Error("Model images require exact plain data fields.");
    if (
      image.mimeType !== "image/png" ||
      typeof image.base64 !== "string" ||
      image.base64.length > 4 * Math.ceil(MODEL_IMAGE_LIMITS.maximumBytesPerImage / 3) ||
      image.base64.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(image.base64) ||
      typeof image.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(image.sha256)
    )
      throw new Error("Model image needs bounded canonical PNG base64 and SHA-256.");
    const bytes = Buffer.from(image.base64, "base64");
    total += bytes.length;
    if (
      bytes.length < 33 ||
      bytes.length > MODEL_IMAGE_LIMITS.maximumBytesPerImage ||
      total > MODEL_IMAGE_LIMITS.maximumTotalBytes ||
      bytes.toString("base64") !== image.base64
    )
      throw new Error("Model image bytes exceed their bounds or are not canonical base64.");
    if (createHash("sha256").update(bytes).digest("hex") !== image.sha256)
      throw new Error("Model image SHA-256 does not match its exact bytes.");
    if (
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR"
    )
      throw new Error("Model image has no valid PNG signature and IHDR header.");
    if (
      !Number.isSafeInteger(image.width) ||
      !Number.isSafeInteger(image.height) ||
      image.width < 1 ||
      image.height < 1 ||
      image.width > MODEL_IMAGE_LIMITS.maximumDimension ||
      image.height > MODEL_IMAGE_LIMITS.maximumDimension ||
      image.width * image.height > MODEL_IMAGE_LIMITS.maximumPixels ||
      bytes.readUInt32BE(16) !== image.width ||
      bytes.readUInt32BE(20) !== image.height
    )
      throw new Error("Model image dimensions must match its bounded PNG header.");
  }
}

/** Images have exactly one message role and a request-wide budget, regardless of transport. */
export function assertModelMessageImages(messages: readonly ModelMessage[]): void {
  const images: ModelImage[] = [];
  for (const message of messages) {
    if (!("images" in message)) continue;
    if (message.role !== "user") throw new Error("Only user model messages may contain images.");
    assertModelImages(message.images);
    images.push(...message.images);
  }
  assertModelImages(images);
}
