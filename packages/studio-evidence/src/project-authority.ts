import {
  PROJECT_IDENTITY_AUTHORITY_RECIPE,
  PROJECT_IDENTITY_AUTHORITY_VECTORS,
} from "./generated.js";
import { contentHash } from "../../contracts/src/index.js";
import { createStudioConnectorEpoch } from "./project-index.js";

/**
 * The minimum sealed project-identity surface required to derive connector
 * authority. This intentionally stays below studio-protocol: bridge and
 * coordinator authority must not make the evidence floor depend on transport
 * envelopes.
 */
export interface StudioProjectIdentityAuthorityState {
  readonly hash: string;
  readonly project: {
    readonly name: string;
    readonly placeId: number;
    readonly universeId: number;
  };
  readonly reservedAttribute:
    | { readonly status: "absent" }
    | { readonly status: "observed"; readonly forgeProjectId: string }
    | { readonly status: "invalid"; readonly valueType: string };
}

export interface StudioProjectIdentityAuthorityInput {
  readonly sessionId: string;
  readonly connectorBuildHash: string;
  readonly identity: StudioProjectIdentityAuthorityState;
}

export interface StudioProjectIdentityAuthority {
  readonly projectId: string;
  readonly conversationProjectId: string;
  readonly connectorEpoch: string;
}

export interface StudioProjectIdentityAuthorityAdoptionInput extends StudioProjectIdentityAuthorityInput {
  readonly currentProjectId: string;
}

export interface StudioProjectIdentityAuthorityAdoption extends StudioProjectIdentityAuthority {
  readonly authorityChanged: boolean;
}

/**
 * Derives all current connector authority from one exact identity observation.
 * An unlinked local place is necessarily pairing-scoped; this function has no
 * unbound fallback because that would merge independent local Studio windows.
 */
export function deriveStudioProjectIdentityAuthority(
  input: StudioProjectIdentityAuthorityInput,
): StudioProjectIdentityAuthority {
  const { identity } = input;
  assertSessionId(input.sessionId);
  assertHash(input.connectorBuildHash, "connector build hash");
  assertIdentity(identity);

  const { project, reservedAttribute } = identity;
  const isPublished = project.placeId !== 0;
  const authorityKey = isPublished
    ? `${PROJECT_IDENTITY_AUTHORITY_RECIPE.publishedPrefix}${project.universeId}:${project.placeId}`
    : reservedAttribute.status === "observed"
      ? `${PROJECT_IDENTITY_AUTHORITY_RECIPE.linkedPrefix}${reservedAttribute.forgeProjectId}`
      : `${PROJECT_IDENTITY_AUTHORITY_RECIPE.localUnlinkedPrefix}${identity.hash}${PROJECT_IDENTITY_AUTHORITY_RECIPE.pairingDelimiter}${input.sessionId}`;
  const projectId = `${PROJECT_IDENTITY_AUTHORITY_RECIPE.projectIdPrefix}${sha256(authorityKey).slice(0, PROJECT_IDENTITY_AUTHORITY_RECIPE.projectIdHashChars)}`;
  const conversationProjectId =
    !isPublished && reservedAttribute.status === "observed"
      ? reservedAttribute.forgeProjectId
      : projectId;
  return {
    projectId,
    conversationProjectId,
    connectorEpoch: createStudioConnectorEpoch({
      sessionId: input.sessionId,
      projectId,
      connectorBuildHash: input.connectorBuildHash,
    }),
  };
}

/**
 * The identity transition used after every heartbeat and Link/Fork/publication
 * observation. Pairing uses `deriveStudioProjectIdentityAuthority` to establish
 * its first authority; it must not fabricate a pre-pair current project ID.
 */
export function adoptStudioProjectIdentityAuthority(
  input: StudioProjectIdentityAuthorityAdoptionInput,
): StudioProjectIdentityAuthorityAdoption {
  if (!isStudioProjectId(input.currentProjectId))
    throw new Error("project identity authority current project ID is malformed");
  const authority = deriveStudioProjectIdentityAuthority(input);
  return { ...authority, authorityChanged: input.currentProjectId !== authority.projectId };
}

/** Shared generator-owned vectors for host and Luau authority implementations. */
export type StudioProjectIdentityAuthorityVector =
  (typeof PROJECT_IDENTITY_AUTHORITY_VECTORS)[number];

function assertIdentity(value: StudioProjectIdentityAuthorityState): void {
  if (!value || typeof value !== "object")
    throw new Error("project identity authority is malformed");
  assertHash(value.hash, "project identity hash");
  const { project, reservedAttribute } = value;
  if (
    !project ||
    typeof project.name !== "string" ||
    project.name.length === 0 ||
    !Number.isSafeInteger(project.placeId) ||
    !Number.isSafeInteger(project.universeId) ||
    project.placeId < 0 ||
    project.universeId < 0 ||
    (project.placeId === 0) !== (project.universeId === 0)
  )
    throw new Error("project identity authority project is malformed");
  if (!reservedAttribute || typeof reservedAttribute !== "object")
    throw new Error("project identity authority attribute is malformed");
  if (reservedAttribute.status === "absent") return;
  if (
    reservedAttribute.status === "invalid" &&
    typeof reservedAttribute.valueType === "string" &&
    reservedAttribute.valueType.length > 0 &&
    reservedAttribute.valueType.length <= 64
  )
    return;
  if (
    reservedAttribute.status !== "observed" ||
    !isForgeProjectId(reservedAttribute.forgeProjectId)
  )
    throw new Error("project identity authority attribute is malformed");
}

function assertSessionId(value: string): void {
  if (typeof value !== "string" || value.length === 0 || /\s/u.test(value))
    throw new Error("project identity authority requires an exact session ID");
}

function assertHash(value: string, label: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error(`${label} is malformed`);
}

function isForgeProjectId(value: unknown): value is string {
  return typeof value === "string" && /^forge_project_[a-f0-9]{32}$/u.test(value);
}

function isStudioProjectId(value: unknown): value is string {
  return typeof value === "string" && /^studio_project_[a-f0-9]{24}$/u.test(value);
}

function sha256(value: string): string {
  // `contentHash` is SHA-256 over exact UTF-8 text. Keep this narrow wrapper
  // beside the recipe so no caller can substitute a project-id hash domain.
  return contentHash(value);
}
