import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { createBackendMessage } from "../packages/studio-bridge/src/index.js";
import {
  CreatorProjectIdentityJobStore,
  creatorWorkRequestHash,
} from "../packages/creator-conversation/src/index.js";
import {
  createStudioProjectIdentityFinalizationReceipt,
  createStudioProjectIdentityOperation,
  createStudioProjectIdentityState,
  type PluginProjectIdentity,
  type StudioCommandSettledPayload,
} from "../packages/studio-protocol/src/index.js";

const now = "2026-09-03T10:00:00.000Z";
const later = "2026-09-03T10:00:01.000Z";
const project: PluginProjectIdentity = {
  placeId: 0,
  universeId: 0,
  name: "Identity Journal",
};
const before = createStudioProjectIdentityState({
  project,
  reservedAttribute: { status: "absent" },
});
const operation = createStudioProjectIdentityOperation({
  action: "link",
  project,
  connectorEpoch: "1".repeat(64),
  expectedIdentity: before,
  assignedForgeProjectId: `forge_project_${"2".repeat(32)}`,
});
const request = {
  kind: "CreatorActionRequest" as const,
  conversationId: `pairing_${before.hash.slice(0, 24)}`,
  viewId: "creator_control_identity",
  viewHash: "3".repeat(64),
  actionInstanceId: "creator_action_link",
  idempotencyKey: "identity-job-idempotency-0001",
};

async function admit(store: CreatorProjectIdentityJobStore) {
  const admittedRequest = await store.artifactStore.write(request);
  const operationArtifact = await store.artifactStore.write(operation);
  return store.admit({
    id: "creator_identity_job_1",
    provisionalConversationId: request.conversationId,
    pairedStudioSessionId: "studio_identity_job_1",
    idempotencyKey: request.idempotencyKey,
    requestHash: creatorWorkRequestHash(request),
    admittedRequest,
    command: "link",
    executionMode: "initial",
    operation: { id: operation.id, hash: operation.hash, artifact: operationArtifact },
    connectorEpoch: operation.connectorEpoch,
    expectedIdentityStateHash: before.hash,
    assignedForgeProjectId: operation.assignedForgeProjectId,
    status: "queued",
    phase: "admitted",
    createdAt: now,
    updatedAt: now,
  });
}

test("identity jobs publish immutable crash boundaries before their atomic head", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-identity-job-"));
  const store = new CreatorProjectIdentityJobStore(directory);
  const initial = await admit(store);
  assert.equal(initial.job.status, "queued");
  assert.equal(initial.history.length, 1);

  const running = await store.transition(initial.job.id, {
    status: "running",
    phase: "dispatch_intent_persisted",
    updatedAt: later,
  });
  assert.equal(running.history.length, 2);
  assert.equal(running.job.previousSnapshotHash, initial.job.hash);
  assert.deepEqual((await store.enumerate()).jobs[0]!.history, running.history);

  const headPath = join(directory, "identity-jobs", `${initial.job.id}.head.json`);
  const mode = (await import("node:fs/promises")).stat(headPath).then((info) => info.mode & 0o777);
  assert.equal(await mode, 0o600);
  assert.match(await readFile(headPath, "utf8"), /CreatorProjectIdentityJobHead/);
});

test("identity jobs retain exact receipt and result bindings through acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-identity-job-"));
  const store = new CreatorProjectIdentityJobStore(directory);
  const initial = await admit(store);
  const running = await store.transition(initial.job.id, {
    status: "running",
    phase: "dispatch_intent_persisted",
    updatedAt: later,
  });
  const after = createStudioProjectIdentityState({
    project,
    reservedAttribute: {
      status: "observed",
      forgeProjectId: operation.assignedForgeProjectId,
    },
  });
  const receipt = createStudioProjectIdentityFinalizationReceipt({
    operation,
    beforeIdentity: before,
    afterIdentity: after,
    recordingId: "identity-job-recording",
    finalization: "ordinary",
    status: "linked",
    completedAt: later,
  });
  const receiptArtifact = await store.artifactStore.write(receipt);
  const receiptBinding = { id: receipt.id, hash: receipt.hash, artifact: receiptArtifact };
  await store.transition(running.job.id, {
    status: "awaiting_external",
    phase: "receipt_persisted",
    receipt: receiptBinding,
    updatedAt: later,
  });
  await store.transition(running.job.id, {
    status: "awaiting_external",
    phase: "conversation_published",
    receipt: receiptBinding,
    resultConversationId: "creator_conversation_identity",
    updatedAt: later,
  });
  await store.transition(running.job.id, {
    status: "awaiting_external",
    phase: "acknowledgement_pending",
    receipt: receiptBinding,
    resultConversationId: "creator_conversation_identity",
    updatedAt: later,
  });
  const terminal = await store.transition(running.job.id, {
    status: "succeeded",
    phase: "acknowledged",
    receipt: receiptBinding,
    resultConversationId: "creator_conversation_identity",
    updatedAt: later,
  });
  assert.equal(terminal.job.status, "succeeded");
  assert.equal(terminal.history.length, 6);
  assert.equal(terminal.job.receipt!.hash, receipt.hash);
  assert.equal(terminal.job.resultConversationId, "creator_conversation_identity");
});

test("successful identity jobs cannot skip conversation publication or acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-identity-job-boundaries-"));
  const store = new CreatorProjectIdentityJobStore(directory);
  const initial = await admit(store);
  const running = await store.transition(initial.job.id, {
    status: "running",
    phase: "dispatch_intent_persisted",
    updatedAt: later,
  });
  const after = createStudioProjectIdentityState({
    project,
    reservedAttribute: {
      status: "observed",
      forgeProjectId: operation.assignedForgeProjectId,
    },
  });
  const receipt = createStudioProjectIdentityFinalizationReceipt({
    operation,
    beforeIdentity: before,
    afterIdentity: after,
    recordingId: "identity-boundary-recording",
    finalization: "ordinary",
    status: "linked",
    completedAt: later,
  });
  const artifact = await store.artifactStore.write(receipt);
  const binding = { id: receipt.id, hash: receipt.hash, artifact };
  await store.transition(running.job.id, {
    status: "awaiting_external",
    phase: "receipt_persisted",
    receipt: binding,
    updatedAt: later,
  });
  await assert.rejects(
    store.transition(running.job.id, {
      status: "awaiting_external",
      phase: "acknowledgement_pending",
      receipt: binding,
      resultConversationId: "creator_conversation_skipped",
      updatedAt: later,
    }),
    /skipped a durable publication boundary/,
  );
  await assert.rejects(
    store.transition(running.job.id, {
      status: "awaiting_external",
      phase: "conversation_published",
      receipt: binding,
      updatedAt: later,
    }),
    /lacks its result conversation/,
  );
});

test("identity-job head publication is fail-closed and a symlink head is rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-identity-job-"));
  let fail = true;
  const injected = new CreatorProjectIdentityJobStore(directory, {
    beforePublishHead: () => {
      if (fail) throw new Error("injected head failure");
    },
  });
  await assert.rejects(admit(injected), /injected head failure/);
  assert.equal((await injected.enumerate()).jobs.length, 0);

  fail = false;
  const admitted = await admit(injected);
  const head = join(directory, "identity-jobs", `${admitted.job.id}.head.json`);
  await chmod(head, 0o600);
  const replacement = join(directory, "identity-jobs", "replacement.json");
  await chmod(head, 0o600);
  await (await import("node:fs/promises")).rename(head, replacement);
  await symlink(replacement, head);
  await assert.rejects(injected.load(admitted.job.id), /symbolic link|ELOOP|regular file/i);
});

test("identity failures require readable evidence and exact no-effect classification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-identity-job-rejection-"));
  const store = new CreatorProjectIdentityJobStore(directory);
  const initial = await admit(store);
  await store.transition(initial.job.id, {
    status: "running",
    phase: "dispatch_intent_persisted",
    updatedAt: later,
  });
  const command = createBackendMessage(
    "LinkStudioProject",
    {
      requestId: operation.id,
      operation,
      operationHash: operation.hash,
    },
    initial.job.pairedStudioSessionId,
    operation.id,
  );
  const settlement: Extract<StudioCommandSettledPayload, { disposition: "rejected" }> = {
    commandMessageId: command.messageId,
    commandHash: contentHash(stableJson(command)),
    disposition: "rejected",
    classification: "STUDIO_FAILURE",
    detail: "exact rejection reason",
    identityRejection: {
      kind: "StudioProjectIdentityRejectionEvidence",
      operationId: operation.id,
      operationHash: operation.hash,
      status: "observed",
      identity: before,
      transaction: { status: "none" },
      recordingState: "not_open",
    },
  };
  const failure = {
    code: "studio_identity_rejected",
    detail: settlement.detail,
    detailHash: contentHash(settlement.detail),
    rejection: { command, settlement },
  };
  await assert.rejects(
    store.transition(initial.job.id, {
      status: "failed",
      phase: "command_rejected",
      updatedAt: later,
      failure: { ...failure, detail: "changed without updating its hash" },
    }),
    /bounded readable detail/,
  );
  await assert.rejects(
    store.transition(initial.job.id, {
      status: "failed",
      phase: "command_rejected",
      updatedAt: later,
      failure: {
        ...failure,
        rejection: { command, settlement: { ...settlement, commandMessageId: "another-command" } },
      },
    }),
    /exact dispatched operation/,
  );
  await assert.rejects(
    store.transition(initial.job.id, {
      status: "outcome_unknown",
      phase: "studio_outcome_unknown",
      updatedAt: later,
      failure,
    }),
    /contradicts its Studio evidence/,
  );
  await assert.rejects(
    store.transition(initial.job.id, {
      status: "failed",
      phase: "command_rejected",
      updatedAt: later,
      failure: {
        ...failure,
        rejection: {
          command,
          settlement: {
            ...settlement,
            identityRejection: {
              ...settlement.identityRejection!,
              status: "observed",
              identity: before,
              transaction: { status: "none" },
              recordingState: "unknown",
            },
          },
        },
      },
    }),
    /contradicts its Studio evidence/,
  );
  const saved = await store.transition(initial.job.id, {
    status: "failed",
    phase: "command_rejected",
    updatedAt: later,
    failure,
  });
  assert.deepEqual((await store.load(initial.job.id)).job.failure, saved.job.failure);
});
