import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  createStudioEvidenceEnvelope,
  createStudioEvidenceProjection,
  studioEvidenceFactKey,
  type StudioEvidenceFact,
  type StudioManifestProperty,
  type StudioReflectionValue,
} from "../packages/studio-evidence/src/index.js";
import type {
  PluginToBackendMessage,
  StudioCapability,
} from "../packages/studio-protocol/src/index.js";
import type {
  StudioBridgeConnection,
  StudioBridgeSession,
} from "../packages/studio-bridge/src/index.js";
import type { CreatorAgentWorker } from "../packages/creator-session/src/worker.js";

const sentAt = "2026-09-01T00:00:00.000Z";
const project = { name: "Attestation Project", placeId: 71, universeId: 72 };
const capabilities: StudioCapability[] = [
  "studio_evidence",
  "studio_project_index",
  "opaque_identity",
  "project_change_monitor",
  "semantic_message_stream",
  "sha256",
  "stable_identity",
  "reflection_attestation",
  "detached_preflight",
  "transactional_authoring",
  "recording_recovery",
  "studio_play_mode",
  "bounded_diagnostics",
  "http_polling",
];

function reflectionValue(
  className: string,
  property: StudioManifestProperty,
): StudioReflectionValue {
  return {
    className,
    propertyName: property.name,
    owner: property.declaringClass,
    type: { ...property.reflection },
    inherited: property.declaringClass !== className,
    serialized: property.serialized ?? true,
    permits: ["read", "write"],
  };
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for attestation state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("creator control exposes backend-graded live attestation and authorizes its raw artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-creator-attestation-"));
  const target = { kind: "project" as const };
  const projection = createStudioEvidenceProjection({
    id: "studio_capability_attestation_test",
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    purpose: "capability_attestation",
    project,
    binding: { sessionId: "studio_session_attestation" },
    requirements: STUDIO_CAPABILITY_MANIFEST.classes.flatMap((classDefinition) =>
      classDefinition.properties.map((property) => ({
        key: studioEvidenceFactKey(
          "reflection",
          target,
          `${classDefinition.name}.${property.name}`,
        ),
        kind: "reflection" as const,
        target,
      })),
    ),
    scope: { roots: [] },
    bounds: {
      maximumFacts: STUDIO_CAPABILITY_MANIFEST.limits.maximumProjectionFacts,
      maximumBytes: STUDIO_CAPABILITY_MANIFEST.limits.maximumProjectionBytes,
      roots: [],
    },
  });
  const session: StudioBridgeSession = {
    sessionId: "studio_session_attestation",
    projectId: "studio_project_attestation",
    project,
    capabilities,
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    connectorBuildHash: "1".repeat(64),
    capabilityAttestationProjectionHash: projection.contentHash,
    sessionToken: "studio_session_token_attestation",
    connectedAt: sentAt,
  };
  let handler:
    | ((message: PluginToBackendMessage, paired: StudioBridgeSession) => void | Promise<void>)
    | undefined;
  const connection = {
    async send() {},
    subscribeWithSession(next: typeof handler) {
      handler = next;
      return () => {
        if (handler === next) handler = undefined;
      };
    },
    getSessions() {
      return [session];
    },
    async close() {},
  } as unknown as StudioBridgeConnection & {
    getSessions(): StudioBridgeSession[];
  };
  const worker = {
    descriptor: {
      kind: "CreatorAgentWorkerDescriptor",
      name: "forge-local-creator-agent-worker",
      environment: "local_process",
      isolation: "none",
    },
    async plan() {
      throw new Error("attestation must not call a provider");
    },
    async build() {
      throw new Error("attestation must not call a provider");
    },
  } as CreatorAgentWorker;
  const coordinator = new CreatorSessionCoordinator({
    connection,
    worker,
    directory: root,
    sourceAnalysisHost: {
      async analyze() {
        throw new Error("attestation must not analyze source");
      },
    },
    timeoutMs: 500,
  });
  try {
    const facts: StudioEvidenceFact[] = STUDIO_CAPABILITY_MANIFEST.classes.flatMap(
      (classDefinition) =>
        classDefinition.properties.map((property) => ({
          kind: "reflection" as const,
          key: studioEvidenceFactKey(
            "reflection",
            target,
            `${classDefinition.name}.${property.name}`,
          ),
          target,
          result: {
            status: "observed" as const,
            value: reflectionValue(classDefinition.name, property),
          },
        })),
    );
    const complete = createStudioEvidenceEnvelope(
      {
        manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
        projectionId: projection.id,
        projectionHash: projection.contentHash,
        bindingHash: projection.bindingHash,
        project,
        authoritative: true,
        startedAt: sentAt,
        endedAt: "2026-09-01T00:00:01.000Z",
        completion: "complete",
        facts,
      },
      projection,
    );
    handler!(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "StudioEvidenceProduced",
        messageId: "attestation-complete",
        sentAt,
        payload: {
          project,
          reason: "capability_attestation",
          projection,
          envelope: complete,
        },
      },
      session,
    );
    const verified = await eventually(
      () => coordinator.dashboardState(),
      (state) => state.pairedStudio.attestationStatus === "verified",
    );
    assert.equal(verified.pairedStudio.attestation?.totalFacts, facts.length);
    assert.equal(verified.pairedStudio.attestation?.mismatchedFacts, 0);
    assert.equal(verified.pairedStudio.attestationHash, complete.contentHash);
    const verifiedArtifactHash = verified.pairedStudio.attestationArtifact?.artifactHash;
    assert.ok(verifiedArtifactHash);
    assert.deepEqual(await coordinator.readAuthorizedArtifact(verifiedArtifactHash), complete);

    const unavailable = facts.map((fact, index) =>
      index === 0
        ? {
            ...fact,
            result: {
              status: "unavailable" as const,
              code: "reflection_service_denied",
            },
          }
        : fact,
    );
    const incomplete = createStudioEvidenceEnvelope(
      {
        manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
        projectionId: projection.id,
        projectionHash: projection.contentHash,
        bindingHash: projection.bindingHash,
        project,
        authoritative: true,
        startedAt: sentAt,
        endedAt: "2026-09-01T00:00:02.000Z",
        completion: "incomplete",
        facts: unavailable,
      },
      projection,
    );
    handler!(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "StudioEvidenceProduced",
        messageId: "attestation-incomplete",
        sentAt,
        payload: {
          project,
          reason: "capability_attestation",
          projection,
          envelope: incomplete,
        },
      },
      session,
    );
    const incompleteState = await eventually(
      () => coordinator.dashboardState(),
      (state) => state.pairedStudio.attestationStatus === "incomplete",
    );
    assert.equal(incompleteState.pairedStudio.attestation?.unavailableFacts, 1);
    assert.match(incompleteState.pairedStudio.attestation?.detail ?? "", /incomplete/);
    assert.equal(incompleteState.pairedStudio.attestationHash, incomplete.contentHash);
    assert.ok(incompleteState.pairedStudio.attestationArtifact?.artifactHash);
  } finally {
    coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});
