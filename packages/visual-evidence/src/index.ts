import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertBoundedGameJson,
  DEFAULT_GAME_ADMISSION_POLICY,
} from "../../game-ir/src/primitives.js";

export * from "./contracts.js";
import {
  DEFAULT_VISUAL_EVIDENCE_POLICY,
  VISUAL_OBSERVATION_INPUT_SCHEMA,
  VISUAL_OBSERVATION_BINDING_SCHEMA,
  VISUAL_IMAGE_INPUT_SCHEMA as imageInputSchema,
  VISUAL_CAPTION_SCHEMA as captionSchema,
  VISUAL_REPORTED_FIELDS as reportedFields,
  visualHashSchema as hashSchema,
  type VisualEvidencePolicy,
  type VisualObservationInput,
  type VisualObservationBinding,
  type VisualModelImage,
  type VisualObservation,
} from "./contracts.js";
export class VisualEvidenceError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

/** The binding records submission context. It does not attest where or when pixels were captured. */
export function createVisualObservation(
  input: unknown,
  binding: VisualObservationBinding,
  policy: VisualEvidencePolicy = DEFAULT_VISUAL_EVIDENCE_POLICY,
): VisualObservation {
  assertPolicy(policy);
  assertJson(input, policy);
  assertJson(binding, policy);
  const value = VISUAL_OBSERVATION_INPUT_SCHEMA.parse(input);
  const bound = VISUAL_OBSERVATION_BINDING_SCHEMA.parse(binding);
  if (bound.viewId !== undefined && bound.planHash === undefined)
    fail("invalid_binding", "A host-resolved view requires an exact plan hash");
  if (value.kind === "rendered_view" && value.viewId !== undefined && value.viewId !== bound.viewId)
    fail("invalid_binding", "The reported view must resolve to the host-bound plan view");
  const body = {
    kind: "VisualObservation" as const,
    source: "creator_upload" as const,
    evidenceScope: "creator_reported_visual" as const,
    bindingScope: "project_revision_at_submission" as const,
    binding: bound,
    observationKind: value.kind,
    caption: value.caption,
    ...(value.kind === "rendered_view" && value.viewId !== undefined
      ? { viewId: value.viewId }
      : {}),
    ...(value.kind === "rendered_view" && value.state !== undefined ? { state: value.state } : {}),
    ...(value.kind === "rendered_view" && value.graphicsSettings !== undefined
      ? { graphicsSettings: value.graphicsSettings }
      : {}),
    image: inspectVisualPng(value.image, policy),
  };
  return { ...body, hash: contentHash(stableJson(body)) };
}

export function createVisualObservations(
  inputs: unknown,
  binding: VisualObservationBinding,
  policy: VisualEvidencePolicy = DEFAULT_VISUAL_EVIDENCE_POLICY,
): VisualObservation[] {
  return validateVisualObservationInputs(inputs, policy).map((input) =>
    createVisualObservation(input, binding, policy),
  );
}

/** Validate upload material before the host captures a submission revision or writes durable state. */
export function validateVisualObservationInputs(
  inputs: unknown,
  policy: VisualEvidencePolicy = DEFAULT_VISUAL_EVIDENCE_POLICY,
): VisualObservationInput[] {
  assertPolicy(policy);
  assertJson(inputs, policy);
  if (!Array.isArray(inputs) || inputs.length > policy.maximumImages)
    fail("resource_limit", `A visual submission admits at most ${policy.maximumImages} images`);
  const values = inputs.map((input) => VISUAL_OBSERVATION_INPUT_SCHEMA.parse(input));
  if (
    values.reduce((bytes, item) => bytes + Buffer.byteLength(item.image.base64, "base64"), 0) >
    policy.maximumAggregateBytes
  )
    fail("resource_limit", "Visual submission exceeds its aggregate original-image byte budget");
  for (const value of values) inspectVisualPng(value.image, policy);
  return values;
}

/** Replays bytes, metadata, exact host binding and content hash; returns a detached current-format artifact. */
export function assertVisualObservation(
  input: unknown,
  expectedBinding?: VisualObservationBinding,
  policy: VisualEvidencePolicy = DEFAULT_VISUAL_EVIDENCE_POLICY,
): VisualObservation {
  assertPolicy(policy);
  assertJson(input, policy);
  const schema = z
    .object({
      kind: z.literal("VisualObservation"),
      hash: hashSchema,
      source: z.literal("creator_upload"),
      evidenceScope: z.literal("creator_reported_visual"),
      bindingScope: z.literal("project_revision_at_submission"),
      binding: VISUAL_OBSERVATION_BINDING_SCHEMA,
      observationKind: z.enum(["reference", "rendered_view"]),
      caption: captionSchema,
      ...reportedFields,
      image: imageInputSchema
        .extend({
          sha256: hashSchema,
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .strict(),
    })
    .strict();
  const value = schema.parse(input);
  const rebuilt = createVisualObservation(
    {
      kind: value.observationKind,
      caption: value.caption,
      image: { mimeType: value.image.mimeType, base64: value.image.base64 },
      ...(value.viewId !== undefined ? { viewId: value.viewId } : {}),
      ...(value.state !== undefined ? { state: value.state } : {}),
      ...(value.graphicsSettings !== undefined ? { graphicsSettings: value.graphicsSettings } : {}),
    },
    expectedBinding ?? value.binding,
    policy,
  );
  if (stableJson(rebuilt) !== stableJson(input))
    fail(
      "evidence_mismatch",
      "Visual observation differs from its exact bytes, submission binding or declared metadata",
    );
  return rebuilt;
}

export function assertVisualObservations(
  inputs: unknown,
  binding?: VisualObservationBinding,
  policy: VisualEvidencePolicy = DEFAULT_VISUAL_EVIDENCE_POLICY,
): VisualObservation[] {
  assertPolicy(policy);
  assertJson(inputs, policy);
  if (!Array.isArray(inputs) || inputs.length > policy.maximumImages)
    fail("resource_limit", `A visual submission admits at most ${policy.maximumImages} images`);
  const result = inputs.map((input) => assertVisualObservation(input, binding, policy));
  assertAggregate(result, policy);
  return result;
}

export function visualObservationModelImage(
  value: unknown,
  binding?: VisualObservationBinding,
  policy: VisualEvidencePolicy = DEFAULT_VISUAL_EVIDENCE_POLICY,
): VisualModelImage {
  return assertVisualObservation(value, binding, policy).image;
}

function assertAggregate(images: readonly VisualObservation[], policy: VisualEvidencePolicy): void {
  if (
    images.reduce((bytes, item) => bytes + Buffer.byteLength(item.image.base64, "base64"), 0) >
    policy.maximumAggregateBytes
  )
    fail("resource_limit", "Visual submission exceeds its aggregate original-image byte budget");
}
function assertPolicy(policy: VisualEvidencePolicy): void {
  assertBoundedGameJson(policy, DEFAULT_GAME_ADMISSION_POLICY);
  if (
    Object.keys(policy).sort().join(",") !==
    Object.keys(DEFAULT_VISUAL_EVIDENCE_POLICY).sort().join(",")
  )
    fail("invalid_policy", "Visual evidence policy requires every current bound");
  for (const key of Object.keys(DEFAULT_VISUAL_EVIDENCE_POLICY) as Array<
    keyof VisualEvidencePolicy
  >)
    if (
      !Number.isSafeInteger(policy[key]) ||
      policy[key] < 1 ||
      policy[key] > DEFAULT_VISUAL_EVIDENCE_POLICY[key]
    )
      fail("invalid_policy", "Visual evidence policy may only tighten positive bounded limits");
}
function assertJson(value: unknown, policy: VisualEvidencePolicy): void {
  assertBoundedGameJson(value, {
    ...DEFAULT_GAME_ADMISSION_POLICY,
    maximumJsonBytes: Math.ceil(policy.maximumAggregateBytes / 3) * 4 + 65536,
    maximumStringUtf8Bytes: Math.max(8192, Math.ceil(policy.maximumImageBytes / 3) * 4),
    maximumJsonNodes: 1024,
    maximumJsonDepth: 8,
  });
}
function fail(code: string, detail: string): never {
  throw new VisualEvidenceError(code, detail);
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) crc = CRC_TABLE[(crc ^ value) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bounded static-PNG admission, preserving original bytes; not a renderer or native screenshot attestation. */
export function inspectVisualPng(
  input: unknown,
  policy: VisualEvidencePolicy = DEFAULT_VISUAL_EVIDENCE_POLICY,
): VisualModelImage {
  assertPolicy(policy);
  assertJson(input, policy);
  const value = imageInputSchema.parse(input);
  if (value.base64.length > Math.ceil(policy.maximumImageBytes / 3) * 4)
    fail("resource_limit", "PNG exceeds original-image byte budget");
  if (value.base64.length % 4 !== 0)
    fail("invalid_image", "PNG requires bounded canonical padded base64");
  const bytes = Buffer.from(value.base64, "base64");
  if (bytes.length > policy.maximumImageBytes)
    fail("resource_limit", "PNG exceeds original-image byte budget");
  if (bytes.toString("base64") !== value.base64)
    fail("invalid_image", "PNG requires canonical padded base64 without URLs or whitespace");
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) fail("invalid_png", "PNG signature is invalid");
  let width = 0,
    height = 0,
    depth = 0,
    color = -1,
    interlace = 0;
  let offset = 8,
    chunks = 0,
    paletteEntries = 0,
    closedIdat = false,
    ended = false;
  let ancillaryBudget = policy.maximumAncillaryInflatedBytes;
  const seen = new Set<string>();
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    if (++chunks > policy.maximumChunks) fail("resource_limit", "PNG chunk budget exceeded");
    if (offset + 12 > bytes.length) fail("invalid_png", "PNG chunk is truncated");
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > bytes.length)
      fail("invalid_png", "PNG chunk length is invalid");
    const name = bytes.toString("ascii", offset + 4, offset + 8);
    const nameBytes = bytes.subarray(offset + 4, offset + 8);
    if (
      [...nameBytes].some((byte) => !((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) ||
      nameBytes[2]! & 32
    )
      fail("invalid_png", "PNG chunk type or reserved bit is invalid");
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
      fail("invalid_png", `PNG ${name} CRC mismatch`);
    const chunk = bytes.subarray(offset + 8, end - 4);
    if (chunks === 1 && name !== "IHDR") fail("invalid_png", "PNG must begin with IHDR");
    if (data.length && name !== "IDAT") closedIdat = true;
    if (name === "IHDR") {
      if (seen.has(name) || length !== 13) fail("invalid_png", "PNG requires one 13-byte IHDR");
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      depth = chunk[8]!;
      color = chunk[9]!;
      interlace = chunk[12]!;
      if (
        !width ||
        !height ||
        width > policy.maximumDimension ||
        height > policy.maximumDimension ||
        width * height > policy.maximumPixels
      )
        fail("resource_limit", "PNG dimensions or pixel count exceed policy");
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !depths[color]?.includes(depth) ||
        chunk[10] !== 0 ||
        chunk[11] !== 0 ||
        ![0, 1].includes(interlace)
      )
        fail(
          "invalid_png",
          "PNG color, bit depth, compression, filter or interlace method is invalid",
        );
    } else if (name === "PLTE") {
      if (
        seen.has(name) ||
        data.length ||
        seen.has("tRNS") ||
        seen.has("bKGD") ||
        [0, 4].includes(color) ||
        !length ||
        length % 3 ||
        length > 768 ||
        (color === 3 && length / 3 > 2 ** depth)
      )
        fail("invalid_png", "PNG palette size, color type or ordering is invalid");
      paletteEntries = length / 3;
    } else if (name === "IDAT") {
      if (closedIdat || (color === 3 && !paletteEntries))
        fail("invalid_png", "PNG IDAT chunks must be consecutive and follow the required palette");
      data.push(chunk);
    } else if (name === "IEND") {
      if (length || !data.length || end !== bytes.length)
        fail(
          "invalid_png",
          "PNG requires a final empty IEND after image data, without trailing bytes",
        );
      ended = true;
    } else {
      if (["acTL", "fcTL", "fdAT"].includes(name))
        fail("unsupported_png", "Animated PNG is not admitted; supply a static PNG view");
      if (seen.has(name) && !["tEXt", "iTXt", "zTXt"].includes(name))
        fail("invalid_png", `Duplicate PNG ${name} chunk`);
      const beforePalette = ["cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "cICP"];
      if (
        (beforePalette.includes(name) && (paletteEntries || data.length)) ||
        (["tRNS", "bKGD", "hIST", "pHYs"].includes(name) && data.length)
      )
        fail("invalid_png", `PNG ${name} chunk ordering is invalid`);
      if (name === "tRNS") {
        if (
          color === 3
            ? !paletteEntries || !length || length > paletteEntries
            : color === 0
              ? length !== 2 || chunk.readUInt16BE(0) >= 2 ** depth
              : color === 2
                ? length !== 6 || [0, 2, 4].some((index) => chunk.readUInt16BE(index) >= 2 ** depth)
                : true
        )
          fail("invalid_png", "PNG transparency does not match its color type or palette");
      } else if (name === "iCCP") {
        if (seen.has("sRGB")) fail("invalid_png", "PNG cannot declare both iCCP and sRGB");
        const separator = keywordSeparator(chunk);
        if (chunk[separator + 1] !== 0)
          fail("invalid_png", "PNG ICC compression method is invalid");
        const profile = inflateBounded(chunk.subarray(separator + 2), ancillaryBudget);
        ancillaryBudget -= profile.length;
      } else if (name === "tEXt") {
        const separator = keywordSeparator(chunk);
        if (chunk.subarray(separator + 1).includes(0))
          fail("invalid_png", "PNG text contains an embedded null");
      } else if (name === "iTXt" || name === "zTXt") {
        const separator = keywordSeparator(chunk);
        let text: Buffer;
        if (name === "zTXt") {
          if (chunk[separator + 1] !== 0)
            fail("invalid_png", "PNG text compression method is invalid");
          text = inflateBounded(chunk.subarray(separator + 2), ancillaryBudget);
          ancillaryBudget -= text.length;
        } else {
          const compressed = chunk[separator + 1];
          const languageEnd = chunk.indexOf(0, separator + 3);
          const translatedEnd = chunk.indexOf(0, languageEnd + 1);
          if (
            ![0, 1].includes(compressed!) ||
            chunk[separator + 2] !== 0 ||
            languageEnd < separator + 3 ||
            translatedEnd < languageEnd + 1
          )
            fail("invalid_png", "PNG international text framing is invalid");
          if (
            [...chunk.subarray(separator + 3, languageEnd)].some(
              (byte) =>
                !(
                  (byte >= 65 && byte <= 90) ||
                  (byte >= 97 && byte <= 122) ||
                  (byte >= 48 && byte <= 57) ||
                  byte === 45
                ),
            )
          )
            fail("invalid_png", "PNG text language tag is invalid");
          utf8Text(chunk.subarray(languageEnd + 1, translatedEnd));
          text = compressed
            ? inflateBounded(chunk.subarray(translatedEnd + 1), ancillaryBudget)
            : chunk.subarray(translatedEnd + 1);
          if (compressed) ancillaryBudget -= text.length;
          utf8Text(text);
        }
        if (text.includes(0)) fail("invalid_png", "PNG text contains an embedded null");
      } else if (name === "cICP") {
        if (length !== 4 || chunk[2] !== 0 || chunk[3]! > 1)
          fail("invalid_png", "PNG coding-independent color metadata is invalid");
      } else if (name === "eXIf") {
        // Retained as historical opaque metadata; do not traverse TIFF pointers or use capture claims.
        if (length < 8 || !["49492a00", "4d4d002a"].includes(chunk.subarray(0, 4).toString("hex")))
          fail("invalid_png", "PNG EXIF header is invalid");
      } else if (name === "iDOT") {
        // Apple screenshot optimization metadata is ignored. Pixels always follow the full IDAT stream.
        if (!length) fail("invalid_png", "PNG iDOT metadata is empty");
      } else if (name === "sRGB") {
        if (seen.has("iCCP") || length !== 1 || chunk[0]! > 3)
          fail("invalid_png", "PNG sRGB chunk is invalid");
      } else if (name === "gAMA") {
        if (length !== 4 || chunk.readUInt32BE(0) === 0)
          fail("invalid_png", "PNG gamma is invalid");
      } else if (name === "cHRM") {
        if (length !== 32) fail("invalid_png", "PNG chromaticity chunk is invalid");
      } else if (name === "pHYs") {
        if (length !== 9 || chunk[8]! > 1)
          fail("invalid_png", "PNG pixel dimensions chunk is invalid");
      } else if (name === "sBIT") {
        const count = ({ 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 } as Record<number, number>)[color]!;
        if (
          length !== count ||
          [...chunk].some((bits) => bits < 1 || bits > (color === 3 ? 8 : depth))
        )
          fail("invalid_png", "PNG significant bits chunk is invalid");
      } else if (name === "bKGD") {
        if (
          color === 3
            ? length !== 1 || !paletteEntries || chunk[0]! >= paletteEntries
            : length !== ([0, 4].includes(color) ? 2 : 6) ||
              Array.from({ length: length / 2 }, (_, index) => chunk.readUInt16BE(index * 2)).some(
                (sample) => sample >= 2 ** depth,
              )
        )
          fail("invalid_png", "PNG background does not match its color type or palette");
      } else if (name === "hIST") {
        if (!paletteEntries || length !== paletteEntries * 2)
          fail("invalid_png", "PNG histogram requires its exact palette");
      } else if (name === "tIME") {
        if (
          length !== 7 ||
          chunk[2]! < 1 ||
          chunk[2]! > 12 ||
          chunk[3]! < 1 ||
          chunk[3]! > 31 ||
          chunk[4]! > 23 ||
          chunk[5]! > 59 ||
          chunk[6]! > 60
        )
          fail("invalid_png", "PNG timestamp fields are invalid");
      } else
        fail(
          "unsupported_png",
          `PNG chunk ${name} is not admitted; export a standard static PNG without this metadata`,
        );
    }
    seen.add(name);
    offset = end;
  }
  if (!ended) fail("invalid_png", "PNG is missing IEND");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]!;
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  const scanlines = passes
    .map(([x, y, dx, dy]) => ({
      width: Math.max(0, Math.ceil((width - x!) / dx!)),
      height: Math.max(0, Math.ceil((height - y!) / dy!)),
    }))
    .filter((pass) => pass.width && pass.height)
    .map((pass) => ({ ...pass, rowBytes: Math.ceil((pass.width * channels * depth) / 8) }));
  const expectedBytes = scanlines.reduce(
    (size, pass) => size + (pass.rowBytes + 1) * pass.height,
    0,
  );
  if (expectedBytes > policy.maximumInflatedBytes)
    fail("resource_limit", "PNG decoded scanlines exceed the inflation budget");
  const compressed = Buffer.concat(data);
  const inflated = inflateBounded(compressed, expectedBytes);
  if (inflated.length !== expectedBytes)
    fail("invalid_png", "PNG decoded scanline length differs from its dimensions");
  checkScanlines(inflated, scanlines, channels, depth, color, paletteEntries);
  return {
    mimeType: "image/png",
    base64: value.base64,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width,
    height,
  };
}

function utf8Text(bytes: Buffer): void {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid_png", "PNG international text is not valid UTF-8");
  }
}
function keywordSeparator(chunk: Buffer): number {
  const separator = chunk.indexOf(0);
  const keyword = chunk.subarray(0, separator);
  if (
    separator < 1 ||
    separator > 79 ||
    [...keyword].some((byte) => byte < 32 || (byte > 126 && byte < 161)) ||
    keyword[0] === 32 ||
    keyword.at(-1) === 32 ||
    keyword.includes(Buffer.from("  "))
  )
    fail("invalid_png", "PNG metadata keyword is invalid");
  return separator;
}
function inflateBounded(bytes: Buffer, maximumBytes: number): Buffer {
  if (maximumBytes < 1) fail("resource_limit", "PNG inflation budget exceeded");
  try {
    // Node's info:true result exposes consumed compressed bytes; its declarations omit that overload.
    const result = inflateSync(bytes, { maxOutputLength: maximumBytes, info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (result.engine.bytesWritten !== bytes.length)
      fail("invalid_png", "PNG compressed stream has trailing or concatenated data");
    return result.buffer;
  } catch (error) {
    if (error instanceof VisualEvidenceError) throw error;
    fail(
      "invalid_png",
      "PNG compressed stream is invalid, truncated or exceeds its inflation budget",
    );
  }
}
function checkScanlines(
  bytes: Buffer,
  passes: Array<{ width: number; height: number; rowBytes: number }>,
  channels: number,
  depth: number,
  color: number,
  paletteEntries: number,
): void {
  let offset = 0;
  const bytesPerPixel = Math.max(1, Math.ceil((channels * depth) / 8));
  for (const pass of passes) {
    let previous = Buffer.alloc(pass.rowBytes),
      row = Buffer.alloc(pass.rowBytes);
    for (let y = 0; y < pass.height; y++) {
      const filter = bytes[offset++]!;
      if (filter > 4) fail("invalid_png", "PNG scanline has an invalid filter type");
      // Only indexed PNG needs unfiltering to verify that each sample names an existing palette entry.
      if (color === 3) {
        for (let x = 0; x < pass.rowBytes; x++) {
          const left = x < bytesPerPixel ? 0 : row[x - bytesPerPixel]!;
          const up = previous[x]!;
          const upperLeft = x < bytesPerPixel ? 0 : previous[x - bytesPerPixel]!;
          const prediction =
            filter === 0
              ? 0
              : filter === 1
                ? left
                : filter === 2
                  ? up
                  : filter === 3
                    ? Math.floor((left + up) / 2)
                    : paeth(left, up, upperLeft);
          row[x] = (bytes[offset + x]! + prediction) & 255;
        }
        for (let pixel = 0; pixel < pass.width; pixel++) {
          const bit = pixel * depth;
          const sample = (row[bit >>> 3]! >>> (8 - depth - (bit % 8))) & (2 ** depth - 1);
          if (sample >= paletteEntries)
            fail("invalid_png", "PNG pixel references an absent palette entry");
        }
        [previous, row] = [row, previous];
      }
      offset += pass.rowBytes;
    }
  }
}
function paeth(left: number, up: number, upperLeft: number): number {
  const value = left + up - upperLeft;
  const a = Math.abs(value - left),
    b = Math.abs(value - up),
    c = Math.abs(value - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}
