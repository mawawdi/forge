import assert from "node:assert/strict";
import test from "node:test";
import {
  ROBLOX_API_CATALOG,
  getRobloxApiCatalogLookupEntry,
  lookupRobloxApiCatalog,
  RobloxApiLookupError,
  resolveRobloxClassMembers,
} from "../packages/studio-evidence/src/index.js";

test("owner metadata filters return the exact class, datatype, enum and library rows", () => {
  for (const [ownerName, memberKind] of [
    ["ProximityPrompt", "class"],
    ["ClickDetector", "class"],
    ["PlayerGui", "class"],
    ["Instance", "class"],
    ["Instance", "datatype"],
    ["CFrame", "datatype"],
    ["Material", "enum"],
    ["task", "library"],
  ] as const) {
    const result = lookupRobloxApiCatalog({ ownerName, memberKind });
    assert.equal(result.total, 1, `${ownerName} ${memberKind}`);
    assert.equal(result.entries[0]?.name, ownerName);
    assert.equal(result.entries[0]?.entryKind, memberKind);
    assert.equal(result.nextCursor, undefined);
    assert.deepEqual(
      result.entries[0],
      getRobloxApiCatalogLookupEntry(result.entries[0]!.catalogEntryId),
    );
  }
  const result = lookupRobloxApiCatalog({ query: "PlayerGui", memberKind: "class" });
  assert.equal(result.entries[0]?.name, "PlayerGui");
  assert.equal(result.entries[0]?.superclass, "BasePlayerGui");
  assert.equal(result.entries[0]?.sourceFile, "classes/PlayerGui.yaml");
  assert.deepEqual(result.entries[0]?.tags, ["NotCreatable", "PlayerReplicated"]);
});

test("top-level catalog kinds paginate completely without admitting their member rows", () => {
  for (const [memberKind, owners] of [
    ["class", ROBLOX_API_CATALOG.classes],
    ["datatype", ROBLOX_API_CATALOG.datatypes],
    ["enum", ROBLOX_API_CATALOG.enums],
    ["library", ROBLOX_API_CATALOG.libraries],
  ] as const) {
    const selection = { query: memberKind, memberKind, limit: 7 };
    let page = lookupRobloxApiCatalog(selection);
    assert.ok(page.nextCursor);
    const entries = [...page.entries];
    while (page.nextCursor) {
      page = lookupRobloxApiCatalog({ ...selection, cursor: page.nextCursor });
      entries.push(...page.entries);
    }
    assert.equal(entries.length, owners.length);
    assert.equal(new Set(entries.map((entry) => entry.catalogEntryId)).size, owners.length);
    assert.ok(entries.every((entry) => entry.entryKind === memberKind));
    assert.deepEqual(
      entries.map((entry) => entry.catalogEntryId).sort(),
      owners.map((owner) => owner.id).sort(),
    );
    assert.deepEqual(
      entries.slice(0, 20),
      lookupRobloxApiCatalog({ ...selection, limit: 20 }).entries,
    );
  }
});

test("class owners include inherited members with their original provenance", () => {
  const result = lookupRobloxApiCatalog({
    ownerName: "Model",
    query: "GetPivot",
    memberKind: "method",
  });
  const entry = result.entries[0]!;
  assert.equal(entry.name, "GetPivot");
  assert.equal(entry.owner, "PVInstance");
  assert.equal(entry.sourceFile, "classes/PVInstance.yaml");
  assert.deepEqual(entry, getRobloxApiCatalogLookupEntry(entry.catalogEntryId));
  assert.equal(result.limit, 20);
  assert.equal(result.nextCursor, undefined);
});

test("owner discovery surfaces class-specific APIs before common Instance members", () => {
  const prompt = lookupRobloxApiCatalog({ ownerName: "ProximityPrompt" });
  assert.ok(
    prompt.entries.every((entry) => entry.owner === undefined || entry.owner === "ProximityPrompt"),
  );
  for (const name of [
    "Triggered",
    "PromptButtonHoldBegan",
    "HoldDuration",
    "MaxActivationDistance",
  ])
    assert.ok(
      prompt.entries.some((entry) => entry.name === name),
      name,
    );

  const light = lookupRobloxApiCatalog({ ownerName: "PointLight" });
  assert.deepEqual(
    light.entries.slice(0, 6).map((entry) => [entry.owner, entry.name]),
    [
      [undefined, "PointLight"],
      ["PointLight", "Range"],
      ["Light", "Brightness"],
      ["Light", "Color"],
      ["Light", "Enabled"],
      ["Light", "Shadows"],
    ],
  );

  // ManualWeld and its immediate parent declare no members. JointInstance
  // still precedes Instance, and the deprecated class remains accurately marked.
  const weld = lookupRobloxApiCatalog({ ownerName: "ManualWeld" });
  assert.equal(weld.entries[0]?.name, "ManualWeld");
  assert.equal(weld.entries[0]?.deprecated, true);
  assert.deepEqual(
    weld.entries.slice(1, 8).map((entry) => [entry.owner, entry.name]),
    ["Active", "C0", "C1", "Enabled", "Part0", "Part1", "part1"].map((name) => [
      "JointInstance",
      name,
    ]),
  );
  for (const result of [prompt, light, weld])
    for (const entry of result.entries)
      assert.deepEqual(entry, getRobloxApiCatalogLookupEntry(entry.catalogEntryId));
});

test("exact inherited queries outrank broader direct-class matches", () => {
  // The inherited exact Size match must precede the direct TextSize substring hit.
  const result = lookupRobloxApiCatalog({ ownerName: "TextButton", query: "Size" });
  assert.equal(result.entries[0]?.name, "Size");
  assert.equal(result.entries[0]?.owner, "GuiObject");
  assert.ok(
    result.entries.some((entry) => entry.name === "TextSize" && entry.owner === "TextButton"),
  );
});

test("owner-ranked pagination retains the complete effective surface and its authority facts", () => {
  for (const ownerName of ["ProximityPrompt", "PointLight", "ManualWeld", "TextButton"]) {
    const selection = { ownerName, limit: 7 };
    let result = lookupRobloxApiCatalog(selection);
    const entries = [...result.entries];
    while (result.nextCursor) {
      result = lookupRobloxApiCatalog({ ...selection, cursor: result.nextCursor });
      entries.push(...result.entries);
    }
    const ids = entries.map((entry) => entry.catalogEntryId);
    assert.equal(new Set(ids).size, entries.length, ownerName);
    assert.deepEqual(
      ids.sort(),
      [
        ROBLOX_API_CATALOG.classes.find((entry) => entry.name === ownerName)!.id,
        ...resolveRobloxClassMembers(ownerName).map((entry) => entry.id),
      ].sort(),
      ownerName,
    );
    assert.deepEqual(entries.slice(0, 20), lookupRobloxApiCatalog({ ownerName }).entries);
    for (const entry of entries)
      assert.deepEqual(entry, getRobloxApiCatalogLookupEntry(entry.catalogEntryId));
  }
});

test("datatype owners and a same-name class/datatype union expose constructors", () => {
  for (const ownerName of ["Instance", "CFrame", "Vector3"]) {
    const result = lookupRobloxApiCatalog({ ownerName, query: "new", memberKind: "constructor" });
    assert.ok(result.entries.length > 0, ownerName);
    assert.ok(result.entries.every((entry) => entry.entryKind === "datatype_constructor"));
    assert.equal(result.entries[0]?.name, "new");
    assert.equal(result.entries[0]?.owner, ownerName);
    assert.equal(result.entries[0]?.disposition, "source_only");
  }
  const qualified = lookupRobloxApiCatalog({ query: "Instance.new" });
  assert.equal(qualified.entries[0]?.entryKind, "datatype_constructor");
  const inherited = lookupRobloxApiCatalog({ ownerName: "Instance", query: "WaitForChild" });
  assert.equal(inherited.entries[0]?.entryKind, "class_method");
});

test("library and enum owners expose function signatures and exact enum values", () => {
  const wait = lookupRobloxApiCatalog({ ownerName: "task", query: "wait", memberKind: "function" })
    .entries[0]!;
  assert.equal(wait.name, "wait");
  assert.equal(wait.entryKind, "library_function");
  assert.equal(wait.sourceFile, "libraries/task.yaml");
  assert.ok(wait.parameters);
  assert.ok(wait.returns);
  const materials = lookupRobloxApiCatalog({
    ownerName: "Material",
    memberKind: "enum_item",
    limit: 64,
  });
  const expected = ROBLOX_API_CATALOG.enums.find((entry) => entry.name === "Material")!;
  assert.equal(materials.total, expected.items.length);
  for (const entry of materials.entries) {
    assert.equal(entry.entryKind, "enum_item");
    assert.equal(
      entry.enumValue,
      expected.items.find((item) => item.id === entry.catalogEntryId)?.value,
    );
  }
});

test("all matches can be paged deterministically without omissions or duplicates", () => {
  const selection = { ownerName: "Model", memberKind: "method" as const, limit: 7 };
  const first = lookupRobloxApiCatalog(selection);
  assert.ok(first.nextCursor);
  assert.deepEqual(first, lookupRobloxApiCatalog(selection));
  let page = first;
  const ids: string[] = [];
  do {
    ids.push(...page.entries.map((entry) => entry.catalogEntryId));
    if (!page.nextCursor) break;
    page = lookupRobloxApiCatalog({ ...selection, cursor: page.nextCursor });
    assert.equal(page.total, first.total);
    assert.ok(page.entries.length <= selection.limit);
    assert.ok(ids.length <= first.total);
  } while (true);
  assert.equal(page.truncated, false);
  assert.equal(ids.length, first.total);
  assert.equal(new Set(ids).size, first.total);
  const larger = lookupRobloxApiCatalog({ ...selection, limit: 64 });
  assert.deepEqual(
    ids.slice(0, 64),
    larger.entries.map((entry) => entry.catalogEntryId),
  );
  for (const changed of [
    { query: "Get" },
    { ownerName: "Instance" },
    { memberKind: "property" as const },
    { limit: 8 },
  ])
    assert.throws(
      () => lookupRobloxApiCatalog({ ...selection, ...changed, cursor: first.nextCursor! }),
      /cursor/,
    );
  for (const cursor of ["START", "0", first.nextCursor!.replace(/:[0-9]+$/, ":999999999")])
    assert.throws(() => lookupRobloxApiCatalog({ ...selection, cursor }), /cursor/);
});

test("relevant nondeprecated and exact-case rows rank before deprecated aliases", () => {
  for (const query of ["UserId", "userId", "userid"]) {
    const result = lookupRobloxApiCatalog({ ownerName: "Player", query, memberKind: "property" });
    assert.equal(result.entries[0]?.name, "UserId");
    assert.equal(result.entries[0]?.deprecated, false);
    assert.ok(result.entries.some((entry) => entry.name === "userId" && entry.deprecated));
  }
});

test("invalid owners explain discovery and superseded or out-of-bound inputs reject", () => {
  assert.throws(
    () => lookupRobloxApiCatalog({ ownerName: "SharedRemote" }),
    /not a project instance name.*Omit ownerName and search query/,
  );
  assert.throws(
    () => lookupRobloxApiCatalog({ ownerName: "Task" }),
    /exact API class, datatype, enum or library/,
  );
  assert.throws(() => lookupRobloxApiCatalog({ ownerName: "Model", limit: 65 }), /limit/);
  assert.throws(() => lookupRobloxApiCatalog({ ownerName: "Model", limit: 0 }), /limit/);
  assert.throws(() => lookupRobloxApiCatalog({}), /ownerName or query/);
  assert.throws(
    () => lookupRobloxApiCatalog({ ownerName: "Model", memberKind: "class_method" } as never),
    /member kind is invalid/,
  );
  // A clean break: supplying the former selector is rejected even with a valid query.
  assert.throws(
    () => lookupRobloxApiCatalog({ className: "Model", query: "GetPivot" } as never),
    /unknown field/,
  );
});

test("misses retain empty exact results while exposing bounded catalog navigation", () => {
  const prompt = lookupRobloxApiCatalog({ ownerName: "ProximityPrompt", query: "PromptTriggered" });
  assert.equal(prompt.total, 0);
  assert.deepEqual(prompt.entries, []);
  assert.deepEqual(prompt.selection, { ownerName: "ProximityPrompt", query: "PromptTriggered" });
  assert.equal(prompt.nextCursor, undefined);
  assert.equal(prompt.missContext?.reason, "no_matches");
  const trigger = prompt.missContext?.suggestions.find(({ entry }) => entry.name === "Triggered");
  assert.equal(trigger?.relation, "same_owner_member");
  assert.equal(trigger?.entry.entryKind, "class_event");
  assert.equal(trigger?.entry.owner, "ProximityPrompt");
  assert.ok(trigger?.entry.parameters);
  const childName = lookupRobloxApiCatalog({ ownerName: "Player", query: "PlayerGui" });
  assert.equal(childName.total, 0);
  assert.deepEqual(childName.entries, []);
  const owner = childName.missContext?.suggestions.find(({ entry }) => entry.name === "PlayerGui");
  assert.equal(owner?.relation, "exact_api_owner");
  assert.equal(owner?.entry.entryKind, "class");
  assert.notEqual(
    owner?.entry.owner,
    "Player",
    "A catalog class is not invented as a Player property",
  );
  for (const result of [prompt, childName]) {
    assert.deepEqual(result, lookupRobloxApiCatalog(result.selection));
    assert.ok(result.missContext!.suggestions.length <= 6);
    assert.ok(
      result.missContext!.suggestions.reduce(
        (bytes, hint) => bytes + Buffer.byteLength(JSON.stringify(hint)),
        0,
      ) <= 16_384,
    );
    for (const hint of result.missContext!.suggestions)
      assert.deepEqual(hint.entry, getRobloxApiCatalogLookupEntry(hint.entry.catalogEntryId));
  }
});

test("invalid API owners remain rejected with labeled complete alternatives", () => {
  for (const request of [
    { ownerName: "Task", query: "wait" },
    { ownerName: "Character", query: "Died" },
  ]) {
    assert.throws(
      () => lookupRobloxApiCatalog(request),
      (error: unknown) => {
        assert.ok(error instanceof RobloxApiLookupError);
        assert.equal(error.missContext.reason, "unknown_owner");
        assert.deepEqual(error.missContext.requested, request);
        assert.ok(error.missContext.suggestions.length <= 6);
        const member = error.missContext.suggestions.find(
          ({ entry }) => entry.name === request.query,
        );
        assert.equal(member?.relation, "member_of_other_owner");
        assert.ok(member?.entry.parameters);
        for (const hint of error.missContext.suggestions)
          assert.deepEqual(hint.entry, getRobloxApiCatalogLookupEntry(hint.entry.catalogEntryId));
        return true;
      },
    );
  }
  const actual = lookupRobloxApiCatalog({ ownerName: "RemoteEvent", query: "OnServerEvent" });
  assert.equal(actual.entries[0]?.entryKind, "class_event");
  assert.equal(actual.missContext, undefined, "Successful exact facts are unchanged");
  assert.ok(actual.entries[0]?.parameters);
  assert.deepEqual(
    actual.entries[0],
    getRobloxApiCatalogLookupEntry(actual.entries[0]!.catalogEntryId),
  );
});
