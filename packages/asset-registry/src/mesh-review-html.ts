import { createHash, randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { ensureAssetDirectory } from "./index.js";
import { assertMeshReviewData, type MeshReviewData } from "./mesh-review.js";
import { meshReviewRuntime } from "./mesh-review-runtime.js";
import { MESH_REVIEW_STYLE } from "./mesh-review-style.js";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
const cspHash = (value: string) => `sha256-${createHash("sha256").update(value).digest("base64")}`;

/** Self-contained local geometry review, with no network, native mutation, or embedded authority. */
export function renderMeshReviewHtml(data: MeshReviewData): string {
  assertMeshReviewData(data);
  const script = `(${meshReviewRuntime.toString()})();`;
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const chunks = data.nativeImport.partition.chunks;
  const parts = new Map<string, { name: string; triangles: number; chunks: number }>();
  for (const chunk of chunks) {
    const key =
      chunk.part.kind === "unlabelled" ? "unlabelled" : `${chunk.part.kind}-${chunk.part.name}`;
    const part = parts.get(key) ?? {
      name: chunk.part.kind === "unlabelled" ? "Unlabelled geometry" : chunk.part.name,
      triangles: 0,
      chunks: 0,
    };
    part.triangles += chunk.triangleCount;
    part.chunks++;
    parts.set(key, part);
  }
  const format = (value: number) => value.toLocaleString("en-US");
  const dimensions = (["x", "y", "z"] as const)
    .map((axis) => (data.fit.bounds.max[axis] - data.fit.bounds.min[axis]).toFixed(2))
    .join(" × ");
  const triangles = format(data.geometry.triangleCount);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src '${cspHash(script)}'; style-src '${cspHash(MESH_REVIEW_STYLE)}'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(data.assetId)} · Forge geometry review</title><style>${MESH_REVIEW_STYLE}</style></head><body>
<header><div class="brand"><div class="mark" aria-hidden="true">F</div><div><div class="eyebrow">Forge / Asset workspace</div><h1>${escape(data.assetId)}</h1></div></div><span class="pill">Local geometry · exact source</span></header>
<main><div class="workspace"><div class="toolbar" aria-label="Camera controls"><div><button data-view="iso">Isometric</button><button data-view="front">Front</button><button data-view="side">Side</button><button data-view="top">Top</button></div><div><button id="zoom-out" aria-label="Zoom out">−</button><span id="zoom-value">100%</span><button id="zoom-in" aria-label="Zoom in">+</button><button id="reset">Reset view</button></div></div>
<div class="stage"><canvas id="viewport" tabindex="0" role="img" aria-label="Interactive mesh geometry. Drag or use arrow keys to orbit; plus and minus to zoom." aria-describedby="status"></canvas><span class="stage-label">GEOMETRY PREVIEW / FLAT SHADING</span><span class="axis">Y UP · SHARED SOURCE FRAME</span></div><div id="status" class="footer" role="status" aria-live="polite">Loading local geometry…</div></div>
<aside aria-label="Geometry inspector"><section><div class="eyebrow">Source inventory</div><div class="metrics"><div class="metric"><strong>${triangles}</strong><span>Triangles</span></div><div class="metric"><strong>${format(data.geometry.vertexCount)}</strong><span>Vertices</span></div><div class="metric"><strong>${chunks.length}</strong><span>Import chunks</span></div><div class="metric"><strong>${data.sockets.length}</strong><span>Declared sockets</span></div></div><div class="dimensions">Fitted bounds · ${dimensions} studs</div></section>
<section><h2>Parts &amp; geometry</h2><div class="parts"><button data-part="all" aria-pressed="true"><span>All parts</span><small>${triangles} tris</small></button>${[...parts].map(([key, part]) => `<button data-part="${escape(key)}" aria-pressed="false"><span>${escape(part.name)}</span><small>${format(part.triangles)} tris${part.chunks > 1 ? ` · ${part.chunks} chunks` : ""}</small></button>`).join("")}</div><p class="hint">Isolate a whole named part to inspect its silhouette. Native chunking preserves every source triangle.</p></section>
<section><h2>Inspect the structure</h2><label class="control" for="explode">Explode parts <output id="explode-value">0%</output></label><input id="explode" type="range" min="0" max="150" step="1" value="0" aria-describedby="explode-hint"><p id="explode-hint" class="hint">Display offsets only. Geometry, fitted bounds and socket declarations remain unchanged.</p><label class="control">Wireframe<input id="wire" type="checkbox"></label><label class="control">Bounds &amp; clearance<input id="bounds" type="checkbox"></label><label class="control">Socket anchors<input id="sockets" type="checkbox" checked></label><div class="legend"><span>Bounds</span><span>Clearance</span><span>Sockets</span></div></section>
<section><p class="note">This preview uses computed face normals and neutral part colors. Roblox materials, textures, collision and save/reopen are not verified.</p><details><summary>Geometry findings (${data.geometry.warnings.length})</summary>${data.geometry.warnings.length ? `<ul>${data.geometry.warnings.map((warning) => `<li>${escape(warning.detail)}</li>`).join("")}</ul>` : "<p>No warnings from the implemented source topology checks.</p>"}</details><details><summary>Provenance &amp; native readiness</summary><p>Lossless partition advisory: at most ${format(data.nativeImport.partition.maximumTrianglesPerChunk)} triangles and ${format(data.nativeImport.partition.maximumVerticesPerChunk)} referenced vertices per native mesh. A fixed native import operation is still required.</p><p>Source SHA-256</p><div class="hash">${data.source.sha256}</div><p>Asset lock</p><div class="hash">${data.lockHash}</div><p>Review payload</p><div class="hash">${data.hash}</div><p>No model calls, uploads or asset approvals occur in this viewer.</p></details></section></aside></main><script id="mesh-data" type="application/json">${json}</script><script>${script}</script></body></html>`;
}

/** Publish a complete artifact atomically. Existing files and symlink parents fail closed. */
export async function writeMeshReviewHtml(
  outputPath: string,
  data: MeshReviewData,
): Promise<{ path: string; sha256: string; bytes: number }> {
  if (!isAbsolute(outputPath) || !outputPath.endsWith(".html"))
    throw new Error("Mesh preview output must be an absolute .html path");
  if (outputPath.split(/[\\/]/).some((segment) => segment === "." || segment === ".."))
    throw new Error("Mesh preview output must not contain dot segments");
  const html = renderMeshReviewHtml(data);
  const directory = await ensureAssetDirectory(dirname(outputPath));
  const destination = join(directory, basename(outputPath));
  const temporary = join(directory, `.${basename(outputPath)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(html, "utf8");
    await handle.sync();
    await handle.close();
    await link(temporary, destination);
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await handle.close();
    await unlink(temporary);
  }
  return {
    path: destination,
    sha256: createHash("sha256").update(html).digest("hex"),
    bytes: Buffer.byteLength(html),
  };
}
