import { z } from "zod";
import { compareGameStrings, entityId, GameAdmissionError } from "./primitives.js";

const vector = z
  .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
  .strict();

/** Optional authored presentation intent. No genre, camera system or rendered result is implied. */
export const GAME_VISUAL_DIRECTION_SCHEMA = z
  .object({
    artDirection: z
      .string()
      .min(1)
      .max(8192)
      .describe(
        "The intended visual language: composition, silhouettes, material/color roles, lighting, detail hierarchy and interface treatment. Describe this project's choices, not a fixed style checklist or a claim of rendered quality.",
      ),
    views: z
      .array(
        z
          .object({
            id: entityId,
            name: z.string().min(1).max(160),
            componentIds: z
              .array(entityId)
              .min(1)
              .max(64)
              .describe("Declared components whose presentation this view reviews."),
            setup: z
              .string()
              .min(1)
              .max(1024)
              .describe(
                "Human-readable place, activity or interface state to capture. This is not executable code.",
              ),
            criteria: z
              .array(z.string().min(1).max(256))
              .min(1)
              .max(8)
              .describe(
                "Observable visual questions for the creator to assess in the rendered view.",
              ),
            viewport: z
              .object({
                width: z.number().int().min(1).max(16384),
                height: z.number().int().min(1).max(16384),
              })
              .strict()
              .optional(),
            camera: z
              .object({
                position: vector,
                lookAt: vector,
                fieldOfViewDegrees: z.number().finite().min(1).max(120),
              })
              .strict()
              .optional()
              .describe(
                "Optional world-space review framing in studs, with a vertical field of view. It does not install or move a Camera.",
              ),
            sceneViewId: entityId
              .optional()
              .describe(
                "Named review view in the bound BlenderSceneSpec. This reference carries no duplicate camera geometry.",
              ),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();

export type GameVisualDirection = z.infer<typeof GAME_VISUAL_DIRECTION_SCHEMA>;

/** Called after bounded plain-JSON and schema admission; canonicalizes the parsed copy only. */
export function validateGameVisualDirection(
  direction: GameVisualDirection,
  componentIds: ReadonlySet<string>,
): void {
  const ids = new Set<string>();
  for (const view of direction.views) {
    if (ids.has(view.id))
      throw new GameAdmissionError(
        "duplicate_visual_view",
        view.id,
        "Visual view IDs must be unique",
      );
    ids.add(view.id);
    if (
      new Set(view.componentIds).size !== view.componentIds.length ||
      view.componentIds.some((id) => !componentIds.has(id))
    )
      throw new GameAdmissionError(
        "invalid_visual_implementation",
        view.id,
        "Visual views must reference distinct declared components",
      );
    if (view.camera) {
      if (view.sceneViewId)
        throw new GameAdmissionError(
          "duplicate_visual_camera_authority",
          view.id,
          "A visual review view cannot declare camera geometry and reference a scene view",
        );
      const { position, lookAt } = view.camera;
      const distance = Math.hypot(
        position.x - lookAt.x,
        position.y - lookAt.y,
        position.z - lookAt.z,
      );
      if (!Number.isFinite(distance) || distance < 0.001)
        throw new GameAdmissionError(
          "invalid_visual_camera",
          view.id,
          "Review camera needs distinct finite position and lookAt points at least 0.001 studs apart",
        );
    }
    view.componentIds.sort(compareGameStrings);
  }
  direction.views.sort((a, b) => compareGameStrings(a.id, b.id));
}

/** These statements are ordinary creator review obligations, never machine verification. */
export function gameVisualReviewStatements(direction?: GameVisualDirection): string[] {
  return (
    direction?.views.map((view) => {
      const viewport = view.viewport
        ? ` At ${view.viewport.width}×${view.viewport.height} pixels.`
        : "";
      const camera = view.camera
        ? ` Camera position ${JSON.stringify(view.camera.position)}, look at ${JSON.stringify(view.camera.lookAt)}, vertical field of view ${view.camera.fieldOfViewDegrees}°.`
        : "";
      const sceneView = view.sceneViewId ? ` Scene view ${view.sceneViewId}.` : "";
      return `${view.name}: ${view.setup}${viewport}${camera}${sceneView} Review: ${view.criteria.join("; ")}`;
    }) ?? []
  );
}
