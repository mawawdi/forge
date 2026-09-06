import type { VisualObservationInput } from "./types";
import { DEFAULT_VISUAL_EVIDENCE_POLICY } from "../../packages/visual-evidence/src/contracts.js";

export const VISUAL_ATTACHMENT_LIMITS = {
  count: DEFAULT_VISUAL_EVIDENCE_POLICY.maximumImages,
  sourceFileBytes: 16 * 1024 * 1024,
  fileBytes: DEFAULT_VISUAL_EVIDENCE_POLICY.maximumImageBytes,
  totalBytes: DEFAULT_VISUAL_EVIDENCE_POLICY.maximumAggregateBytes,
  dimension: DEFAULT_VISUAL_EVIDENCE_POLICY.maximumDimension,
  pixels: DEFAULT_VISUAL_EVIDENCE_POLICY.maximumPixels,
} as const;

export interface ComposerVisualAttachment {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly observation: VisualObservationInput;
}

/** Local preparation only; the host validates the submitted PNG bytes and provenance. */
export async function readVisualAttachment(file: File): Promise<ComposerVisualAttachment> {
  const name = file.name.trim() || "Pasted image";
  const sourceError = sourceFileError(file);
  if (sourceError) throw new Error(sourceError);
  const source = await readBytes(file, name);
  const metadata = imageMetadata(source, name);
  checkDimensions(metadata.width, metadata.height, name);
  if (metadata.mimeType === "image/png") checkPreparedSize(source.length, name);
  const image = new Image();
  const objectUrl = URL.createObjectURL(new Blob([source], { type: metadata.mimeType }));
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error(`${name}: this image could not be displayed. Export it again and retry.`));
      image.src = objectUrl;
    });
    const width = image.naturalWidth,
      height = image.naturalHeight;
    checkDimensions(width, height, name);
    // JPEG orientation metadata can swap the browser's displayed axes.
    if (
      !(width === metadata.width && height === metadata.height) &&
      !(
        metadata.mimeType === "image/jpeg" &&
        width === metadata.height &&
        height === metadata.width
      )
    )
      throw new Error(`${name}: the image dimensions could not be confirmed. Export it again.`);
    const prepared = metadata.mimeType === "image/png" ? source : await preparePng(image, name);
    checkPreparedSize(prepared.length, name);
    const chunks: string[] = [];
    for (let at = 0; at < prepared.length; at += 32768)
      chunks.push(String.fromCharCode(...prepared.subarray(at, at + 32768)));
    return {
      id: crypto.randomUUID(),
      name,
      bytes: prepared.length,
      width,
      height,
      observation: {
        kind: "reference",
        caption: name.slice(0, 2048),
        image: { mimeType: "image/png", base64: btoa(chunks.join("")) },
      },
    };
  } finally {
    image.onload = null;
    image.onerror = null;
    image.src = "";
    URL.revokeObjectURL(objectUrl);
  }
}

function readBytes(blob: Blob, name: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(new Uint8Array(reader.result))
        : reject(new Error(`${name}: this image could not be read. Choose it again.`));
    reader.onerror = () =>
      reject(new Error(`${name}: this image could not be read. Choose it again.`));
    reader.onabort = () =>
      reject(new Error(`${name}: image reading was interrupted. Choose it again.`));
    reader.readAsArrayBuffer(blob);
  });
}

function imageMetadata(bytes: Uint8Array, name: string) {
  const invalid = () => new Error(`${name}: choose a readable PNG, JPEG, or WebP image.`);
  const matches = (at: number, values: number[]) =>
    values.every((value, i) => bytes[at + i] === value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (matches(0, [137, 80, 78, 71, 13, 10, 26, 10])) {
    if (bytes.length < 33 || !matches(8, [0, 0, 0, 13, 73, 72, 68, 82])) throw invalid();
    return { mimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (matches(0, [255, 216, 255])) {
    let at = 2;
    while (at < bytes.length) {
      if (bytes[at++] !== 255) throw invalid();
      while (bytes[at] === 255) at++;
      if (at >= bytes.length) throw invalid();
      const marker = view.getUint8(at++);
      if (marker === 217 || marker === 218 || at + 2 > bytes.length) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) throw invalid();
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) throw invalid();
        return {
          mimeType: "image/jpeg",
          width: view.getUint16(at + 5),
          height: view.getUint16(at + 3),
        };
      }
      at += length;
    }
    throw invalid();
  }
  if (bytes.length >= 12 && matches(0, [82, 73, 70, 70]) && matches(8, [87, 69, 66, 80])) {
    if (view.getUint32(4, true) + 8 !== bytes.length) throw invalid();
    let canvas: { width: number; height: number } | undefined;
    let frame: { width: number; height: number } | undefined;
    let at = 12;
    while (at + 8 <= bytes.length) {
      const length = view.getUint32(at + 4, true);
      const payload = at + 8;
      if (payload + length + (length % 2) > bytes.length) throw invalid();
      if (matches(at, [65, 78, 73, 77]) || matches(at, [65, 78, 77, 70]))
        throw new Error(`${name}: choose a still image or capture one frame of the animation.`);
      if (matches(at, [86, 80, 56, 88])) {
        if (length !== 10 || canvas) throw invalid();
        if (view.getUint8(payload) & 2)
          throw new Error(`${name}: choose a still image or capture one frame of the animation.`);
        const uint24 = (offset: number) =>
          view.getUint8(offset) +
          view.getUint8(offset + 1) * 256 +
          view.getUint8(offset + 2) * 65536;
        canvas = { width: uint24(payload + 4) + 1, height: uint24(payload + 7) + 1 };
        checkDimensions(canvas.width, canvas.height, name);
      } else if (matches(at, [86, 80, 56, 32])) {
        if (length < 10 || frame || !matches(payload + 3, [157, 1, 42])) throw invalid();
        frame = {
          width: view.getUint16(payload + 6, true) & 16383,
          height: view.getUint16(payload + 8, true) & 16383,
        };
      } else if (matches(at, [86, 80, 56, 76])) {
        if (length < 5 || frame || bytes[payload] !== 47) throw invalid();
        const bits = view.getUint32(payload + 1, true);
        frame = { width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 };
      }
      at = payload + length + (length % 2);
    }
    if (
      at !== bytes.length ||
      !frame ||
      (canvas && (canvas.width !== frame.width || canvas.height !== frame.height))
    )
      throw invalid();
    return { mimeType: "image/webp", ...frame };
  }
  throw invalid();
}

function checkDimensions(width: number, height: number, name: string) {
  if (
    !width ||
    !height ||
    width > VISUAL_ATTACHMENT_LIMITS.dimension ||
    height > VISUAL_ATTACHMENT_LIMITS.dimension ||
    width * height > VISUAL_ATTACHMENT_LIMITS.pixels
  )
    throw new Error(
      `${name}: use an image up to 8192 pixels per side and 16 megapixels. Resize it and try again.`,
    );
}

function sourceFileError(file: File): string | undefined {
  if (!file.size || file.size > VISUAL_ATTACHMENT_LIMITS.sourceFileBytes)
    return `${file.name.trim() || "Pasted image"}: choose an image between 1 byte and 16 MiB.`;
  return undefined;
}

function checkPreparedSize(bytes: number, name: string) {
  if (!bytes || bytes > VISUAL_ATTACHMENT_LIMITS.fileBytes)
    throw new Error(`${name}: this image needs more than 4 MiB as PNG. Resize it and try again.`);
}

async function preparePng(image: HTMLImageElement, name: string): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = document.createElement("canvas");
  try {
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error(`${name}: this browser could not prepare the image. Try a PNG instead.`);
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) =>
          result
            ? resolve(result)
            : reject(new Error(`${name}: the image could not be prepared. Try a PNG instead.`)),
        "image/png",
      ),
    );
    checkPreparedSize(blob.size, name);
    return await readBytes(blob, name);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function attachmentBatchError(
  current: readonly ComposerVisualAttachment[],
  files: readonly File[],
): string | undefined {
  if (current.length + files.length > VISUAL_ATTACHMENT_LIMITS.count)
    return "Attach up to 4 images. Remove an image before adding more.";
  for (const file of files) {
    const error = sourceFileError(file);
    if (error) return error;
  }
  return undefined;
}
