import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  DEFAULT_GAME_ADMISSION_POLICY,
  assertBoundedGameJson,
} from "../packages/game-ir/src/primitives.js";
import {
  GAME_DATA_SCHEMA,
  canonicalGameDataSchema,
  gameDataMatchesSchema,
} from "../packages/game-ir/src/recipes.js";
import { resolveCreatorGameComponentInput } from "../packages/creator-session/src/game-authoring.js";

test("closed string enums derive code-point bounds and canonical hashes", () => {
  const input = { type: "string", enum: ["🚀", "é", "launch"] } as const;
  const canonical = canonicalGameDataSchema(
    GAME_DATA_SCHEMA.parse(input),
    DEFAULT_GAME_ADMISSION_POLICY,
  );
  assert.deepEqual(canonical, { type: "string", enum: ["launch", "é", "🚀"], maxLength: 6 });
  assert.equal(
    contentHash(stableJson(canonical)),
    contentHash(
      stableJson(
        canonicalGameDataSchema({ ...input, maxLength: 6 }, DEFAULT_GAME_ADMISSION_POLICY),
      ),
    ),
  );
  for (const value of input.enum) assert.equal(gameDataMatchesSchema(value, input), true);
  assert.equal(gameDataMatchesSchema("other", input), false);
  assert.equal(gameDataMatchesSchema("", { type: "string", enum: [""] }), true);
  assert.equal(GAME_DATA_SCHEMA.safeParse({ type: "string" }).success, false);
  assert.equal(GAME_DATA_SCHEMA.safeParse({ type: "string", enum: [] }).success, false);
});

test("derived enum bounds preserve explicit constraints and UTF-8 admission", () => {
  const unicode = { type: "string", enum: ["🚀"] } as const;
  assert.equal(
    (canonicalGameDataSchema(unicode, DEFAULT_GAME_ADMISSION_POLICY) as { maxLength: number })
      .maxLength,
    1,
  );
  assert.equal(
    Buffer.byteLength("🚀", "utf8"),
    4,
    "Network.maximumBytes is not the code-point bound",
  );
  for (const invalid of [
    { type: "string", enum: ["same", "same"] },
    { type: "string", enum: ["long"], maxLength: 3 },
    { type: "string", enum: ["a"], minLength: 2 },
    { type: "string", enum: ["a"], pattern: "^[A-Z]$" },
  ])
    assert.throws(() =>
      canonicalGameDataSchema(GAME_DATA_SCHEMA.parse(invalid), DEFAULT_GAME_ADMISSION_POLICY),
    );
  assert.throws(() =>
    assertBoundedGameJson("🚀", { ...DEFAULT_GAME_ADMISSION_POLICY, maximumStringUtf8Bytes: 3 }),
  );
  assert.throws(() =>
    assertBoundedGameJson({ type: "string", enum: ["\ud800"] }, DEFAULT_GAME_ADMISSION_POLICY),
  );
});

test("nested source ports resolve enum bounds before component reference hashing", () => {
  const component = {
    kind: "source_package" as const,
    id: "signals",
    obligations: [],
    ports: [
      {
        id: "state",
        direction: "output" as const,
        fileId: "module",
        schema: {
          type: "object" as const,
          properties: { phase: { type: "string" as const, enum: ["awake", "asleep"] } },
          required: ["phase"],
          additionalProperties: false as const,
        },
      },
    ],
    files: [
      {
        id: "module",
        path: "State.luau",
        context: "shared" as const,
        role: "module" as const,
        content: { kind: "slot" as const, maximumUtf8Bytes: 1024 },
        imports: [],
        placement: {
          kind: "create" as const,
          operationId: "install-state",
          name: "State",
          parent: { kind: "engine_container" as const, path: "ReplicatedStorage" as const },
        },
      },
    ],
  };
  const resolved = resolveCreatorGameComponentInput(component);
  assert.throws(
    () =>
      resolveCreatorGameComponentInput(component, {
        ...DEFAULT_GAME_ADMISSION_POLICY,
        maximumStringUtf8Bytes: 5,
      }),
    /schema|length|bound|maximum/i,
    "Component admission keeps the draft's stricter policy",
  );
  assert.equal(resolved.kind, "source_package");
  if (resolved.kind !== "source_package") return;
  assert.deepEqual(resolved.ports[0]!.schema, {
    type: "object",
    properties: { phase: { type: "string", enum: ["asleep", "awake"], maxLength: 6 } },
    required: ["phase"],
    additionalProperties: false,
  });
});
