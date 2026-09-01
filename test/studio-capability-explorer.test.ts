import assert from "node:assert/strict";
import test from "node:test";
import {
  studioCapabilityExplorerPage,
  studioCatalogSummary,
} from "../packages/creator-control/src/index.js";

test("catalog exploration is pinned, bounded, and preserves class inheritance context", () => {
  const summary = studioCatalogSummary();
  assert.equal(summary.kind, "StudioCatalogSummary");
  assert.match(summary.catalog.hash, /^[a-f0-9]{64}$/);
  assert.match(summary.coverage.hash, /^[a-f0-9]{64}$/);
  assert.equal(summary.coverage.catalogBinding, "matched");
  assert.equal(summary.coverage.manifestBinding, "matched");

  const page = studioCapabilityExplorerPage({ className: "Part", limit: 1 });
  assert.equal(page.kind, "StudioCapabilityExplorerPage");
  assert.equal(page.page.limit, 1);
  assert.ok(page.entries.length <= 1);
  assert.ok(page.page.total > 0);
  assert.ok(page.entries.every((entry) => entry.sourceFile.endsWith(".yaml")));
  assert.ok(page.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sourceFileHash)));
  assert.ok(
    page.entries.every(
      (entry) =>
        entry.owner === "Part" ||
        entry.name === "Part" ||
        entry.inheritedBy?.includes("Part") === true,
    ),
  );
  assert.throws(
    () => studioCapabilityExplorerPage({ limit: 101 }),
    /Capability page size is invalid/,
  );
  assert.throws(
    () => studioCapabilityExplorerPage({ className: "NoSuchClass" }),
    /not present in the pinned catalog/,
  );
});
