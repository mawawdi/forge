import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_IDENTITY_AUTHORITY_VECTORS,
  adoptStudioProjectIdentityAuthority,
  deriveStudioProjectIdentityAuthority,
  type StudioProjectIdentityAuthorityInput,
} from "../packages/studio-evidence/src/index.js";

test("project identity authority vectors bind local projects to the exact pairing session", () => {
  for (const vector of PROJECT_IDENTITY_AUTHORITY_VECTORS) {
    assert.deepEqual(
      deriveStudioProjectIdentityAuthority(vector.input as StudioProjectIdentityAuthorityInput),
      vector.expected,
      vector.name,
    );
  }

  const incident = PROJECT_IDENTITY_AUTHORITY_VECTORS.find(
    (vector) => vector.name === "incident_local_unlinked_pair_and_heartbeat",
  );
  const duplicate = PROJECT_IDENTITY_AUTHORITY_VECTORS.find(
    (vector) => vector.name === "duplicate_local_name_different_session",
  );
  assert.ok(incident);
  assert.ok(duplicate);
  const pair = deriveStudioProjectIdentityAuthority(
    incident.input as StudioProjectIdentityAuthorityInput,
  );
  const firstHeartbeat = adoptStudioProjectIdentityAuthority({
    ...(incident.input as StudioProjectIdentityAuthorityInput),
    currentProjectId: pair.projectId,
  });
  const secondHeartbeat = adoptStudioProjectIdentityAuthority({
    ...(incident.input as StudioProjectIdentityAuthorityInput),
    currentProjectId: firstHeartbeat.projectId,
  });
  assert.equal(firstHeartbeat.authorityChanged, false, "first heartbeat preserves pair authority");
  assert.equal(secondHeartbeat.authorityChanged, false, "later heartbeat preserves pair authority");
  const renamed = PROJECT_IDENTITY_AUTHORITY_VECTORS.find(
    (vector) => vector.name === "local_unlinked_rename",
  );
  const linked = PROJECT_IDENTITY_AUTHORITY_VECTORS.find(
    (vector) => vector.name === "local_linked",
  );
  const forked = PROJECT_IDENTITY_AUTHORITY_VECTORS.find(
    (vector) => vector.name === "local_forked",
  );
  const published = PROJECT_IDENTITY_AUTHORITY_VECTORS.find(
    (vector) => vector.name === "published_continuity",
  );
  assert.ok(renamed);
  assert.ok(linked);
  assert.ok(forked);
  assert.ok(published);
  const rename = adoptStudioProjectIdentityAuthority({
    ...(renamed.input as StudioProjectIdentityAuthorityInput),
    currentProjectId: secondHeartbeat.projectId,
  });
  const link = adoptStudioProjectIdentityAuthority({
    ...(linked.input as StudioProjectIdentityAuthorityInput),
    currentProjectId: rename.projectId,
  });
  const fork = adoptStudioProjectIdentityAuthority({
    ...(forked.input as StudioProjectIdentityAuthorityInput),
    currentProjectId: link.projectId,
  });
  const publication = adoptStudioProjectIdentityAuthority({
    ...(published.input as StudioProjectIdentityAuthorityInput),
    currentProjectId: fork.projectId,
  });
  assert.equal(rename.authorityChanged, true, "rename changes the exact local identity authority");
  assert.equal(
    link.authorityChanged,
    true,
    "Link changes from local pairing to the durable project",
  );
  assert.equal(fork.authorityChanged, true, "Fork changes the durable project authority");
  assert.equal(publication.authorityChanged, true, "publication changes to platform authority");
  assert.notEqual(
    incident.expected.projectId,
    duplicate.expected.projectId,
    "same local file name and identity must not merge different Studio sessions",
  );
});

test("unlinked project authority has no unbound-salt fallback", () => {
  const incident = PROJECT_IDENTITY_AUTHORITY_VECTORS.find(
    (vector) => vector.name === "incident_local_unlinked_pair_and_heartbeat",
  );
  assert.ok(incident);
  assert.throws(
    () =>
      deriveStudioProjectIdentityAuthority({
        ...(incident.input as StudioProjectIdentityAuthorityInput),
        sessionId: "",
      }),
    /exact session ID/,
  );
});
