import assert from "node:assert/strict";
import test from "node:test";
import { safeProviderErrorMessage } from "../packages/model-client/src/provider-error.js";

test("provider error bodies retain message-protocol categories without exposing their prose", () => {
  const secret = "private-source-and-credentials";
  for (const [detail, category] of [
    [
      "Missing reasoning_content in assistant tool call message",
      "reasoning continuation requirement",
    ],
    ["tool_call_id does not match a preceding call", "tool call identifier mismatch"],
    [
      "Messages with role 'tool' must follow a corresponding assistant message",
      "message sequence requirement",
    ],
    ["Request payload too large", "request size limit"],
    ["Malformed JSON in request body", "invalid request JSON"],
  ]) {
    const actual = safeProviderErrorMessage("Request failed.", {
      message: "Provider returned error",
      data: { code: 400 },
      responseBody: JSON.stringify({ error: { message: `${detail}. ${secret}` } }),
    });
    assert.ok(actual.includes(`mentions ${category}`), actual);
    assert.ok(!actual.includes(secret));
    assert.ok(!actual.includes(detail!));
    assert.ok(Buffer.byteLength(actual) <= 500);
  }
});

test("oversized and unknown provider error prose is never copied into diagnostics", () => {
  for (const responseBody of [
    "reasoning_content missing " + "private".repeat(4000),
    JSON.stringify({ error: { message: "Unclassified private response", code: "private_code" } }),
  ]) {
    assert.equal(
      safeProviderErrorMessage("Request failed.", {
        message: "Provider returned error",
        responseBody,
      }),
      "Request failed.",
    );
  }
});
