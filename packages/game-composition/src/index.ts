export { CompositionError } from "./common.js";
export type { CompositionContext, CompositionOutput } from "./common.js";
export * from "./scene.js";
export * from "./ui.js";
export * from "./patch.js";
export * from "./assembly.js";
export * from "./lighting.js";
export * from "./scene-arrangement.js";
import { SCENE_PRIMITIVES_CONFIG_SCHEMA } from "./scene.js";
import { RESPONSIVE_UI_CONFIG_SCHEMA } from "./ui.js";
import { STUDIO_PATCH_CONFIG_SCHEMA } from "./patch.js";
import { PROJECT_ASSEMBLY_CONFIG_SCHEMA } from "./assembly.js";
import { SCENE_LIGHTING_CONFIG_SCHEMA } from "./lighting.js";
import { SCENE_ARRANGEMENT_CONFIG_SCHEMA } from "./scene-arrangement.js";

/** The same validators consumed by the trusted compilers and provider proposal schema. */
export const COMPOSITION_CONFIG_SCHEMAS: ReadonlyMap<string, z.ZodType> = new Map([
  ["scene-primitives", SCENE_PRIMITIVES_CONFIG_SCHEMA],
  ["responsive-ui", RESPONSIVE_UI_CONFIG_SCHEMA],
  ["studio-patch", STUDIO_PATCH_CONFIG_SCHEMA],
  ["project-assembly", PROJECT_ASSEMBLY_CONFIG_SCHEMA],
  ["scene-lighting", SCENE_LIGHTING_CONFIG_SCHEMA],
  ["scene-arrangement", SCENE_ARRANGEMENT_CONFIG_SCHEMA],
] as Array<[string, z.ZodType]>);
import type { z } from "zod";
