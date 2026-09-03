import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATOR_MODEL_IDS,
  CREATOR_MODEL_REGISTRY,
  DEFAULT_CREATOR_MODEL_ID,
  OpenRouterModelCatalogProbe,
  assertCreatorModelCatalog,
  assertCreatorModelRegistry,
  parseOpenRouterModelCatalog,
  resolveCreatorModelSelection,
} from "../packages/model-client/src/index.js";

const CHECKED_AT = "2026-09-03T08:00:00.000Z";

test("creator model registry is canonical, complete, and Luna-default", () => {
  assert.equal(DEFAULT_CREATOR_MODEL_ID, "openai/gpt-5.6-luna");
  assert.deepEqual(
    CREATOR_MODEL_REGISTRY.models.map((model) => model.id),
    [...CREATOR_MODEL_IDS],
  );
  assertCreatorModelRegistry(CREATOR_MODEL_REGISTRY);
  assert.throws(
    () =>
      assertCreatorModelRegistry({
        ...CREATOR_MODEL_REGISTRY,
        defaultModelId: CREATOR_MODEL_IDS[0],
      }),
    /default or coverage/,
  );
});

test("catalog parsing distinguishes confirmed, unavailable, and unconfirmed models", () => {
  const catalog = parseOpenRouterModelCatalog(
    {
      data: [
        { id: CREATOR_MODEL_IDS[0], supported_parameters: ["tools", "tool_choice"] },
        { id: CREATOR_MODEL_IDS[1], supported_parameters: ["temperature"] },
        { id: CREATOR_MODEL_IDS[2] },
      ],
    },
    CHECKED_AT,
  );
  assertCreatorModelCatalog(catalog);
  assert.deepEqual(
    catalog.models.map(({ modelId, status, reason }) => ({ modelId, status, reason })),
    [
      {
        modelId: CREATOR_MODEL_IDS[0],
        status: "available",
        reason: "catalog_confirmed",
      },
      {
        modelId: CREATOR_MODEL_IDS[1],
        status: "unavailable",
        reason: "tools_not_supported",
      },
      {
        modelId: CREATOR_MODEL_IDS[2],
        status: "unconfirmed",
        reason: "tool_support_not_reported",
      },
      {
        modelId: CREATOR_MODEL_IDS[3],
        status: "unavailable",
        reason: "model_not_listed",
      },
    ],
  );
  assert.equal(
    resolveCreatorModelSelection(CREATOR_MODEL_IDS[0], catalog).availability,
    "available",
  );
  assert.equal(
    resolveCreatorModelSelection("openai/not-allowlisted", catalog).reason,
    "model_not_allowlisted",
  );
  assert.equal(resolveCreatorModelSelection(DEFAULT_CREATOR_MODEL_ID).availability, "unconfirmed");

  const tampered = structuredClone(catalog);
  tampered.models[0]!.status = "unavailable";
  assert.throws(() => assertCreatorModelCatalog(tampered), /coverage or order|hash/);
});

test("metadata probe performs one bounded GET and never substitutes another model", async () => {
  const requests: Array<{ url: string; method: string | undefined; authorization: string | null }> =
    [];
  const probe = new OpenRouterModelCatalogProbe({
    apiKey: "catalog-secret",
    now: () => new Date(CHECKED_AT),
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(
        JSON.stringify({
          data: CREATOR_MODEL_IDS.map((id) => ({ id, supported_parameters: ["tools"] })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const catalog = await probe.probe();
  assert.deepEqual(requests, [
    {
      url: "https://openrouter.ai/api/v1/models",
      method: "GET",
      authorization: "Bearer catalog-secret",
    },
  ]);
  assert.ok(catalog.models.every((model) => model.status === "available"));
  assert.equal(
    resolveCreatorModelSelection(CREATOR_MODEL_IDS[2], catalog).requestedModel,
    CREATOR_MODEL_IDS[2],
  );
});

test("catalog transport and malformed payload failures remain unconfirmed", async () => {
  const failed = await new OpenRouterModelCatalogProbe({
    now: () => new Date(CHECKED_AT),
    fetchImpl: async () => new Response("rate limited", { status: 429 }),
  }).probe();
  assert.ok(
    failed.models.every(
      (model) => model.status === "unconfirmed" && model.reason === "catalog_http_429",
    ),
  );

  const malformed = await new OpenRouterModelCatalogProbe({
    now: () => new Date(CHECKED_AT),
    fetchImpl: async () =>
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
  }).probe();
  assert.ok(
    malformed.models.every(
      (model) => model.status === "unconfirmed" && model.reason === "catalog_response_invalid",
    ),
  );
});
