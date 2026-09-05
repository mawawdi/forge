import { stableJson } from "../../packages/contracts/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  canonicalStudioValue,
  type StudioValue,
} from "../../packages/studio-evidence/src/index.js";

type ManifestProperty = (typeof STUDIO_CAPABILITY_MANIFEST.classes)[number]["properties"][number];

function boundedNumber(property: ManifestProperty): number {
  const minimum = "minimum" in property ? property.minimum : undefined;
  const exclusiveMinimum = "minimumExclusive" in property ? property.minimumExclusive : undefined;
  const maximum = "maximum" in property ? property.maximum : undefined;
  let value = exclusiveMinimum === undefined ? (minimum ?? 0) : exclusiveMinimum + 1;
  if (maximum !== undefined && value > maximum) value = maximum;
  return value;
}

function neutralPropertyValue(property: ManifestProperty): StudioValue {
  const number = boundedNumber(property);
  switch (property.codec) {
    case "boolean":
      return { kind: "boolean", value: false };
    case "number_f32":
    case "number_f64":
      return { kind: property.codec, value: number };
    case "int32":
      return { kind: "int32", value: Math.trunc(number) };
    case "int64_decimal":
      return { kind: "int64_decimal", value: "0" };
    case "string_utf8": {
      const minimumUtf8Bytes =
        "minimumUtf8Bytes" in property ? (property.minimumUtf8Bytes ?? 0) : 0;
      return { kind: "string_utf8", value: "x".repeat(minimumUtf8Bytes) };
    }
    case "content":
      return { kind: "content", value: "rbxassetid://0" };
    case "color3_rgb8":
      return { kind: "color3_rgb8", r: 0, g: 0, b: 0 };
    case "vector2_f32":
      return { kind: "vector2_f32", x: number, y: number };
    case "vector3_f32":
      return { kind: "vector3_f32", x: number, y: number, z: number };
    case "cframe_f32x12":
      return {
        kind: "cframe_f32x12",
        components: [number, number, number, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      };
    case "udim":
      return { kind: "udim", scale: number, offset: Math.trunc(number) };
    case "udim2":
      return {
        kind: "udim2",
        x: { scale: number, offset: Math.trunc(number) },
        y: { scale: number, offset: Math.trunc(number) },
      };
    case "rect":
      return { kind: "rect", minX: number, minY: number, maxX: number, maxY: number };
    case "number_range":
      return { kind: "number_range", min: number, max: number };
    case "number_sequence":
      return {
        kind: "number_sequence",
        keypoints: [
          { time: 0, value: number, envelope: number },
          { time: 1, value: number, envelope: number },
        ],
      };
    case "color_sequence":
      return {
        kind: "color_sequence",
        keypoints: [
          { time: 0, color: { r: 0, g: 0, b: 0 } },
          { time: 1, color: { r: 0, g: 0, b: 0 } },
        ],
      };
    case "brick_color":
      return { kind: "brick_color", name: property.allowed?.[0] ?? "Medium stone grey" };
    case "font":
      return {
        kind: "font",
        family: "rbxasset://fonts/families/Arial.json",
        weight: "Regular",
        style: "Normal",
      };
    case "physical_properties":
      return {
        kind: "physical_properties",
        density: Math.max(1, number),
        friction: number,
        elasticity: number,
        frictionWeight: number,
        elasticityWeight: number,
        acousticAbsorption: number,
      };
    case "axes":
      return { kind: "axes", x: false, y: false, z: false };
    case "faces":
      return {
        kind: "faces",
        top: false,
        bottom: false,
        left: false,
        right: false,
        front: false,
        back: false,
      };
    case "ray":
      return {
        kind: "ray",
        origin: { x: number, y: number, z: number },
        direction: { x: number, y: number, z: number },
      };
    case "instance_ref":
      return {
        kind: "instance_ref",
        state: "nil",
        expectedClass: property.referenceClass ?? "Instance",
      };
    case "enum_name":
      return { kind: "enum_name", value: property.allowed?.[0] ?? "Default" };
  }
}

function canonicalFixtureValue(value: StudioValue): StudioValue {
  return JSON.parse(stableJson(canonicalStudioValue(value))) as StudioValue;
}

/**
 * Produce the exact complete manifest property surface expected from a real
 * Studio project-index node. Unknown classes deliberately have no coverage.
 */
export function completeProjectProperties(
  className: string,
  overrides: Readonly<Record<string, StudioValue>> = {},
): Readonly<Record<string, StudioValue>> {
  const metadata = STUDIO_CAPABILITY_MANIFEST.classes.find((entry) => entry.name === className);
  if (metadata === undefined) return overrides;
  return Object.fromEntries(
    metadata.properties
      .map((property): [string, StudioValue] => [
        property.name,
        canonicalFixtureValue(
          Object.hasOwn(overrides, property.name)
            ? overrides[property.name]!
            : neutralPropertyValue(property),
        ),
      ])
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

export function completeProjectPropertyNames(className: string): readonly string[] {
  return Object.keys(completeProjectProperties(className));
}
