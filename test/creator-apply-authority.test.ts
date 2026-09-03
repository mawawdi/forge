import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import {
  advanceSession,
  createCreatorSession,
  createStudioOwnershipMap,
  type CreatorProjectIndexView,
} from "../packages/creator-session/src/index.js";

test("a project-change revocation invalidates every older Apply authority lease", () => {
  const coordinator = Object.create(CreatorSessionCoordinator.prototype) as {
    projectAuthorityEpochs: Map<string, number>;
    acquireProjectAuthority(projectId: string): {
      projectId: string;
      epoch: number;
    };
    revokeProjectAuthority(projectId: string): void;
    assertProjectAuthority(lease: { projectId: string; epoch: number }): void;
  };
  coordinator.projectAuthorityEpochs = new Map();

  const first = coordinator.acquireProjectAuthority("studio_project_authority");
  assert.deepEqual(first, { projectId: "studio_project_authority", epoch: 0 });
  coordinator.revokeProjectAuthority("studio_project_authority");
  assert.throws(() => coordinator.assertProjectAuthority(first), /Project authority was revoked/);

  const second = coordinator.acquireProjectAuthority("studio_project_authority");
  assert.deepEqual(second, { projectId: "studio_project_authority", epoch: 1 });
  assert.doesNotThrow(() => coordinator.assertProjectAuthority(second));
});

test("a preflight-only project change requires refresh and cannot enter recording recovery", () => {
  const revisionHash = contentHash("creator-preflight-transition");
  const projectIndex: CreatorProjectIndexView = {
    project: { name: "Preflight", placeId: 0, universeId: 0 },
    revision: { hash: revisionHash } as CreatorProjectIndexView["revision"],
    instances: [
      {
        objectId: "forge_attribute:workspace",
        identity: { kind: "forge_attribute", stableId: "workspace" },
        path: "Workspace",
        name: "Workspace",
        engineContainer: { path: "Workspace", className: "Workspace" },
        className: "Workspace",
        properties: {},
        attributes: {},
        tags: [],
      },
    ],
    scripts: [],
  };
  const ownership = createStudioOwnershipMap({
    projectId: "studio_project_preflight",
    revisionHash,
    projectIndex,
  });
  const initial = createCreatorSession({
    prompt: "Make one bounded Studio change.",
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash: contentHash("preflight authority complete project-index capture"),
    ownership,
    now: new Date("2026-09-01T00:00:00.000Z"),
  });
  const { hash: _initialHash, ...preflightingPayload } = initial;
  const preflighting = {
    ...preflightingPayload,
    status: "preflighting" as const,
    hash: contentHash(
      stableJson({
        ...preflightingPayload,
        status: "preflighting" as const,
      }),
    ),
  };

  assert.equal(
    advanceSession(preflighting, { status: "refresh_required" }).status,
    "refresh_required",
  );
  assert.throws(
    () => advanceSession(preflighting, { status: "recovery_required" }),
    /Invalid CreatorSession transition preflighting -> recovery_required/,
  );
});
