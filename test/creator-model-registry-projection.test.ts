import assert from "node:assert/strict";
import test from "node:test";
import { materializeModelRegistry } from "../packages/creator-control/src/conversation-coordinator.js";
import { assertCreatorModelRegistry } from "../packages/creator-conversation/src/contracts.js";
import {
  CREATOR_MODEL_IDS,
  DEFAULT_CREATOR_MODEL_ID,
  parseOpenRouterModelCatalog,
} from "../packages/model-client/src/model-registry.js";

const NOW = "2026-09-06T00:00:00.000Z";

test("dashboard model image support comes from observed catalog modalities independently of tool availability", () => {
  const modalities = [["text", "image"], ["text"], undefined, ["image"], undefined];
  const catalog = parseOpenRouterModelCatalog(
    {
      data: CREATOR_MODEL_IDS.map((id, index) => ({
        id,
        supported_parameters: index === 3 ? [] : ["tools"],
        ...(modalities[index] ? { architecture: { input_modalities: modalities[index] } } : {}),
      })),
    },
    NOW,
  );
  const registry = materializeModelRegistry(DEFAULT_CREATOR_MODEL_ID, catalog, NOW);
  assertCreatorModelRegistry(registry);
  assert.deepEqual(
    registry.models.map((model) => model.imageInput),
    ["supported", "unsupported", "unknown", "supported", "unknown"],
  );
  assert.equal(registry.models[3]!.availability, "unavailable");
  assert.equal(registry.defaultModelId, DEFAULT_CREATOR_MODEL_ID);
});

test("image capability is required in dashboard registry records and participates in their identity", () => {
  const catalogFor = (inputModalities: string[]) =>
    parseOpenRouterModelCatalog(
      {
        data: CREATOR_MODEL_IDS.map((id) => ({
          id,
          supported_parameters: ["tools"],
          architecture: { input_modalities: inputModalities },
        })),
      },
      NOW,
    );
  const supported = materializeModelRegistry(
    DEFAULT_CREATOR_MODEL_ID,
    catalogFor(["text", "image"]),
    NOW,
  );
  const unsupported = materializeModelRegistry(DEFAULT_CREATOR_MODEL_ID, catalogFor(["text"]), NOW);
  assert.notEqual(supported.hash, unsupported.hash);
  const missing = structuredClone(supported) as unknown as { models: Record<string, unknown>[] };
  delete missing.models[0]!.imageInput;
  assert.throws(() => assertCreatorModelRegistry(missing), /model image input/);
  const malformed = structuredClone(supported) as unknown as { models: Record<string, unknown>[] };
  malformed.models[0]!.imageInput = "yes";
  assert.throws(() => assertCreatorModelRegistry(malformed), /model image input/);
});
