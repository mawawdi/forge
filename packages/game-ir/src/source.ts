import { z } from "zod";
import { entityId, hashSchema } from "./primitives.js";

export const GAME_SOURCE_CONTENT_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("locked"),
      sourceHash: hashSchema,
      utf8Bytes: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({ kind: z.literal("slot"), maximumUtf8Bytes: z.number().int().positive().safe() })
    .strict(),
]);
export type GameSourceContent = z.infer<typeof GAME_SOURCE_CONTENT_SCHEMA>;
export const GAME_STUDIO_IDENTITY_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("forge_attribute"), stableId: z.string().min(1).max(512) }).strict(),
  z
    .object({
      kind: z.literal("studio_ephemeral"),
      connectorEpoch: z.string().min(1).max(512),
      opaqueHash: hashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("rojo_sourcemap"),
      authorityMapHash: hashSchema,
      sourcemapHash: hashSchema,
      mappingId: z.string().min(1).max(512),
    })
    .strict(),
]);
const identity = GAME_STUDIO_IDENTITY_SCHEMA;
const target = z
  .object({
    kind: z.literal("instance"),
    identity,
    path: z.string().min(1),
    className: z.string().min(1),
  })
  .strict();
export const GAME_PLACEMENT_PARENT_SCHEMA = z.union([
  target,
  z
    .object({
      kind: z.literal("engine_container"),
      path: z.string().min(1),
      className: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("generated"), operationId: entityId }).strict(),
]);
export type GamePlacementParent = z.infer<typeof GAME_PLACEMENT_PARENT_SCHEMA>;
export const GAME_SOURCE_PLACEMENT_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observed"), target }).strict(),
  z
    .object({
      operationId: entityId,
      kind: z.literal("create"),
      parent: GAME_PLACEMENT_PARENT_SCHEMA,
      name: z.string().min(1),
      className: z.enum(["Script", "LocalScript", "ModuleScript"]),
    })
    .strict(),
  z
    .object({
      operationId: entityId,
      kind: z.literal("edit_source"),
      target,
      beforeSourceHash: hashSchema,
      beforeSourceBytes: z.number().int().nonnegative().safe(),
    })
    .strict(),
]);
export type GameSourcePlacement = z.infer<typeof GAME_SOURCE_PLACEMENT_SCHEMA>;
