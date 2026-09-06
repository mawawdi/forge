import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import { assertCreatorRequestArtifact } from "../packages/creator-session/src/index.js";
import { assertCreatorTransactionControlAction } from "../packages/creator-session/src/coordinator.js";
import { createAgentExecutionSlot } from "../packages/agent-runtime/src/index.js";
import {
  assertCreatorVisualObservations,
  creatorVisualModelImages,
  creatorVisualPrompt,
  creatorVisualSubmissionFromObservations,
  sealCreatorVisualObservations,
} from "../packages/creator-session/src/visual-context.js";
import type { VisualObservationInput } from "../packages/visual-evidence/src/contracts.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const revision = "a".repeat(64);
const reference: VisualObservationInput = {
  kind: "reference",
  caption: "Warm reference",
  image: { mimeType: "image/png", base64: png },
};

test("creator image submission binds a captured project and resolves each exact authored view", () => {
  const observations = sealCreatorVisualObservations(
    [
      reference,
      { ...reference, kind: "rendered_view", viewId: "entry", state: "Menu open" },
      { ...reference, kind: "rendered_view", viewId: "detail" },
    ],
    {
      expectedRevisionHash: revision,
      plan: { hash: "b".repeat(64), buildHash: "c".repeat(64), viewIds: ["entry", "detail"] },
    },
    "project",
    revision,
  );
  assert.deepEqual(observations[0]!.binding, { projectId: "project", revisionHash: revision });
  assert.equal(observations[1]!.binding.viewId, "entry");
  assert.equal(observations[2]!.binding.viewId, "detail");
  assert.equal(observations[1]!.binding.buildHash, "c".repeat(64));
  assert.deepEqual(
    creatorVisualModelImages(observations).map((image) => image.base64),
    [png, png, png],
  );
  assertCreatorVisualObservations(observations, {
    projectId: "project",
    initialRevisionHash: revision,
  });
  const prompt = creatorVisualPrompt(observations);
  assert.match(prompt, /not authoritative Studio verification/);
  assert.match(prompt, /Menu open/);
  assert.ok(!prompt.includes(png), "Image bytes stay out of serialized text context");
});

test("stale, foreign and unapproved view submissions cannot become current session evidence", () => {
  assert.throws(
    () =>
      sealCreatorVisualObservations(
        [reference],
        { expectedProjectId: "other" },
        "project",
        revision,
      ),
    /paired project changed/,
  );
  assert.throws(
    () =>
      sealCreatorVisualObservations(
        [reference],
        { expectedRevisionHash: "b".repeat(64) },
        "project",
        revision,
      ),
    /project changed/,
  );
  assert.throws(
    () =>
      sealCreatorVisualObservations(
        [{ ...reference, kind: "rendered_view", viewId: "invented" }],
        { plan: { hash: "b".repeat(64), viewIds: ["entry"] } },
        "project",
        revision,
      ),
    /exact submitted plan/,
  );
  const observations = sealCreatorVisualObservations([reference], {}, "project", revision);
  assert.throws(
    () =>
      assertCreatorVisualObservations(observations, {
        projectId: "other",
        initialRevisionHash: revision,
      }),
    /does not bind/,
  );
  assert.throws(
    () =>
      assertCreatorVisualObservations(observations, {
        projectId: "project",
        initialRevisionHash: "b".repeat(64),
      }),
    /does not bind/,
  );
});

test("natural image references keep internal labels separate from creator language and capture bindings", () => {
  const observations = sealCreatorVisualObservations(
    [reference, { ...reference, caption: "current-entrance.png" }],
    { plan: { hash: "b".repeat(64), viewIds: ["entrance"] } },
    "project",
    revision,
  );
  const original = structuredClone(observations);
  const prompt = creatorVisualPrompt(observations);
  const metadata = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(
    metadata.map((item) => item.imageReference),
    ["Image 1", "Image 2"],
  );
  assert.deepEqual(
    metadata.map((item) => item.caption),
    ["Warm reference", "current-entrance.png"],
  );
  assert.deepEqual(
    metadata.map((item) => item.binding),
    [
      { projectId: "project", revisionHash: revision },
      { projectId: "project", revisionHash: revision },
    ],
  );
  assert.match(prompt, /accompanying message supplies the request and context/);
  assert.match(
    prompt,
    /With one image, understand "the image", "this", or an implicit visual reference/,
  );
  assert.match(prompt, /With multiple images, match descriptions of visible content/);
  assert.match(prompt, /Refer to images by their visible content in replies/);
  assert.match(prompt, /internal correspondence aids, not required creator syntax/);
  assert.match(prompt, /Use image numbers or filenames in replies only when the creator uses them/);
  assert.match(
    prompt,
    /Do not require the creator to identify an attachment merely because no number or name was supplied/,
  );
  assert.match(prompt, /remaining ambiguity would materially change the work/);
  assert.match(prompt, /regions, arrows, and coordinate hints/);
  assert.match(prompt, /inferred associations as hypotheses/);
  assert.match(prompt, /resolve actual edit targets through project or source inspection/);
  assert.match(prompt, /not an independent instruction or permission/);
  assert.match(prompt, /their presence does not authorize unrelated changes/);
  assert.match(prompt, /coordinate hints are approximate/);
  assert.ok(metadata.every((item) => !Object.hasOwn(item, "viewId")));
  assert.deepEqual(observations, original);
  assert.equal(creatorVisualPrompt([]), "");
});

test("retry reconstructs the exact original images and plan context, and cannot rebind to an edited project", () => {
  const rendered = {
    ...reference,
    kind: "rendered_view" as const,
    viewId: "entry",
    state: "Menu open",
  };
  const context = {
    expectedProjectId: "project",
    expectedRevisionHash: revision,
    plan: { hash: "b".repeat(64), buildHash: "c".repeat(64), viewIds: ["entry"] },
  };
  const observations = sealCreatorVisualObservations(
    [reference, rendered],
    context,
    "project",
    revision,
  );
  const replay = creatorVisualSubmissionFromObservations(observations, {
    projectId: "project",
    initialRevisionHash: revision,
  });
  assert.deepEqual(replay.visualObservations, [reference, rendered]);
  assert.deepEqual(replay.visualContext, context);
  assert.deepEqual(
    sealCreatorVisualObservations(
      replay.visualObservations,
      replay.visualContext,
      "project",
      revision,
    ),
    observations,
  );
  assert.throws(
    () =>
      sealCreatorVisualObservations(
        replay.visualObservations,
        replay.visualContext,
        "project",
        "d".repeat(64),
      ),
    /project changed/,
  );
});

test("the real transaction start contract preserves pixels and host context without interpreting image text", () => {
  const action = assertCreatorTransactionControlAction({
    action: "start",
    creatorText: "Improve the scene",
    agentPrompt: "Improve the scene",
    model: "openai/gpt-5.6-luna",
    creatorSessionId: "creator_session_visual",
    contextCitations: [],
    agentExecutions: [createAgentExecutionSlot({ purpose: "planner", ordinal: 1 })],
    visualObservations: [reference],
    visualContext: { expectedRevisionHash: revision },
  });
  assert.equal(action.action, "start");
  if (action.action !== "start") throw new Error("Expected start");
  assert.deepEqual(action.visualObservations, [reference]);
  assert.equal(action.visualContext?.expectedRevisionHash, revision);
  assert.notEqual(action.visualObservations?.[0], reference);
  assert.throws(() =>
    assertCreatorTransactionControlAction({
      ...action,
      visualObservations: [{ ...reference, image: { ...reference.image, base64: "AAAA" } }],
    }),
  );
  assert.throws(() =>
    assertCreatorTransactionControlAction({
      ...action,
      visualContext: { expectedRevisionHash: "wrong" },
    }),
  );
});

test("durable creator request validation rechecks image bytes, provenance and measurements", () => {
  const request = {
    kind: "CreatorRequest",
    sessionId: "creator_session_visual",
    promptHash: contentHash("Improve the scene"),
    creatorText: "Improve the scene",
    agentPrompt: "Improve the scene",
    contextCitations: [],
    visualObservations: sealCreatorVisualObservations([reference], {}, "project", revision),
  };
  assertCreatorRequestArtifact(request);
  const corrupt = structuredClone(request);
  corrupt.visualObservations[0]!.image.width = 2;
  assert.throws(() => assertCreatorRequestArtifact(corrupt));
  assert.throws(() => assertCreatorRequestArtifact({ ...request, visualObservations: {} }));
});
