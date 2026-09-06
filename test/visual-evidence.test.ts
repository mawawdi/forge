import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  DEFAULT_VISUAL_EVIDENCE_POLICY,
  VISUAL_OBSERVATION_INPUT_SCHEMA,
  assertVisualObservation,
  assertVisualObservations,
  createVisualObservation,
  createVisualObservations,
  inspectVisualPng,
  validateVisualObservationInputs,
  visualObservationModelImage,
  type VisualObservationBinding,
} from "../packages/visual-evidence/src/index.js";

const binding: VisualObservationBinding = { projectId: "project-a", revisionHash: "a".repeat(64) };
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Deliberately independent bitwise CRC implementation for test-owned PNG bytes.
function chunk(name: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const nameBytes = Buffer.from(name, "ascii");
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([nameBytes, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, nameBytes, data, checksum]);
}
function header(width = 1, height = 1, depth = 8, color = 6, interlace = 0): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.writeUInt32BE(width);
  bytes.writeUInt32BE(height, 4);
  bytes[8] = depth;
  bytes[9] = color;
  bytes[12] = interlace;
  return chunk("IHDR", bytes);
}
const idat = (raw: Buffer = Buffer.from([0, 255, 0, 0, 255])) => chunk("IDAT", deflateSync(raw));
const png = (...chunks: Buffer[]) => Buffer.concat([signature, ...chunks]);
const tinyPng = () => png(header(), idat(), chunk("IEND"));
const image = (bytes: Buffer = tinyPng()) => ({
  mimeType: "image/png" as const,
  base64: bytes.toString("base64"),
});
const input = (bytes: Buffer = tinyPng()) => ({
  kind: "reference" as const,
  image: image(bytes),
  caption: "Creator reference, not an engine observation",
});
const inspect = (bytes: Buffer) => inspectVisualPng(image(bytes));
const rehash = <T extends { hash: string }>(value: T) => {
  const { hash: _hash, ...body } = value;
  return { ...body, hash: contentHash(stableJson(body)) };
};

test("visual evidence binds original PNG bytes and submission context with creator-reported authority", () => {
  const compressed = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  const bytes = png(
    header(),
    chunk("tEXt", Buffer.from("Comment\0Original metadata")),
    chunk("IDAT", compressed.subarray(0, 3)),
    chunk("IDAT", compressed.subarray(3)),
    chunk("IEND"),
  );
  const submitted = input(bytes);
  const observation = createVisualObservation(submitted, binding);
  assert.equal(observation.image.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(observation.image.base64, bytes.toString("base64"));
  assert.deepEqual(Buffer.from(observation.image.base64, "base64"), bytes);
  assert.equal(observation.image.width, 1);
  assert.equal(observation.image.height, 1);
  assert.equal(observation.source, "creator_upload");
  assert.equal(observation.evidenceScope, "creator_reported_visual");
  assert.equal(observation.bindingScope, "project_revision_at_submission");
  assert.deepEqual(assertVisualObservation(observation), observation);
  assert.deepEqual(assertVisualObservation(observation, binding), observation);
  assert.deepEqual(visualObservationModelImage(observation, binding), observation.image);
  assert.deepEqual(rehash(observation), observation);
  observation.image.width = 8;
  assert.equal(createVisualObservation(submitted, binding).image.width, 1);
});

test("strict input rejects external images, claimed hashes/native authority and rendered metadata on references", () => {
  for (const changed of [
    { ...input(), source: "studio_native" },
    { ...input(), revisionHash: binding.revisionHash },
    { ...input(), image: { ...image(), sha256: "a".repeat(64) } },
    {
      ...input(),
      image: { mimeType: "image/svg+xml", base64: Buffer.from("<svg/>").toString("base64") },
    },
    { ...input(), image: { url: "https://example.invalid/image.png" } },
    { ...input(), viewId: "claimed-view" },
    { ...input(), state: "claimed-running" },
    { ...input(), nativeVerified: true },
  ])
    assert.throws(() => createVisualObservation(changed, binding));
  assert.equal(
    VISUAL_OBSERVATION_INPUT_SCHEMA.safeParse({
      ...input(),
      kind: "rendered_view",
      state: "paused",
      graphicsSettings: "creator-reported high",
    }).success,
    true,
  );
  assert.throws(() => validateVisualObservationInputs([{ ...input(), caption: "x".repeat(2049) }]));
});

test("rendered views require host-resolved view bindings and preserve declared capture details without native proof", () => {
  const bound = {
    ...binding,
    planHash: "b".repeat(64),
    buildHash: "c".repeat(64),
    viewId: "entry-perspective",
  };
  const rendered = {
    ...input(),
    kind: "rendered_view",
    viewId: bound.viewId,
    state: "Playing as the creator reports",
    graphicsSettings: "Manual 8",
  };
  const observation = createVisualObservation(rendered, bound);
  assert.equal(observation.state, rendered.state);
  assert.equal(observation.viewId, bound.viewId);
  assert.deepEqual(observation.binding, bound);
  assert.equal(observation.evidenceScope, "creator_reported_visual");
  assert.throws(() => createVisualObservation(rendered, binding), /host-bound plan view/);
  assert.throws(
    () => createVisualObservation(rendered, { ...binding, viewId: bound.viewId }),
    /exact plan hash/,
  );
  assert.doesNotThrow(() =>
    createVisualObservation({ ...input(), kind: "rendered_view" }, binding),
  );
});

test("replay rejects stale bindings and rehashed substitutions of image measurements or evidence authority", () => {
  const bound = {
    ...binding,
    planHash: "b".repeat(64),
    buildHash: "c".repeat(64),
    viewId: "view-a",
  };
  const observation = createVisualObservation(
    { ...input(), kind: "rendered_view", viewId: "view-a" },
    bound,
  );
  for (const changed of [
    { ...bound, projectId: "project-b" },
    { ...bound, revisionHash: "d".repeat(64) },
    { ...bound, planHash: "d".repeat(64) },
    { ...bound, buildHash: "d".repeat(64) },
    { ...bound, viewId: "view-b" },
    binding,
  ])
    assert.throws(() => assertVisualObservation(observation, changed));
  for (const changed of [
    { ...observation, image: { ...observation.image, width: 999 } },
    { ...observation, image: { ...observation.image, height: 999 } },
    { ...observation, image: { ...observation.image, sha256: "f".repeat(64) } },
    {
      ...observation,
      image: { ...observation.image, base64: Buffer.from("Not PNG").toString("base64") },
    },
    { ...observation, source: "studio_native" },
    { ...observation, bindingScope: "authoritative_capture_revision" },
  ])
    assert.throws(() => assertVisualObservation(rehash(changed), bound));
  assert.throws(
    () => assertVisualObservation({ ...observation, caption: "Changed description" }, bound),
    /differs/,
  );
  const { bindingScope: _removedScope, ...missingScope } = observation;
  assert.throws(() => assertVisualObservation(missingScope));
});

test("canonical base64 rejects whitespace, alternate padding, data URLs and malformed PNG signatures", () => {
  const base64 = image().base64;
  for (const invalid of [
    base64 + "\n",
    "data:image/png;base64," + base64,
    base64.slice(0, -1),
    "AAAA====",
    "AB==",
    "%%%%",
    "<svg/>",
  ])
    assert.throws(() => inspectVisualPng({ mimeType: "image/png", base64: invalid }));
  const bytes = tinyPng();
  bytes[0] = 0;
  assert.throws(() => inspect(bytes), /signature/);
});

test("PNG checks every CRC, chunk extent, reserved type bit and final trailing bytes", () => {
  const corrupt = tinyPng();
  corrupt[29] = corrupt[29]! ^ 1;
  assert.throws(() => inspect(corrupt), /CRC/);
  assert.throws(() => inspect(tinyPng().subarray(0, -1)), /truncated|length/);
  assert.throws(() => inspect(Buffer.concat([tinyPng(), Buffer.from([0])])), /trailing bytes/);
  const length = tinyPng();
  length.writeUInt32BE(0x7fffffff, 8);
  assert.throws(() => inspect(length), /length/);
  assert.throws(() => inspect(png(header(), chunk("test"), idat(), chunk("IEND"))), /reserved bit/);
});

test("PNG structural ordering rejects missing, duplicate or separated critical chunks", () => {
  const compressed = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  for (const bytes of [
    png(idat(), chunk("IEND")),
    png(header(), idat()),
    png(header(), header(), idat(), chunk("IEND")),
    png(header(), chunk("IEND")),
    png(
      header(),
      chunk("IDAT", compressed.subarray(0, 3)),
      chunk("tEXt", Buffer.from("Key\0Text")),
      chunk("IDAT", compressed.subarray(3)),
      chunk("IEND"),
    ),
    png(header(), idat(), chunk("IEND", Buffer.from([0]))),
    png(
      header(),
      chunk("PLTE", Buffer.from([0, 0, 0])),
      chunk("PLTE", Buffer.from([0, 0, 0])),
      idat(),
      chunk("IEND"),
    ),
  ])
    assert.throws(() => inspect(bytes));
});

test("IHDR constraints reject invalid dimensions, methods, color/depth combinations and decompressed size", () => {
  for (const h of [
    header(0),
    header(8193),
    header(4097, 4097),
    header(1, 1, 4, 6),
    header(1, 1, 8, 1),
    header(1, 1, 8, 6, 2),
  ])
    assert.throws(() => inspect(png(h, idat(), chunk("IEND"))));
  const data = Buffer.from(header().subarray(8, 21));
  data[10] = 1;
  assert.throws(
    () => inspect(png(chunk("IHDR", data), idat(), chunk("IEND"))),
    /method is invalid/,
  );
  assert.throws(
    () => inspectVisualPng(image(), { ...DEFAULT_VISUAL_EVIDENCE_POLICY, maximumInflatedBytes: 4 }),
    /inflation budget/,
  );
});

test("PNG decompression rejects truncated streams, excess scanlines, invalid filters and trailing compressed data", () => {
  const compressed = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  for (const value of [
    compressed.subarray(0, -1),
    Buffer.concat([compressed, Buffer.from([0])]),
    Buffer.concat([compressed, compressed]),
    deflateSync(Buffer.from([0, 255])),
    deflateSync(Buffer.alloc(100000)),
    deflateSync(Buffer.from([5, 0, 0, 0, 0])),
  ])
    assert.throws(
      () => inspect(png(header(), chunk("IDAT", value), chunk("IEND"))),
      /stream|scanline/,
    );
});

test("indexed PNG unfilters pixels and checks palette references, sizes and transparency", () => {
  const palette = chunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255]));
  const bytes = png(
    header(2, 1, 1, 3),
    palette,
    chunk("tRNS", Buffer.from([0, 255])),
    idat(Buffer.from([0, 0b01000000])),
    chunk("IEND"),
  );
  assert.equal(inspect(bytes).width, 2);
  // Sub filter: reconstructed indices [0,1,1], not encoded residuals [0,1,0].
  assert.equal(
    inspect(png(header(3, 1, 8, 3), palette, idat(Buffer.from([1, 0, 1, 0])), chunk("IEND"))).width,
    3,
  );
  for (const invalid of [
    png(header(2, 1, 1, 3), idat(Buffer.from([0, 0])), chunk("IEND")),
    png(
      header(2, 1, 1, 3),
      chunk("PLTE", Buffer.from([0, 0, 0])),
      idat(Buffer.from([0, 0b01000000])),
      chunk("IEND"),
    ),
    png(
      header(2, 1, 1, 3),
      chunk("PLTE", Buffer.alloc(9)),
      idat(Buffer.from([0, 0])),
      chunk("IEND"),
    ),
    png(header(), chunk("tRNS", Buffer.alloc(6)), idat(), chunk("IEND")),
  ])
    assert.throws(() => inspect(invalid), /palette|transparency/);
});

test("Adam7 checks each actual nonempty pass and all five scanline filter types", () => {
  const dimensions = [
    [1, 1],
    [1, 1],
    [2, 1],
    [1, 2],
    [3, 1],
    [2, 3],
    [5, 2],
  ];
  const rows = dimensions.flatMap(([width, height]) =>
    Array.from({ length: height! }, () => Buffer.alloc(width! * 4 + 1)),
  );
  const raw = Buffer.concat(rows);
  assert.equal(inspect(png(header(5, 5, 8, 6, 1), idat(raw), chunk("IEND"))).height, 5);
  assert.throws(
    () => inspect(png(header(5, 5, 8, 6, 1), idat(raw.subarray(1)), chunk("IEND"))),
    /scanline length/,
  );
  for (let filter = 0; filter <= 4; filter++)
    assert.equal(
      inspect(png(header(), idat(Buffer.from([filter, 0, 0, 0, 0])), chunk("IEND"))).width,
      1,
    );
});

test("unsupported animation and metadata fail explicitly; ICC decompression has its own resource bound", () => {
  for (const name of ["acTL", "fcTL", "fdAT", "ABCD", "vpAg"])
    assert.throws(() => inspect(png(header(), chunk(name), idat(), chunk("IEND"))), /not admitted/);
  const profile = chunk(
    "iCCP",
    Buffer.concat([Buffer.from("Profile\0\0"), deflateSync(Buffer.alloc(128))]),
  );
  assert.equal(inspect(png(header(), profile, idat(), chunk("IEND"))).width, 1);
  assert.throws(
    () =>
      inspectVisualPng(image(png(header(), profile, idat(), chunk("IEND"))), {
        ...DEFAULT_VISUAL_EVIDENCE_POLICY,
        maximumAncillaryInflatedBytes: 64,
      }),
    /inflation budget/,
  );
  assert.throws(
    () => inspect(png(header(), profile, chunk("sRGB", Buffer.from([0])), idat(), chunk("IEND"))),
    /sRGB/,
  );
});

test("common screenshot metadata is retained without treating EXIF or textual capture claims as authority", () => {
  const international = chunk(
    "iTXt",
    Buffer.concat([
      Buffer.from("Description\0\x01\0en\0Name\0"),
      deflateSync(Buffer.from("A creator-supplied image ✓")),
    ]),
  );
  const bytes = png(
    header(),
    chunk("cICP", Buffer.from([12, 13, 0, 1])),
    chunk("eXIf", Buffer.from("4d4d002a00000008", "hex")),
    international,
    chunk("iDOT", Buffer.alloc(28)),
    idat(),
    chunk("IEND"),
  );
  const observation = createVisualObservation(input(bytes), binding);
  assert.equal(observation.image.base64, bytes.toString("base64"));
  assert.equal(observation.evidenceScope, "creator_reported_visual");
  const plain = chunk("iTXt", Buffer.from("Description\0\0\0\0\0Plain UTF-8 ✓"));
  assert.equal(inspect(png(header(), plain, idat(), chunk("IEND"))).width, 1);
  assert.throws(
    () =>
      inspect(
        png(
          header(),
          chunk("iTXt", Buffer.from("Description\0\x02\0\0\0bad")),
          idat(),
          chunk("IEND"),
        ),
      ),
    /framing/,
  );
  assert.throws(
    () =>
      inspectVisualPng(image(bytes), {
        ...DEFAULT_VISUAL_EVIDENCE_POLICY,
        maximumAncillaryInflatedBytes: 4,
      }),
    /inflation budget/,
  );
});

test("batch admission enforces image count, aggregate original bytes and per-image limits without a project binding", () => {
  const bytes = tinyPng();
  assert.deepEqual(validateVisualObservationInputs([input(bytes)]), [input(bytes)]);
  assert.deepEqual(createVisualObservations([], binding), []);
  assert.throws(
    () => validateVisualObservationInputs(Array.from({ length: 5 }, () => input())),
    /at most 4/,
  );
  const tight = { ...DEFAULT_VISUAL_EVIDENCE_POLICY, maximumAggregateBytes: bytes.length * 2 - 1 };
  assert.throws(() => validateVisualObservationInputs([input(), input()], tight), /aggregate/);
  const observations = createVisualObservations([input(), input()], binding);
  assert.throws(() => assertVisualObservations(observations, binding, tight), /aggregate/);
  assert.deepEqual(assertVisualObservations(observations, binding), observations);
  assert.throws(
    () =>
      validateVisualObservationInputs([input()], {
        ...DEFAULT_VISUAL_EVIDENCE_POLICY,
        maximumImageBytes: bytes.length - 1,
      }),
    /byte budget/,
  );
  assert.throws(
    () => inspectVisualPng(image(), { ...DEFAULT_VISUAL_EVIDENCE_POLICY, maximumChunks: 2 }),
    /chunk budget/,
  );
  assert.throws(
    () => inspectVisualPng(image(), { ...DEFAULT_VISUAL_EVIDENCE_POLICY, maximumPixels: -1 }),
    /positive bounded/,
  );
});

test("hostile JSON is rejected before getters, proxies or deep recursive schema work", () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "image", {
    enumerable: true,
    get() {
      calls++;
      return image();
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        return [];
      },
      get() {
        calls++;
        return undefined;
      },
      getPrototypeOf() {
        calls++;
        return null;
      },
    },
  );
  assert.throws(() => validateVisualObservationInputs([getter]), /Accessors/);
  assert.throws(() => validateVisualObservationInputs([proxy]), /Proxies/);
  assert.equal(calls, 0);
  let deep: unknown = null;
  for (let depth = 0; depth < 20; depth++) deep = { child: deep };
  assert.throws(() => validateVisualObservationInputs([deep]), /depth/);
  const cycle: unknown[] = [];
  cycle.push(cycle);
  assert.throws(() => validateVisualObservationInputs(cycle), /cycles/);
});

test("upload contracts are browser-safe and expose PNG-only bounded ordinary JSON schemas", async () => {
  const source = await readFile("packages/visual-evidence/src/contracts.ts", "utf8");
  assert.doesNotMatch(source, /node:|from ["']\.\.\//);
  assert.equal(VISUAL_OBSERVATION_INPUT_SCHEMA.safeParse(input()).success, true);
  assert.equal(DEFAULT_VISUAL_EVIDENCE_POLICY.maximumImages, 4);
  assert.equal(DEFAULT_VISUAL_EVIDENCE_POLICY.maximumImageBytes, 4 * 1024 * 1024);
  assert.equal(DEFAULT_VISUAL_EVIDENCE_POLICY.maximumAggregateBytes, 8 * 1024 * 1024);
});
