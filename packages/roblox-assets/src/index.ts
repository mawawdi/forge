import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import {
  assertBinaryArtifactReference,
  ImmutableJsonArtifactStore,
  type ImmutableBinaryArtifactStore,
  type ArtifactReference,
  type BinaryArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertBoundedGameJson,
  DEFAULT_GAME_ADMISSION_POLICY,
} from "../../game-ir/src/primitives.js";
import {
  MANUAL_SCENE_IMPORT_PACKET_SCHEMA,
  NATIVE_UPLOAD_AUTHORIZATION_SCHEMA,
  NATIVE_ASSET_RECEIPT_SCHEMA,
  OPEN_CLOUD_OPERATION_RESPONSE_SCHEMA,
  OPEN_CLOUD_UPLOAD_INTENT_SCHEMA,
  assertSealedWorkflowArtifact,
  sealOpenCloudResponse,
  sealWorkflowArtifact,
  type ManualSceneImportPacket,
  type NativeUploadAuthorization,
  type NativeAssetReceipt,
  type OpenCloudOperationResponse,
  type OpenCloudUploadIntent,
} from "../../visual-world/src/index.js";

export * from "./credentials.js";
export * from "./http-transport.js";

export const ROBLOX_ASSET_BRIDGE_ABI = "forge-roblox-asset-bridge@2";

export interface RobloxAssetCapabilityProfile {
  kind: "RobloxAssetCapabilityProfile";
  abi: typeof ROBLOX_ASSET_BRIDGE_ABI;
  hash: string;
  openCloudGlbUpload: {
    status: "available";
    createEndpoint: "https://apis.roblox.com/assets/v1/assets";
    operationEndpoint: "https://apis.roblox.com/assets/v1/operations/{operationId}";
    assetType: "Model";
    contentType: "model/gltf-binary";
    maximumBytes: 20_000_000;
    packageEnvelope: true;
  };
  manualStudioGlbImport: { status: "available"; exactReviewedBytesRequired: true };
}

export function robloxAssetCapabilityProfile(): RobloxAssetCapabilityProfile {
  const material = {
    kind: "RobloxAssetCapabilityProfile" as const,
    abi: ROBLOX_ASSET_BRIDGE_ABI as typeof ROBLOX_ASSET_BRIDGE_ABI,
    openCloudGlbUpload: {
      status: "available" as const,
      createEndpoint: "https://apis.roblox.com/assets/v1/assets" as const,
      operationEndpoint: "https://apis.roblox.com/assets/v1/operations/{operationId}" as const,
      assetType: "Model" as const,
      contentType: "model/gltf-binary" as const,
      maximumBytes: 20_000_000 as const,
      packageEnvelope: true as const,
    },
    manualStudioGlbImport: {
      status: "available" as const,
      exactReviewedBytesRequired: true as const,
    },
  };
  return { ...material, hash: contentHash(stableJson(material)) };
}

/** Immutable request/response journal. Credentials and authorization headers never enter it. */
export class OpenCloudAssetOperationJournal {
  constructor(private readonly store: ImmutableJsonArtifactStore) {}

  async retainIntent(
    input: Omit<OpenCloudUploadIntent, "kind" | "id" | "hash" | "dispatchKey" | "dispatchState">,
  ): Promise<{
    intent: OpenCloudUploadIntent;
    artifact: ArtifactReference;
  }> {
    const dispatchKey = contentHash(stableJson({ ...input, bridgeAbi: ROBLOX_ASSET_BRIDGE_ABI }));
    const intent = sealWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, {
      ...input,
      kind: "OpenCloudUploadIntent",
      dispatchKey,
      dispatchState: "not_dispatched",
    });
    return { intent, artifact: await this.store.write(intent) };
  }

  async markDispatching(
    intent: OpenCloudUploadIntent,
  ): Promise<{ intent: OpenCloudUploadIntent; artifact: ArtifactReference }> {
    assertSealedWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, intent);
    if (intent.dispatchState !== "not_dispatched")
      throw new Error("Only a retained, undispatched upload intent may begin dispatch");
    const fenceDirectory = join(this.store.root, "upload-dispatch-fences-v2");
    await mkdir(fenceDirectory, { recursive: true, mode: 0o700 });
    const fence = await open(
      join(fenceDirectory, `${intent.dispatchKey}.fence`),
      "wx",
      0o600,
    ).catch((error: unknown) => {
      throw new Error(
        isNodeError(error, "EEXIST")
          ? "This upload intent already crossed its durable dispatch fence"
          : detail(error),
      );
    });
    await fence.writeFile(`${intent.hash}\n`, "utf8");
    await fence.close();
    const { id: _id, hash: _hash, ...material } = intent;
    const next = sealWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, {
      ...material,
      dispatchState: "dispatching",
    });
    return { intent: next, artifact: await this.store.write(next) };
  }

  async markUnknown(
    intent: OpenCloudUploadIntent,
    diagnostic: string,
  ): Promise<{ intent: OpenCloudUploadIntent; artifact: ArtifactReference; diagnostic: string }> {
    assertSealedWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, intent);
    if (intent.dispatchState !== "dispatching")
      throw new Error("Only an in-flight upload may acquire an unknown outcome");
    const { id: _id, hash: _hash, ...material } = intent;
    const next = sealWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, {
      ...material,
      dispatchState: "outcome_unknown",
    });
    return {
      intent: next,
      artifact: await this.store.write(next),
      diagnostic: diagnostic.slice(0, 4096),
    };
  }

  async retainResponse(
    intent: OpenCloudUploadIntent,
    input: Omit<
      OpenCloudOperationResponse,
      "kind" | "id" | "hash" | "bodyHash" | "intentId" | "intentHash"
    >,
  ): Promise<{ response: OpenCloudOperationResponse; artifact: ArtifactReference }> {
    assertSealedWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, intent);
    if (intent.dispatchState !== "dispatching" && intent.dispatchState !== "response_received")
      throw new Error("Response has no matching dispatch or operation poll");
    const { id: _id, hash: _hash, ...intentMaterial } = intent;
    const dispatchingIntent =
      intent.dispatchState === "dispatching"
        ? intent
        : sealWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, {
            ...intentMaterial,
            dispatchState: "dispatching",
          });
    const response = sealOpenCloudResponse({
      ...input,
      intentId: dispatchingIntent.id,
      intentHash: dispatchingIntent.hash,
    });
    OPEN_CLOUD_OPERATION_RESPONSE_SCHEMA.parse(response);
    assertBoundedGameJson(response.body, {
      ...DEFAULT_GAME_ADMISSION_POLICY,
      maximumJsonBytes: 1024 * 1024,
    });
    return { response, artifact: await this.store.write(response) };
  }

  async markResponseReceived(
    intent: OpenCloudUploadIntent,
  ): Promise<{ intent: OpenCloudUploadIntent; artifact: ArtifactReference }> {
    assertSealedWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, intent);
    if (intent.dispatchState !== "dispatching")
      throw new Error("Only an in-flight upload may record a response");
    const { id: _id, hash: _hash, ...material } = intent;
    const next = sealWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, {
      ...material,
      dispatchState: "response_received",
    });
    return { intent: next, artifact: await this.store.write(next) };
  }

  /** Unknown outcomes are reconciled by operation identity; this API never resubmits them. */
  recoveryAction(
    intent: OpenCloudUploadIntent,
    response?: OpenCloudOperationResponse,
  ): {
    mayResubmit: false;
    action: "poll_existing_operation" | "establish_non_submission";
    operationPath?: string;
  } {
    assertSealedWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, intent);
    if (intent.dispatchState !== "outcome_unknown") throw new Error("Upload is not in recovery");
    if (response) {
      assertSealedWorkflowArtifact(OPEN_CLOUD_OPERATION_RESPONSE_SCHEMA, response);
      const { id: _id, hash: _hash, ...material } = intent;
      const predecessor = sealWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, {
        ...material,
        dispatchState: "dispatching",
      });
      if (response.intentId !== predecessor.id || response.intentHash !== predecessor.hash)
        throw new Error("Recovery response binds a different upload intent");
    }
    if (response?.operationPath)
      return {
        mayResubmit: false,
        action: "poll_existing_operation",
        operationPath: response.operationPath,
      };
    return { mayResubmit: false, action: "establish_non_submission" };
  }
}

export interface OpenCloudAssetTransportRequest {
  method: "POST" | "GET";
  url: string;
  metadata?: {
    assetType: "Model";
    displayName: string;
    description: string;
    creationContext: { creator: { userId: string } | { groupId: string } };
  };
  file?: {
    filename: string;
    contentType: "model/gltf-binary";
    bytes: Uint8Array;
  };
}

export interface OpenCloudAssetTransportResponse {
  httpStatus: number;
  body: unknown;
}

/** Credentials are encapsulated by this host transport and never enter Forge artifacts. */
export interface OpenCloudAssetTransport {
  send(request: OpenCloudAssetTransportRequest): Promise<OpenCloudAssetTransportResponse>;
}

export type OpenCloudUploadDispatchResult =
  | {
      status: "response_received";
      intent: OpenCloudUploadIntent;
      intentArtifact: ArtifactReference;
      response: OpenCloudOperationResponse;
      responseArtifact: ArtifactReference;
    }
  | {
      status: "outcome_unknown";
      intent: OpenCloudUploadIntent;
      intentArtifact: ArtifactReference;
      diagnostic: string;
    };

export class AuthorizedOpenCloudAssetUploader {
  constructor(
    private readonly journal: OpenCloudAssetOperationJournal,
    private readonly binaryStore: ImmutableBinaryArtifactStore,
    private readonly transport: OpenCloudAssetTransport,
  ) {}

  async dispatch(
    authorizationInput: NativeUploadAuthorization,
    intentInput: OpenCloudUploadIntent,
    artifact: BinaryArtifactReference,
  ): Promise<OpenCloudUploadDispatchResult> {
    assertSealedWorkflowArtifact(NATIVE_UPLOAD_AUTHORIZATION_SCHEMA, authorizationInput);
    assertSealedWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, intentInput);
    const authorization = authorizationInput;
    const intent = intentInput;
    assertBinaryArtifactReference(artifact);
    if (
      authorization.credentialCapability.kind === "manual_studio_import" ||
      !authorization.credentialCapability.scopes.includes("asset:write")
    )
      throw new Error("Open Cloud upload authority lacks asset:write capability");
    if (
      intent.authorizationId !== authorization.id ||
      intent.authorizationHash !== authorization.hash ||
      stableJson(intent.creator) !== stableJson(authorization.creator)
    )
      throw new Error("Open Cloud upload intent does not bind its authorization");
    const approved = authorization.exportArtifacts.find(
      (entry) =>
        entry.id === intent.artifact.id &&
        entry.hash === intent.artifact.hash &&
        entry.bytes === intent.artifact.bytes,
    );
    if (
      !approved ||
      artifact.artifactHash !== approved.hash ||
      artifact.bytes !== approved.bytes ||
      artifact.mediaType !== "model/gltf-binary" ||
      artifact.bytes > robloxAssetCapabilityProfile().openCloudGlbUpload.maximumBytes
    )
      throw new Error("Open Cloud upload bytes differ from the exact authorized GLB");
    const bytes = await this.binaryStore.read(artifact);
    const dispatching = await this.journal.markDispatching(intent);
    let transportResponse: OpenCloudAssetTransportResponse;
    try {
      transportResponse = await this.transport.send({
        method: "POST",
        url: robloxAssetCapabilityProfile().openCloudGlbUpload.createEndpoint,
        metadata: {
          assetType: "Model",
          displayName: intent.displayName,
          description: intent.description,
          creationContext: {
            creator:
              intent.creator.kind === "user"
                ? { userId: intent.creator.id }
                : { groupId: intent.creator.id },
          },
        },
        file: {
          filename: `${intent.artifact.id}.glb`,
          contentType: "model/gltf-binary",
          bytes,
        },
      });
      assertTransportResponse(transportResponse);
    } catch (error: unknown) {
      const unknown = await this.journal.markUnknown(dispatching.intent, detail(error));
      return {
        status: "outcome_unknown",
        intent: unknown.intent,
        intentArtifact: unknown.artifact,
        diagnostic: unknown.diagnostic,
      };
    }
    const retained = await this.journal.retainResponse(dispatching.intent, {
      httpStatus: transportResponse.httpStatus,
      ...(operationPath(transportResponse.body)
        ? { operationPath: operationPath(transportResponse.body) }
        : {}),
      body: transportResponse.body,
      receivedAt: new Date().toISOString(),
    });
    const completed = await this.journal.markResponseReceived(dispatching.intent);
    return {
      status: "response_received",
      intent: completed.intent,
      intentArtifact: completed.artifact,
      response: retained.response,
      responseArtifact: retained.artifact,
    };
  }

  async poll(
    intentInput: OpenCloudUploadIntent,
    priorResponseInput: OpenCloudOperationResponse,
  ): Promise<{ response: OpenCloudOperationResponse; responseArtifact: ArtifactReference }> {
    assertSealedWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, intentInput);
    assertSealedWorkflowArtifact(OPEN_CLOUD_OPERATION_RESPONSE_SCHEMA, priorResponseInput);
    const intent = intentInput;
    const priorResponse = priorResponseInput;
    const { id: _id, hash: _hash, ...intentMaterial } = intent;
    const dispatchingPredecessor = sealWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, {
      ...intentMaterial,
      dispatchState: "dispatching",
    });
    if (
      intent.dispatchState !== "response_received" ||
      priorResponse.intentId !== dispatchingPredecessor.id ||
      priorResponse.intentHash !== dispatchingPredecessor.hash ||
      !priorResponse.operationPath
    )
      throw new Error("Open Cloud operation poll lacks an exact retained operation identity");
    const response = await this.transport.send({
      method: "GET",
      url: `https://apis.roblox.com/assets/v1/${priorResponse.operationPath}`,
    });
    assertTransportResponse(response);
    const retained = await this.journal.retainResponse(intent, {
      httpStatus: response.httpStatus,
      operationPath: priorResponse.operationPath,
      body: response.body,
      receivedAt: new Date().toISOString(),
    });
    return { response: retained.response, responseArtifact: retained.artifact };
  }
}

export async function createManualSceneImportPacket(input: {
  authorization: NativeUploadAuthorization;
  binaryStore: ImmutableBinaryArtifactStore;
  glbs: readonly {
    partitionId: string;
    absolutePath: string;
    artifact: BinaryArtifactReference;
  }[];
}): Promise<ManualSceneImportPacket> {
  assertSealedWorkflowArtifact(NATIVE_UPLOAD_AUTHORIZATION_SCHEMA, input.authorization);
  const authorization = input.authorization;
  if (authorization.credentialCapability.kind !== "manual_studio_import")
    throw new Error("Manual packet requires explicit manual Studio import authority");
  const approved = new Set(authorization.exportArtifacts.map((entry) => entry.hash));
  if (
    !input.glbs.length ||
    input.glbs.length !== authorization.exportArtifacts.length ||
    new Set(input.glbs.map((entry) => entry.partitionId)).size !== input.glbs.length ||
    new Set(input.glbs.map((entry) => entry.artifact.artifactHash)).size !== input.glbs.length ||
    input.glbs.some((entry) => !approved.has(entry.artifact.artifactHash))
  )
    throw new Error("Manual import packet differs from the approved GLB inventory");
  for (const entry of input.glbs) {
    if (
      !isAbsolute(entry.absolutePath) ||
      basename(entry.absolutePath).toLowerCase().endsWith(".glb") === false
    )
      throw new Error("Manual import paths must be absolute GLB paths");
    if (entry.artifact.mediaType !== "model/gltf-binary")
      throw new Error("Manual import artifact is not a retained GLB");
    const bytes = await input.binaryStore.read(entry.artifact);
    if (bytes.byteLength !== entry.artifact.bytes)
      throw new Error("Manual import artifact bytes differ from the retained GLB");
    const descriptor = await open(entry.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await descriptor.stat();
      if (!before.isFile() || before.size !== entry.artifact.bytes)
        throw new Error("Manual import path is not the exact retained GLB");
      const localBytes = await descriptor.readFile();
      const after = await descriptor.stat();
      if (
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        createHash("sha256").update(localBytes).digest("hex") !== entry.artifact.artifactHash
      )
        throw new Error("Manual import path changed or differs from the retained GLB");
    } finally {
      await descriptor.close();
    }
  }
  return sealWorkflowArtifact(MANUAL_SCENE_IMPORT_PACKET_SCHEMA, {
    kind: "ManualSceneImportPacket",
    scene: authorization.scene,
    reviewHash: authorization.reviewHash,
    glbs: input.glbs.map((entry) => ({
      partitionId: entry.partitionId,
      absolutePath: entry.absolutePath,
      artifactHash: entry.artifact.artifactHash,
    })),
    importer: {
      units: "studs",
      anchored: true,
      importAsModel: true,
      useWorldOrigin: false,
      collision: "off",
    },
  });
}

export type OpenCloudOperationState =
  | { status: "pending" }
  | { status: "eligible"; assetId: string; versionNumber: number }
  | { status: "rejected"; detail: string }
  | { status: "unknown"; detail: string };

export function classifyOpenCloudOperationResponse(
  responseInput: OpenCloudOperationResponse,
): OpenCloudOperationState {
  assertSealedWorkflowArtifact(OPEN_CLOUD_OPERATION_RESPONSE_SCHEMA, responseInput);
  const body = responseInput.body;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { status: "unknown", detail: "Operation response body is malformed" };
  const record = body as Record<string, unknown>;
  if (record.done !== true) return { status: "pending" };
  if (record.error && typeof record.error === "object")
    return {
      status: "rejected",
      detail: String(
        (record.error as Record<string, unknown>).message ?? "Asset operation failed",
      ).slice(0, 4096),
    };
  const result = record.response;
  if (!result || typeof result !== "object")
    return { status: "unknown", detail: "Completed operation lacks a response payload" };
  const assetId = (result as Record<string, unknown>).assetId;
  const versionNumber = (result as Record<string, unknown>).versionNumber;
  if (
    !(
      (typeof assetId === "string" && /^[1-9][0-9]{0,19}$/u.test(assetId)) ||
      (typeof assetId === "number" && Number.isSafeInteger(assetId) && assetId > 0)
    ) ||
    !Number.isSafeInteger(versionNumber) ||
    (versionNumber as number) <= 0
  )
    return { status: "unknown", detail: "Completed operation lacks exact asset/version identity" };
  return { status: "eligible", assetId: String(assetId), versionNumber: versionNumber as number };
}

/**
 * A completed authenticated creation operation proves immutable asset/version
 * identity and the creator selected by the exact upload intent. It does not
 * prove moderation, dependency access, or converted content identity.
 */
export function derivePendingNativeAssetReceipt(input: {
  authorization: NativeUploadAuthorization;
  intent: OpenCloudUploadIntent;
  response: OpenCloudOperationResponse;
  observedAt: string;
}): NativeAssetReceipt {
  assertSealedWorkflowArtifact(NATIVE_UPLOAD_AUTHORIZATION_SCHEMA, input.authorization);
  assertSealedWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, input.intent);
  assertSealedWorkflowArtifact(OPEN_CLOUD_OPERATION_RESPONSE_SCHEMA, input.response);
  const { id: _id, hash: _hash, ...intentMaterial } = input.intent;
  const dispatchingIntent =
    input.intent.dispatchState === "dispatching"
      ? input.intent
      : sealWorkflowArtifact(OPEN_CLOUD_UPLOAD_INTENT_SCHEMA, {
          ...intentMaterial,
          dispatchState: "dispatching",
        });
  const state = classifyOpenCloudOperationResponse(input.response);
  if (state.status !== "eligible")
    throw new Error(`Asset operation cannot produce a receipt while ${state.status}`);
  if (
    input.intent.authorizationId !== input.authorization.id ||
    input.intent.authorizationHash !== input.authorization.hash ||
    stableJson(input.intent.creator) !== stableJson(input.authorization.creator) ||
    !input.authorization.exportArtifacts.some(
      (artifact) =>
        artifact.id === input.intent.artifact.id &&
        artifact.hash === input.intent.artifact.hash &&
        artifact.bytes === input.intent.artifact.bytes,
    ) ||
    input.response.intentId !== dispatchingIntent.id ||
    input.response.intentHash !== dispatchingIntent.hash
  )
    throw new Error("Authenticated operation response differs from its upload authority");
  return sealWorkflowArtifact(NATIVE_ASSET_RECEIPT_SCHEMA, {
    kind: "NativeAssetReceipt",
    authorizationHash: input.authorization.hash,
    sourceArtifactHash: input.intent.artifact.hash,
    operationResponseHash: input.response.hash,
    declarationAuthority: "open_cloud",
    assetId: state.assetId,
    versionNumber: state.versionNumber,
    owner: input.authorization.creator,
    moderation: "pending",
    dependencyAccess: "incomplete",
    observedAt: input.observedAt,
  });
}

function operationPath(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body) || !("path" in body))
    return undefined;
  const path = (body as { path?: unknown }).path;
  return typeof path === "string" && /^operations\/[A-Za-z0-9._~-]{1,512}$/.test(path)
    ? path
    : undefined;
}

function assertTransportResponse(value: OpenCloudAssetTransportResponse): void {
  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isInteger(value.httpStatus) ||
    value.httpStatus < 100 ||
    value.httpStatus > 599
  )
    throw new Error("Open Cloud transport returned a malformed response");
  assertBoundedGameJson(value.body, {
    ...DEFAULT_GAME_ADMISSION_POLICY,
    maximumJsonBytes: 1024 * 1024,
  });
}

function detail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4096);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
