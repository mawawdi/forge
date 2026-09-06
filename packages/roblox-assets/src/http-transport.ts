import type {
  ImmutableBinaryArtifactStore,
  BinaryArtifactReference,
} from "../../artifact-store/src/index.js";
import type { RobloxSecretStore } from "./credentials.js";
import type {
  OpenCloudAssetTransport,
  OpenCloudAssetTransportRequest,
  OpenCloudAssetTransportResponse,
} from "./index.js";

const CREATE_ENDPOINT = "https://apis.roblox.com/assets/v1/assets";
const OPERATION = /^https:\/\/apis\.roblox\.com\/assets\/v1\/operations\/[A-Za-z0-9._~-]{1,512}$/u;
const DELIVERY =
  /^https:\/\/apis\.roblox\.com\/asset-delivery-api\/v1\/assetId\/[1-9][0-9]{0,19}\/version\/[1-9][0-9]{0,19}$/u;

export interface RobloxHttpCredentialBinding {
  kind: "api_key" | "oauth2";
  accountId: string;
}

/** Fixed-origin Open Cloud transport with bounded bodies and redirect rejection. */
export class RobloxAuthenticatedHttpTransport implements OpenCloudAssetTransport {
  constructor(
    private readonly credentials: RobloxSecretStore,
    private readonly binding: RobloxHttpCredentialBinding,
    private readonly timeoutMs = 30_000,
    private readonly maximumResponseBytes = 1024 * 1024,
    /** Fixed host test seam; never sourced from scene or model data. */
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async send(request: OpenCloudAssetTransportRequest): Promise<OpenCloudAssetTransportResponse> {
    if (
      (request.method === "POST" && request.url !== CREATE_ENDPOINT) ||
      (request.method === "GET" && !OPERATION.test(request.url))
    )
      throw new Error("Open Cloud request endpoint is outside the fixed asset API");
    const secret = await this.credentials.get(this.binding.accountId);
    if (!secret) throw new Error("Open Cloud credential is disconnected");
    const headers = new Headers();
    if (this.binding.kind === "api_key") headers.set("x-api-key", secret);
    else {
      const token = JSON.parse(secret) as Record<string, unknown>;
      if (typeof token.accessToken !== "string") throw new Error("OAuth credential is malformed");
      headers.set("authorization", `Bearer ${token.accessToken}`);
    }
    let body: FormData | undefined;
    if (request.method === "POST") {
      if (!request.metadata || !request.file)
        throw new Error("Asset creation payload is incomplete");
      body = new FormData();
      body.set("request", JSON.stringify(request.metadata));
      const fileBytes = new Uint8Array(request.file.bytes.byteLength);
      fileBytes.set(request.file.bytes);
      body.set(
        "fileContent",
        new Blob([fileBytes.buffer], { type: request.file.contentType }),
        request.file.filename,
      );
    }
    const response = await fetchBounded(
      request.url,
      {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
      },
      this.timeoutMs,
      this.maximumResponseBytes,
      this.fetcher,
    );
    let parsed: unknown = {};
    if (response.bytes.byteLength) {
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes));
      } catch {
        parsed = { error: "Open Cloud returned a non-JSON response" };
      }
    }
    return { httpStatus: response.status, body: parsed };
  }

  async retainExactVersion(input: {
    assetId: string;
    versionNumber: number;
    binaryStore: ImmutableBinaryArtifactStore;
    maximumBytes?: number;
  }): Promise<BinaryArtifactReference> {
    if (
      !/^[1-9][0-9]{0,19}$/u.test(input.assetId) ||
      !Number.isSafeInteger(input.versionNumber) ||
      input.versionNumber <= 0
    )
      throw new Error("Exact-version delivery identity is malformed");
    const url = `https://apis.roblox.com/asset-delivery-api/v1/assetId/${input.assetId}/version/${input.versionNumber}`;
    if (!DELIVERY.test(url)) throw new Error("Exact-version delivery URL is malformed");
    const secret = await this.credentials.get(this.binding.accountId);
    if (!secret) throw new Error("Asset delivery credential is disconnected");
    const headers = new Headers();
    if (this.binding.kind === "api_key") headers.set("x-api-key", secret);
    else {
      const token = JSON.parse(secret) as Record<string, unknown>;
      if (typeof token.accessToken !== "string") throw new Error("OAuth credential is malformed");
      headers.set("authorization", `Bearer ${token.accessToken}`);
    }
    const maximum = input.maximumBytes ?? 64 * 1024 * 1024;
    const response = await fetchBounded(
      url,
      { method: "GET", headers },
      this.timeoutMs,
      maximum,
      this.fetcher,
    );
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Exact-version asset delivery failed with status ${response.status}`);
    const mediaType = response.contentType.split(";", 1)[0]?.trim().toLowerCase();
    if (
      mediaType !== "application/octet-stream" &&
      mediaType !== "application/xml" &&
      mediaType !== "model/gltf-binary"
    )
      throw new Error("Exact-version asset delivery returned an unsupported media type");
    return input.binaryStore.write(response.bytes, mediaType);
  }
}

async function fetchBounded(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maximumBytes: number,
  fetcher: typeof fetch,
): Promise<{ status: number; contentType: string; bytes: Uint8Array }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > maximumBytes)
      throw new Error("Open Cloud response exceeds its byte limit");
    if (!response.body)
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        bytes: new Uint8Array(),
      };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error("Open Cloud response exceeds its byte limit");
      }
      chunks.push(next.value);
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      bytes: combined,
    };
  } finally {
    clearTimeout(timer);
  }
}
