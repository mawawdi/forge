import {
  parseOpenRouterModelCatalog,
  unconfirmedCreatorModelCatalog,
  type CreatorModelCatalog,
} from "./model-registry.js";

const DEFAULT_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

export interface OpenRouterModelCatalogProbeOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** Metadata-only OpenRouter availability probe. It never invokes a model. */
export class OpenRouterModelCatalogProbe {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: OpenRouterModelCatalogProbeOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = DEFAULT_MODELS_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000)
      throw new Error("OpenRouter model catalog timeout must be 1..60000 milliseconds.");
    this.now = options.now ?? (() => new Date());
  }

  async probe(): Promise<CreatorModelCatalog> {
    const checkedAt = this.now().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers({ accept: "application/json" });
      if (this.options.apiKey) headers.set("authorization", `Bearer ${this.options.apiKey}`);
      const response = await this.fetchImpl(this.endpoint, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!response.ok)
        return unconfirmedCreatorModelCatalog(checkedAt, `catalog_http_${response.status}`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_CATALOG_BYTES)
        return unconfirmedCreatorModelCatalog(checkedAt, "catalog_response_too_large");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES)
        return unconfirmedCreatorModelCatalog(checkedAt, "catalog_response_too_large");
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        return unconfirmedCreatorModelCatalog(checkedAt, "catalog_response_invalid");
      }
      return parseOpenRouterModelCatalog(payload, checkedAt);
    } catch {
      return unconfirmedCreatorModelCatalog(checkedAt, "catalog_request_failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}
