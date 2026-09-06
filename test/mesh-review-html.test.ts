import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import { AssetRegistry } from "../packages/asset-registry/src/index.js";
import { createMeshReview } from "../packages/asset-registry/src/mesh-review.js";
import {
  renderMeshReviewHtml,
  writeMeshReviewHtml,
} from "../packages/asset-registry/src/mesh-review-html.js";
import { contentHash } from "../packages/contracts/src/index.js";
import { meshReviewStudyObj } from "./fixtures/mesh-review-study.js";

test("mesh HTML retains exact geometry under a self-contained CSP and atomically refuses overwrite/symlinks", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "forge-mesh-html-"));
  try {
    const source = meshReviewStudyObj();
    const lock = await new AssetRegistry(
      new ImmutableJsonArtifactStore(join(root, "evidence")),
    ).ingestRecordedObj({
      bytes: Buffer.from(source),
      expectedSourceHash: contentHash(source),
      spec: {
        id: "observatory-core-study",
        description: "Authored offline geometry fixture",
        bounds: { x: 12, y: 12, z: 10 },
        clearance: 0.5,
        collision: "none",
        namedParts: [],
        sockets: [],
        universeId: 0,
      },
      provenance: {
        kind: "recorded_obj",
        source: "Offline authored fixture",
        license: "Repository fixture",
        codeHash: "a".repeat(64),
        configurationHash: "b".repeat(64),
        checkpointHashes: [],
      },
    });
    const data = createMeshReview({ bytes: Buffer.from(source), lock });
    const html = renderMeshReviewHtml(data);
    const payload = html.match(
      /<script id="mesh-data" type="application\/json">(.*?)<\/script>/s,
    )![1]!;
    assert.deepEqual(JSON.parse(payload), data);
    for (const [tag, kind] of [
      ["script", "script"],
      ["style", "style"],
    ]) {
      const content = [...html.matchAll(new RegExp(`<${tag}>(.*?)</${tag}>`, "gs"))][0]![1]!;
      assert.ok(
        html.includes(
          `${kind}-src 'sha256-${createHash("sha256").update(content).digest("base64")}'`,
        ),
      );
    }
    assert.equal((html.match(/data-part="object-/g) ?? []).length, 5);
    assert.match(html, /connect-src 'none'/);
    assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)=/);
    const output = join(root, "preview.html");
    const receipt = await writeMeshReviewHtml(output, data);
    assert.equal(receipt.sha256, contentHash(await readFile(output, "utf8")));
    await assert.rejects(writeMeshReviewHtml(output, data), /EEXIST/);
    await symlink(root, join(root, "alias"));
    await assert.rejects(writeMeshReviewHtml(join(root, "alias", "other.html"), data), /symlink/);
    await assert.rejects(writeMeshReviewHtml("relative.html", data), /absolute/);

    const checked = join(root, "checked");
    const outside = join(root, "outside");
    await mkdir(checked);
    await mkdir(join(outside, "child"), { recursive: true });
    await symlink(join(outside, "child"), join(checked, "redirect"));
    // Keep the raw segments: path.join would erase the symlink/.. regression.
    for (const outputPath of [
      `${checked}/redirect/../escaped.html`,
      `${checked}/missing/../unexpected.html`,
      `${checked}/./unexpected.html`,
    ]) {
      await assert.rejects(writeMeshReviewHtml(outputPath, data), /dot segments/);
    }
    assert.deepEqual(await readdir(checked), ["redirect"]);
    assert.deepEqual(await readdir(outside), ["child"]);
    assert.deepEqual(await readdir(join(outside, "child")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
