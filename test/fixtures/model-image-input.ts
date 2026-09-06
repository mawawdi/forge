import { createHash } from "node:crypto";
import type { ModelImage } from "../../packages/model-client/src/contracts.js";

/** Fixed one-pixel image data; never a native rendered-game observation. */
export function modelImageFixture(): ModelImage {
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9e8AAAAASUVORK5CYII=";
  return {
    mimeType: "image/png",
    base64,
    sha256: createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex"),
    width: 1,
    height: 1,
  };
}
