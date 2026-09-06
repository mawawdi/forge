import { z } from "zod";

export const DEFAULT_VISUAL_EVIDENCE_POLICY = Object.freeze({
  maximumImages: 4,
  maximumImageBytes: 4 * 1024 * 1024,
  maximumAggregateBytes: 8 * 1024 * 1024,
  maximumPixels: 16 * 1024 * 1024,
  maximumDimension: 8192,
  maximumInflatedBytes: 65 * 1024 * 1024,
  maximumAncillaryInflatedBytes: 1024 * 1024,
  maximumChunks: 4096,
});
export type VisualEvidencePolicy = { [K in keyof typeof DEFAULT_VISUAL_EVIDENCE_POLICY]: number };
export const visualHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const VISUAL_IMAGE_INPUT_SCHEMA = z
  .object({
    mimeType: z.literal("image/png"),
    base64: z
      .string()
      .min(4)
      .max(Math.ceil(DEFAULT_VISUAL_EVIDENCE_POLICY.maximumImageBytes / 3) * 4),
  })
  .strict();
export const VISUAL_CAPTION_SCHEMA = z.string().trim().min(1).max(2048);
export const VISUAL_REPORTED_FIELDS = {
  viewId: z.string().min(1).max(256).optional(),
  state: z.string().min(1).max(1024).optional(),
  graphicsSettings: z.string().min(1).max(1024).optional(),
};
export const VISUAL_OBSERVATION_INPUT_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reference"),
      image: VISUAL_IMAGE_INPUT_SCHEMA,
      caption: VISUAL_CAPTION_SCHEMA,
    })
    .strict(),
  z
    .object({
      kind: z.literal("rendered_view"),
      image: VISUAL_IMAGE_INPUT_SCHEMA,
      caption: VISUAL_CAPTION_SCHEMA,
      ...VISUAL_REPORTED_FIELDS,
    })
    .strict(),
]);
export type VisualObservationInput = z.infer<typeof VISUAL_OBSERVATION_INPUT_SCHEMA>;
export const VISUAL_OBSERVATION_BINDING_SCHEMA = z
  .object({
    projectId: z.string().min(1).max(256),
    revisionHash: visualHashSchema,
    planHash: visualHashSchema.optional(),
    buildHash: visualHashSchema.optional(),
    viewId: z.string().min(1).max(256).optional(),
  })
  .strict();
export type VisualObservationBinding = z.infer<typeof VISUAL_OBSERVATION_BINDING_SCHEMA>;
export interface VisualModelImage {
  mimeType: "image/png";
  base64: string;
  sha256: string;
  width: number;
  height: number;
}
export interface VisualObservation {
  kind: "VisualObservation";
  hash: string;
  source: "creator_upload";
  evidenceScope: "creator_reported_visual";
  bindingScope: "project_revision_at_submission";
  binding: VisualObservationBinding;
  observationKind: VisualObservationInput["kind"];
  caption: string;
  viewId?: string;
  state?: string;
  graphicsSettings?: string;
  image: VisualModelImage;
}
