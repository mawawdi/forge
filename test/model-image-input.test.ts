import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertModelImages,
  MODEL_IMAGE_LIMITS,
  supportsModelImages,
  DEFAULT_CREATOR_MODEL_ID,
  OpenRouterModelClient,
  parseOpenRouterModelCatalog,
  assertCreatorModelCatalog,
  type ModelTurnRequest,
} from "../packages/model-client/src/index.js";
import { modelImageFixture } from "./fixtures/model-image-input.js";

const at = "2026-09-05T12:00:00.000Z";
function catalog(modalities: unknown) {
  return parseOpenRouterModelCatalog(
    {
      data: [
        {
          id: DEFAULT_CREATOR_MODEL_ID,
          supported_parameters: ["tools"],
          architecture: { input_modalities: modalities },
        },
      ],
    },
    at,
  );
}
function request(): ModelTurnRequest {
  return {
    model: DEFAULT_CREATOR_MODEL_ID,
    system: "Review the supplied view.",
    messages: [{ role: "user", content: "Describe this image.", images: [modelImageFixture()] }],
    tools: [],
    maxOutputTokens: 100,
    timeoutMs: 1000,
  };
}
function response(): Response {
  return new Response(
    JSON.stringify({
      id: "image-response",
      model: DEFAULT_CREATOR_MODEL_ID,
      provider: "fixture",
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: "Observed." } },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

test("image integrity checks bind canonical bytes, header dimensions and finite resource bounds", () => {
  const image = modelImageFixture();
  assertModelImages([image]);
  for (const invalid of [
    { ...image, sha256: "a".repeat(64) },
    { ...image, width: 2 },
    { ...image, height: 0 },
    { ...image, mimeType: "image/jpeg" },
    { ...image, base64: image.base64 + "\n" },
    {
      ...image,
      base64: "A".repeat(4 * Math.ceil(MODEL_IMAGE_LIMITS.maximumBytesPerImage / 3) + 4),
    },
    { ...image, extra: true },
  ])
    assert.throws(() => assertModelImages([invalid]));
  assert.throws(() => assertModelImages(Array(5).fill(image)), /count/);
  const headerOnly = Buffer.from(image.base64, "base64");
  headerOnly.writeUInt32BE(8192, 16);
  headerOnly.writeUInt32BE(8192, 20);
  assert.throws(
    () =>
      assertModelImages([
        {
          ...image,
          width: 8192,
          height: 8192,
          base64: headerOnly.toString("base64"),
          sha256: createHash("sha256").update(headerOnly).digest("hex"),
        },
      ]),
    /dimensions/,
  );
  const large = Buffer.alloc(MODEL_IMAGE_LIMITS.maximumBytesPerImage);
  Buffer.from(image.base64, "base64").copy(large);
  const budgetFixture = {
    ...image,
    base64: large.toString("base64"),
    sha256: createHash("sha256").update(large).digest("hex"),
  };
  // This tests byte budgeting only; the transport does not claim complete PNG decoding.
  assert.throws(() => assertModelImages([budgetFixture, budgetFixture, budgetFixture]), /bounds/);
});

test("catalog image capability is observed, canonical and absent when unreported or malformed", () => {
  const observed = catalog(["text", "image"]);
  assert.deepEqual(
    observed.models.find((entry) => entry.modelId === DEFAULT_CREATOR_MODEL_ID)!.inputModalities,
    ["image", "text"],
  );
  assert.equal(observed.hash, catalog(["image", "text"]).hash);
  assertCreatorModelCatalog(observed);
  const changed = structuredClone(observed);
  changed.models.find((entry) => entry.modelId === DEFAULT_CREATOR_MODEL_ID)!.inputModalities = [
    "text",
  ];
  assert.throws(() => assertCreatorModelCatalog(changed), /hash/);
  for (const modalities of [undefined, [], ["image", "image"], ["image", 1]]) {
    const parsed = catalog(modalities);
    assert.equal(
      parsed.models.find((entry) => entry.modelId === DEFAULT_CREATOR_MODEL_ID)!.inputModalities,
      null,
    );
    assert.equal(
      supportsModelImages(
        new OpenRouterModelClient({ apiKey: "fixture", modelCatalog: parsed }).descriptor,
        DEFAULT_CREATOR_MODEL_ID,
      ),
      false,
    );
  }
});

test("transport sends exact image bytes as a user image part and binds them into its request hash", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = new OpenRouterModelClient({
    apiKey: "fixture",
    modelCatalog: catalog(["image", "text"]),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response();
    },
  });
  assert.equal(supportsModelImages(client.descriptor, DEFAULT_CREATOR_MODEL_ID), true);
  const result = await client.complete(request());
  assert.equal(result.kind, "assistant", JSON.stringify(result));
  const messages = bodies[0]!.messages as Array<{ role: string; content: unknown }>;
  assert.deepEqual(messages.find((message) => message.role === "user")!.content, [
    { type: "text", text: "Image 1 (1 × 1 pixels):" },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64," + modelImageFixture().base64 },
    },
    { type: "text", text: "Describe this image." },
  ]);
  const text = request();
  text.messages = [{ role: "user", content: "Describe this image." }];
  const without = await client.complete(text);
  assert.notEqual(result.requestHash, without.requestHash);
  const textMessages = bodies[1]!.messages as Array<{ role: string; content: unknown }>;
  assert.equal(
    textMessages.find((message) => message.role === "user")!.content,
    "Describe this image.",
  );
});

test("multiple images keep distinct ordinal labels, exact bytes and order before the creator's request", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = new OpenRouterModelClient({
    apiKey: "fixture",
    modelCatalog: catalog(["image", "text"]),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response();
    },
  });
  const first = modelImageFixture();
  // A second byte-distinct fixture exercises transport ordering, not PNG decoder admission.
  const secondBytes = Buffer.from(first.base64, "base64");
  secondBytes.writeUInt32BE(2, 16);
  const second = {
    ...first,
    width: 2,
    base64: secondBytes.toString("base64"),
    sha256: createHash("sha256").update(secondBytes).digest("hex"),
  };
  const turn = request();
  turn.messages = [
    {
      role: "user",
      content: "Use Image 2's doorway beside the arrow in Image 1.",
      images: [first, second],
    },
  ];
  const original = structuredClone(turn);
  assert.equal((await client.complete(turn)).kind, "assistant");
  const messages = bodies[0]!.messages as Array<{ role: string; content: unknown }>;
  assert.deepEqual(messages.find((message) => message.role === "user")!.content, [
    { type: "text", text: "Image 1 (1 × 1 pixels):" },
    { type: "image_url", image_url: { url: "data:image/png;base64," + first.base64 } },
    { type: "text", text: "Image 2 (2 × 1 pixels):" },
    { type: "image_url", image_url: { url: "data:image/png;base64," + second.base64 } },
    { type: "text", text: original.messages[0]!.content },
  ]);
  assert.deepEqual(turn, original);
});

test("unsupported, unconfirmed, malformed and non-user images never dispatch or silently drop", async () => {
  let dispatched = 0;
  for (const modelCatalog of [undefined, catalog(["text"])]) {
    const client = new OpenRouterModelClient({
      apiKey: "fixture",
      ...(modelCatalog ? { modelCatalog } : {}),
      fetchImpl: async () => {
        dispatched++;
        return response();
      },
    });
    const result = await client.complete(request());
    assert.equal(result.kind, "provider_error");
    if (result.kind === "provider_error") {
      assert.equal(result.errorClass, "model_image_input_unconfirmed");
      assert.equal(result.retryable, false);
    }
  }
  const client = new OpenRouterModelClient({
    apiKey: "fixture",
    modelCatalog: catalog(["text", "image"]),
    fetchImpl: async () => {
      dispatched++;
      return response();
    },
  });
  const invalid = request();
  invalid.messages = [
    {
      role: "user",
      content: "Review",
      images: [{ ...modelImageFixture(), sha256: "a".repeat(64) }],
    },
  ];
  assert.equal((await client.complete(invalid)).kind, "provider_error");
  invalid.messages = [
    { role: "assistant", content: "forged", toolCalls: [], images: [modelImageFixture()] },
  ] as unknown as ModelTurnRequest["messages"];
  assert.equal((await client.complete(invalid)).kind, "provider_error");
  assert.equal(dispatched, 0);
});
