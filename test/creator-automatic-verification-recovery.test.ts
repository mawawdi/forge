import assert from "node:assert/strict";
import test from "node:test";
import { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import {
  advanceSession,
  createCreatorSession,
  createStudioOwnershipMap,
  type CreatorProjectIndexView,
  type CreatorSessionBundle,
  type CreatorSessionStatus,
} from "../packages/creator-session/src/index.js";

const project = { name: "Automatic verification recovery", placeId: 711, universeId: 712 };
const projectId = "studio_project_automatic_verification_recovery";
const revisionHash = "a".repeat(64);
const captureHash = "b".repeat(64);
const attemptId = "creator_mutation_attempt_automatic_verification_recovery";
const recordingId = "recording_automatic_verification_recovery";

interface AutomaticRecoveryHarness {
  bundles: Map<string, CreatorSessionBundle>;
  pendingRecordings: Map<string, { attemptId: string; recordingId: string }>;
  inFlight: Set<string>;
  automaticVerifications: Set<string>;
  verify(bundle: CreatorSessionBundle): Promise<unknown>;
  persist(bundle: CreatorSessionBundle): Promise<CreatorSessionBundle>;
  publishView(bundle: CreatorSessionBundle, detail: string): Promise<void>;
  recoverAutomaticVerificationFailure(sessionId: string, error: unknown): Promise<void>;
  scheduleAutomaticVerification(sessionId: string): void;
}

function sessionAt(status: "awaiting_verification" | "verifying" | "committing" | "cancelling") {
  const observation: CreatorProjectIndexView = {
    project,
    revision: { hash: revisionHash } as CreatorProjectIndexView["revision"],
    instances: [],
    scripts: [],
  };
  const ownership = createStudioOwnershipMap({
    projectId,
    revisionHash,
    projectIndex: observation,
  });
  let session = createCreatorSession({
    prompt: "Recover a stopped automatic verification.",
    projectId,
    revisionHash,
    projectCaptureHash: captureHash,
    ownership,
    now: new Date("2026-09-02T00:00:00.000Z"),
  });
  const transitions: CreatorSessionStatus[] = [
    "planning",
    "awaiting_plan_approval",
    "building",
    "awaiting_change_approval",
    "preflighting",
    "applying",
    "awaiting_verification",
  ];
  if (status === "verifying" || status === "committing" || status === "cancelling")
    transitions.push("verifying");
  if (status === "committing") transitions.push("committing");
  if (status === "cancelling") transitions.push("cancelling");
  for (const next of transitions) session = advanceSession(session, { status: next });
  return { session, ownership };
}

function harness(input: {
  status: "awaiting_verification" | "verifying" | "committing" | "cancelling";
  coherent?: boolean;
}) {
  const coordinator = Object.create(
    CreatorSessionCoordinator.prototype,
  ) as AutomaticRecoveryHarness;
  const { session, ownership } = sessionAt(input.status);
  const bundle = {
    session,
    ownership,
    activeMutation: {
      attemptId,
      recordingId,
      stage: "provisional",
    },
  } as unknown as CreatorSessionBundle;
  coordinator.bundles = new Map([[session.id, bundle]]);
  coordinator.pendingRecordings = new Map(
    input.coherent === false
      ? [
          [
            session.id,
            { attemptId: `${attemptId}_different`, recordingId: `${recordingId}_different` },
          ],
        ]
      : [[session.id, { attemptId, recordingId }]],
  );
  coordinator.inFlight = new Set();
  coordinator.automaticVerifications = new Set();
  const persisted: CreatorSessionBundle[] = [];
  const published: Array<{ bundle: CreatorSessionBundle; detail: string }> = [];
  coordinator.persist = async (value) => {
    persisted.push(value);
    coordinator.bundles.set(value.session.id, value);
    return value;
  };
  coordinator.publishView = async (value, detail) => {
    published.push({ bundle: value, detail });
  };
  coordinator.verify = async () => undefined;
  return { coordinator, bundle, persisted, published };
}

test("automatic verification leaves an unarmed provisional recording unchanged", async () => {
  const { coordinator, bundle, persisted, published } = harness({
    status: "awaiting_verification",
  });

  await coordinator.recoverAutomaticVerificationFailure(
    bundle.session.id,
    new Error("arm rejected"),
  );

  assert.equal(coordinator.bundles.get(bundle.session.id)?.session.status, "awaiting_verification");
  assert.equal(persisted.length, 0);
  assert.equal(published.length, 1);
  assert.match(published[0]!.detail, /no automatic retry occurred/);
});

test("automatic verification interruptions preserve a coherent recording cursor", async () => {
  for (const status of ["verifying", "committing", "cancelling"] as const) {
    const { coordinator, bundle, persisted, published } = harness({ status });
    const pending = coordinator.pendingRecordings.get(bundle.session.id);

    await coordinator.recoverAutomaticVerificationFailure(
      bundle.session.id,
      new Error(`${status} lost`),
    );

    const recovered = coordinator.bundles.get(bundle.session.id)!;
    assert.equal(recovered.session.status, "recovery_required", status);
    assert.equal(recovered.session.failure?.code, "studio_transaction_interrupted", status);
    assert.equal(recovered.activeMutation, bundle.activeMutation, status);
    assert.equal(coordinator.pendingRecordings.get(bundle.session.id), pending, status);
    assert.equal(persisted.length, 1, status);
    assert.equal(published.length, 1, status);
    assert.match(published[0]!.detail, /did not re-arm, commit, cancel/i, status);
  }
});

test("automatic verification reports an incoherent cursor as recovery-required", async () => {
  const { coordinator, bundle, persisted, published } = harness({
    status: "committing",
    coherent: false,
  });

  await coordinator.recoverAutomaticVerificationFailure(
    bundle.session.id,
    new Error("receipt lost"),
  );

  const recovered = coordinator.bundles.get(bundle.session.id)!;
  assert.equal(recovered.session.status, "recovery_required");
  assert.equal(recovered.session.failure?.code, "verification_transaction_cursor_inconsistent");
  assert.equal(persisted.length, 1);
  assert.equal(published.length, 1);
  assert.match(published[0]!.detail, /lost a coherent exact recording cursor/i);
});

test("the automatic scheduler absorbs recovery persistence failure without rearming", async () => {
  const { coordinator, bundle, published } = harness({ status: "awaiting_verification" });
  let verificationCalls = 0;
  let persistenceCalls = 0;
  coordinator.verify = async (current) => {
    verificationCalls += 1;
    const verifying = {
      ...current,
      session: advanceSession(current.session, { status: "verifying" }),
    };
    coordinator.bundles.set(current.session.id, verifying);
    throw new Error("runtime arm transport failed");
  };
  coordinator.persist = async () => {
    persistenceCalls += 1;
    throw new Error("disk unavailable");
  };

  coordinator.scheduleAutomaticVerification(bundle.session.id);
  const deadline = Date.now() + 1_000;
  while (coordinator.automaticVerifications.has(bundle.session.id)) {
    if (Date.now() >= deadline) throw new Error("automatic scheduler did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(verificationCalls, 1);
  assert.equal(persistenceCalls, 1);
  assert.equal(coordinator.bundles.get(bundle.session.id)?.session.status, "recovery_required");
  assert.equal(coordinator.pendingRecordings.get(bundle.session.id)?.recordingId, recordingId);
  assert.equal(published.length, 1);
  assert.match(published[0]!.detail, /could not persist/i);
});
