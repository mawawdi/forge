import { z } from "zod";
import { createHash } from "node:crypto";
import { contentHash, stableJson } from "../../contracts/src/index.js";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const GLB_VERSION = 2;
const SUPPORTED_EXTENSIONS = new Set([
  "KHR_materials_emissive_strength",
  "KHR_materials_unlit",
  "KHR_texture_transform",
]);
const componentBytes = new Map([
  [5120, 1],
  [5121, 1],
  [5122, 2],
  [5123, 2],
  [5125, 4],
  [5126, 4],
]);
const typeComponents = new Map([
  ["SCALAR", 1],
  ["VEC2", 2],
  ["VEC3", 3],
  ["VEC4", 4],
  ["MAT2", 4],
  ["MAT3", 9],
  ["MAT4", 16],
]);
const textureReference = z
  .object({
    index: z.number().int().nonnegative(),
    texCoord: z.literal(0).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const pbrMetallicRoughness = z
  .object({
    baseColorFactor: z.array(z.number().finite().min(0).max(1)).length(4).optional(),
    baseColorTexture: textureReference.optional(),
    metallicFactor: z.number().finite().min(0).max(1).optional(),
    roughnessFactor: z.number().finite().min(0).max(1).optional(),
    metallicRoughnessTexture: textureReference.optional(),
  })
  .passthrough();

const gltfSchema = z
  .object({
    asset: z.object({ version: z.literal("2.0") }).passthrough(),
    scene: z.number().int().nonnegative().optional(),
    scenes: z
      .array(z.object({ nodes: z.array(z.number().int().nonnegative()).optional() }).passthrough())
      .optional(),
    nodes: z
      .array(
        z
          .object({
            name: z.string().min(1).max(256).optional(),
            children: z.array(z.number().int().nonnegative()).optional(),
            mesh: z.number().int().nonnegative().optional(),
            matrix: z.array(z.number().finite()).length(16).optional(),
            translation: z.array(z.number().finite()).length(3).optional(),
            rotation: z.array(z.number().finite()).length(4).optional(),
            scale: z.array(z.number().finite()).length(3).optional(),
            skin: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .default([]),
    meshes: z
      .array(
        z
          .object({
            name: z.string().optional(),
            primitives: z
              .array(
                z
                  .object({
                    attributes: z.record(z.string(), z.number().int().nonnegative()),
                    indices: z.number().int().nonnegative().optional(),
                    material: z.number().int().nonnegative().optional(),
                    mode: z.number().int().optional(),
                  })
                  .passthrough(),
              )
              .min(1),
          })
          .passthrough(),
      )
      .default([]),
    buffers: z
      .array(
        z
          .object({ byteLength: z.number().int().nonnegative(), uri: z.string().optional() })
          .passthrough(),
      )
      .default([]),
    bufferViews: z
      .array(
        z
          .object({
            buffer: z.number().int().nonnegative(),
            byteOffset: z.number().int().nonnegative().optional(),
            byteLength: z.number().int().nonnegative(),
            byteStride: z.number().int().positive().optional(),
          })
          .passthrough(),
      )
      .default([]),
    accessors: z
      .array(
        z
          .object({
            bufferView: z.number().int().nonnegative().optional(),
            byteOffset: z.number().int().nonnegative().optional(),
            componentType: z.number().int(),
            count: z.number().int().nonnegative(),
            type: z.string(),
            normalized: z.boolean().optional(),
            sparse: z.unknown().optional(),
          })
          .passthrough(),
      )
      .default([]),
    materials: z
      .array(
        z
          .object({
            name: z.string().optional(),
            pbrMetallicRoughness: pbrMetallicRoughness.optional(),
            normalTexture: textureReference
              .extend({ scale: z.number().finite().min(0).max(2).optional() })
              .optional(),
            occlusionTexture: textureReference
              .extend({ strength: z.number().finite().min(0).max(1).optional() })
              .optional(),
            emissiveTexture: textureReference.optional(),
            emissiveFactor: z.array(z.number().finite().min(0)).length(3).optional(),
            alphaMode: z.enum(["OPAQUE", "MASK", "BLEND"]).optional(),
            alphaCutoff: z.number().finite().min(0).max(1).optional(),
            doubleSided: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
    images: z
      .array(
        z
          .object({
            bufferView: z.number().int().nonnegative().optional(),
            mimeType: z.enum(["image/png", "image/jpeg"]).optional(),
            uri: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    textures: z
      .array(
        z
          .object({
            source: z.number().int().nonnegative().optional(),
            sampler: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .default([]),
    samplers: z
      .array(
        z
          .object({
            magFilter: z.union([z.literal(9728), z.literal(9729)]).optional(),
            minFilter: z
              .union([
                z.literal(9728),
                z.literal(9729),
                z.literal(9984),
                z.literal(9985),
                z.literal(9986),
                z.literal(9987),
              ])
              .optional(),
            wrapS: z.union([z.literal(33071), z.literal(33648), z.literal(10497)]).optional(),
            wrapT: z.union([z.literal(33071), z.literal(33648), z.literal(10497)]).optional(),
          })
          .strict(),
      )
      .default([]),
    extensionsUsed: z.array(z.string()).optional(),
    extensionsRequired: z.array(z.string()).optional(),
    animations: z.array(z.unknown()).optional(),
    skins: z.array(z.unknown()).optional(),
  })
  .passthrough();

export interface GlbNodeReport {
  name: string;
  parentName?: string;
  meshIndex?: number;
  triangleCount: number;
  worldMatrix: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  bounds?: { minimum: [number, number, number]; maximum: [number, number, number] };
}

export interface GlbInspectionReport {
  kind: "GlbInspectionReport";
  hash: string;
  byteLength: number;
  jsonHash: string;
  nodeCount: number;
  meshCount: number;
  triangleCount: number;
  materialCount: number;
  textureCount: number;
  images: Array<{
    index: number;
    mimeType: "image/png" | "image/jpeg";
    width: number;
    height: number;
    sha256: string;
  }>;
  nodes: GlbNodeReport[];
  extensions: string[];
}

export interface GlbInspectionOptions {
  maximumBytes?: number;
  maximumTriangles?: number;
  maximumTrianglesPerMesh?: number;
  maximumNodes?: number;
  maximumMaterials?: number;
  maximumTextures?: number;
  maximumTexturePixels?: number;
  expectedNodeNames?: readonly string[];
}

export function inspectTextureImage(
  bytes: Uint8Array,
  mimeType: "image/png" | "image/jpeg",
  maximumPixels = 4096 * 4096,
): { width: number; height: number; sha256: string } {
  const dimensions = mimeType === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (dimensions.width * dimensions.height > maximumPixels)
    throw new Error("Texture image exceeds the pixel budget");
  return {
    ...dimensions,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function inspectGlb(
  bytes: Uint8Array,
  options: GlbInspectionOptions = {},
): GlbInspectionReport {
  const limits = {
    maximumBytes: options.maximumBytes ?? 20 * 1024 * 1024,
    maximumTriangles: options.maximumTriangles ?? 2_000_000,
    maximumTrianglesPerMesh: options.maximumTrianglesPerMesh ?? 20_000,
    maximumNodes: options.maximumNodes ?? 8192,
    maximumMaterials: options.maximumMaterials ?? 512,
    maximumTextures: options.maximumTextures ?? 512,
    maximumTexturePixels: options.maximumTexturePixels ?? 4096 * 4096,
  };
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 20 ||
    bytes.byteLength > limits.maximumBytes
  )
    throw new Error("GLB byte length is outside the admitted range");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== GLB_VERSION)
    throw new Error("Malformed GLB header");
  if (view.getUint32(8, true) !== bytes.byteLength) throw new Error("GLB declared length mismatch");
  const chunks: Array<{ type: number; bytes: Uint8Array }> = [];
  let offset = 12;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error("Truncated GLB chunk header");
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 !== 0 || offset + length > bytes.byteLength)
      throw new Error("Malformed GLB chunk length");
    chunks.push({ type, bytes: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  if (chunks.length < 1 || chunks.length > 2 || chunks[0]!.type !== JSON_CHUNK)
    throw new Error("GLB requires one JSON chunk followed by at most one BIN chunk");
  if (chunks.length === 2 && chunks[1]!.type !== BIN_CHUNK)
    throw new Error("Unsupported GLB chunk");
  const jsonBytes = trimJsonPadding(chunks[0]!.bytes);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes));
  } catch {
    throw new Error("GLB JSON chunk is invalid UTF-8 JSON");
  }
  const gltf = gltfSchema.parse(decoded);
  if (gltf.animations?.length || gltf.skins?.length)
    throw new Error("Animations and skins are outside the current BlenderSceneSpec ABI");
  const extensions = [
    ...new Set([...(gltf.extensionsUsed ?? []), ...(gltf.extensionsRequired ?? [])]),
  ].sort();
  const unsupported = extensions.filter((entry) => !SUPPORTED_EXTENSIONS.has(entry));
  if (unsupported.length) throw new Error(`Unsupported GLB extensions: ${unsupported.join(", ")}`);
  validateExtensionPayloads(decoded, gltf.extensionsUsed ?? [], gltf.extensionsRequired ?? []);
  if (gltf.nodes.length > limits.maximumNodes) throw new Error("GLB node budget exceeded");
  if (gltf.materials.length > limits.maximumMaterials)
    throw new Error("GLB material budget exceeded");
  if (gltf.textures.length > limits.maximumTextures) throw new Error("GLB texture budget exceeded");
  if (gltf.buffers.length !== (chunks.length === 2 ? 1 : 0))
    throw new Error("GLB embedded buffer inventory is inconsistent");
  if (gltf.buffers.some((buffer) => buffer.uri !== undefined))
    throw new Error("GLB external buffer URI rejected");
  if (
    gltf.images.some(
      (image) => image.uri !== undefined || image.bufferView === undefined || !image.mimeType,
    )
  )
    throw new Error("GLB images must be supported embedded buffer views");
  const binary = chunks[1]?.bytes ?? new Uint8Array();
  if (
    gltf.buffers[0] &&
    (gltf.buffers[0].byteLength > binary.byteLength ||
      binary.byteLength - gltf.buffers[0].byteLength > 3)
  )
    throw new Error("GLB embedded buffer length is inconsistent");
  validateBufferViews(gltf, binary.byteLength);
  validateTextureReferences(gltf);
  const imageReports = inspectEmbeddedImages(gltf, binary, limits.maximumTexturePixels);
  const parents = validateNodeGraph(gltf.nodes);
  validateScenes(gltf, parents);
  const worldMatrices = nodeWorldMatrices(gltf.nodes, parents);

  const names = new Set<string>();
  const referencedMeshes = new Set<number>();
  const nodeReports: GlbNodeReport[] = [];
  let totalTriangles = 0;
  for (let index = 0; index < gltf.nodes.length; index += 1) {
    const node = gltf.nodes[index]!;
    const name = node.name ?? `unnamed-${index}`;
    const parentIndex = parents.get(index);
    const parentName =
      parentIndex === undefined
        ? undefined
        : (gltf.nodes[parentIndex]!.name ?? `unnamed-${parentIndex}`);
    const worldMatrix = worldMatrices[index]!;
    if (names.has(name)) throw new Error(`Duplicate GLB node name: ${name}`);
    names.add(name);
    if (node.mesh === undefined) {
      nodeReports.push({
        name,
        ...(parentName ? { parentName } : {}),
        triangleCount: 0,
        worldMatrix,
      });
      continue;
    }
    const mesh = gltf.meshes[node.mesh];
    if (!mesh) throw new Error(`GLB node references missing mesh: ${name}`);
    referencedMeshes.add(node.mesh);
    const materialIds = new Set(mesh.primitives.map((primitive) => primitive.material ?? -1));
    if (materialIds.size > 1) throw new Error(`GLB mesh uses multiple materials: ${name}`);
    let triangleCount = 0;
    let nodeBounds: GlbNodeReport["bounds"];
    for (const primitive of mesh.primitives) {
      if ((primitive.mode ?? 4) !== 4) throw new Error(`GLB mesh is not triangle mode: ${name}`);
      if (primitive.attributes.TEXCOORD_1 !== undefined)
        throw new Error(`GLB mesh uses more than one UV set: ${name}`);
      const positionIndex = primitive.attributes.POSITION;
      if (positionIndex === undefined) throw new Error(`GLB mesh lacks POSITION: ${name}`);
      const position = gltf.accessors[positionIndex];
      if (!position || position.type !== "VEC3" || position.componentType !== 5126)
        throw new Error(`GLB POSITION accessor must be float VEC3: ${name}`);
      for (const [attribute, accessorIndex] of Object.entries(primitive.attributes)) {
        const accessor = gltf.accessors[accessorIndex];
        if (!accessor) throw new Error(`GLB attribute ${attribute} is missing: ${name}`);
        if (accessor.count !== position.count)
          throw new Error(`GLB attribute ${attribute} count differs from POSITION: ${name}`);
        if (attribute === "NORMAL" && (accessor.type !== "VEC3" || accessor.componentType !== 5126))
          throw new Error(`GLB NORMAL accessor must be float VEC3: ${name}`);
        if (
          attribute === "TEXCOORD_0" &&
          (accessor.type !== "VEC2" || ![5121, 5123, 5126].includes(accessor.componentType))
        )
          throw new Error(`GLB TEXCOORD_0 accessor is unsupported: ${name}`);
        if (!["POSITION", "NORMAL", "TEXCOORD_0"].includes(attribute))
          throw new Error(`GLB attribute ${attribute} is unsupported: ${name}`);
        validateVertexAttributeValues(gltf, binary, accessorIndex, attribute, name);
      }
      const primitiveTriangles =
        primitive.indices === undefined
          ? position.count / 3
          : accessorCount(gltf, primitive.indices) / 3;
      if (!Number.isInteger(primitiveTriangles))
        throw new Error(`GLB triangle index count is invalid: ${name}`);
      if (primitive.indices !== undefined)
        validateTriangleIndices(gltf, binary, primitive.indices, position.count, name);
      triangleCount += primitiveTriangles;
      nodeBounds = unionBounds(
        nodeBounds,
        transformedAccessorBounds(gltf, binary, positionIndex, worldMatrix),
      );
      if (primitive.material !== undefined && !gltf.materials[primitive.material])
        throw new Error(`GLB primitive references missing material: ${name}`);
    }
    if (triangleCount > limits.maximumTrianglesPerMesh)
      throw new Error(`GLB mesh exceeds triangle limit: ${name}`);
    totalTriangles += triangleCount;
    nodeReports.push({
      name,
      ...(parentName ? { parentName } : {}),
      meshIndex: node.mesh,
      triangleCount,
      worldMatrix,
      ...(nodeBounds ? { bounds: nodeBounds } : {}),
    });
  }
  if (referencedMeshes.size !== gltf.meshes.length)
    throw new Error("GLB contains meshes outside the declared scene hierarchy");
  if (totalTriangles > limits.maximumTriangles)
    throw new Error("GLB aggregate triangle budget exceeded");
  if (options.expectedNodeNames) {
    const expected = [...options.expectedNodeNames].sort();
    const actual = nodeReports
      .filter((entry) => entry.meshIndex !== undefined)
      .map((entry) => entry.name)
      .sort();
    if (stableJson(actual) !== stableJson(expected))
      throw new Error(
        `GLB node inventory mismatch: expected ${expected.join(", ")}; found ${actual.join(", ")}`,
      );
  }
  const material = {
    kind: "GlbInspectionReport" as const,
    byteLength: bytes.byteLength,
    jsonHash: contentHash(new TextDecoder().decode(jsonBytes)),
    nodeCount: gltf.nodes.length,
    meshCount: gltf.meshes.length,
    triangleCount: totalTriangles,
    materialCount: gltf.materials.length,
    textureCount: gltf.textures.length,
    images: imageReports,
    nodes: nodeReports,
    extensions,
  };
  return { ...material, hash: contentHash(stableJson(material)) };
}

function validateBufferViews(gltf: z.infer<typeof gltfSchema>, binaryLength: number): void {
  for (const [index, bufferView] of gltf.bufferViews.entries()) {
    if (bufferView.buffer !== 0) throw new Error(`GLB bufferView ${index} uses missing buffer`);
    const start = bufferView.byteOffset ?? 0;
    if (start % 4 !== 0) throw new Error(`GLB bufferView ${index} is not four-byte aligned`);
    if (start + bufferView.byteLength > binaryLength)
      throw new Error(`GLB bufferView ${index} exceeds buffer`);
  }
  for (const [index, accessor] of gltf.accessors.entries()) {
    if (accessor.sparse !== undefined)
      throw new Error(`Sparse GLB accessor is unsupported: ${index}`);
    if (accessor.bufferView === undefined)
      throw new Error(`GLB accessor lacks bufferView: ${index}`);
    const bufferView = gltf.bufferViews[accessor.bufferView];
    const bytes = componentBytes.get(accessor.componentType);
    const components = typeComponents.get(accessor.type);
    if (!bufferView || !bytes || !components) throw new Error(`Invalid GLB accessor: ${index}`);
    const elementBytes = bytes * components;
    const stride = bufferView.byteStride ?? elementBytes;
    if (stride < elementBytes || stride % bytes !== 0)
      throw new Error(`Invalid GLB accessor stride: ${index}`);
    const start = accessor.byteOffset ?? 0;
    if (start % bytes !== 0) throw new Error(`GLB accessor is misaligned: ${index}`);
    const end = accessor.count === 0 ? start : start + stride * (accessor.count - 1) + elementBytes;
    if (end > bufferView.byteLength) throw new Error(`GLB accessor exceeds bufferView: ${index}`);
  }
}

function validateTextureReferences(gltf: z.infer<typeof gltfSchema>): void {
  for (const [index, texture] of gltf.textures.entries()) {
    if (texture.source === undefined || !gltf.images[texture.source])
      throw new Error(`GLB texture ${index} has no valid image source`);
    if (texture.sampler !== undefined && !gltf.samplers[texture.sampler])
      throw new Error(`GLB texture ${index} references a missing sampler`);
  }
  const check = (value: { index: number } | undefined, label: string): void => {
    if (value && !gltf.textures[value.index])
      throw new Error(`GLB ${label} references a missing texture`);
  };
  for (const material of gltf.materials) {
    check(material.pbrMetallicRoughness?.baseColorTexture, "base color");
    check(material.pbrMetallicRoughness?.metallicRoughnessTexture, "metallic roughness");
    check(material.normalTexture, "normal");
    check(material.occlusionTexture, "occlusion");
    check(material.emissiveTexture, "emissive");
  }
}

function validateVertexAttributeValues(
  gltf: z.infer<typeof gltfSchema>,
  binary: Uint8Array,
  accessorIndex: number,
  attribute: string,
  name: string,
): void {
  if (attribute === "POSITION") return;
  const accessor = gltf.accessors[accessorIndex]!;
  const bufferView = gltf.bufferViews[accessor.bufferView!]!;
  const componentSize = componentBytes.get(accessor.componentType)!;
  const componentCount = typeComponents.get(accessor.type)!;
  const stride = bufferView.byteStride ?? componentSize * componentCount;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  if (attribute === "NORMAL" && accessor.normalized)
    throw new Error(`GLB NORMAL accessor cannot be normalized float data: ${name}`);
  if (attribute === "TEXCOORD_0" && accessor.componentType !== 5126 && accessor.normalized !== true)
    throw new Error(`GLB integer TEXCOORD_0 accessor must be normalized: ${name}`);
  for (let element = 0; element < accessor.count; element += 1) {
    const values = Array.from({ length: componentCount }, (_, component) =>
      readAccessorComponent(
        view,
        start + element * stride + component * componentSize,
        accessor.componentType,
        accessor.normalized === true,
      ),
    );
    if (values.some((value) => !Number.isFinite(value)))
      throw new Error(`GLB ${attribute} contains nonfinite value: ${name}`);
    if (attribute === "NORMAL" && Math.abs(Math.hypot(...values) - 1) > 1e-3)
      throw new Error(`GLB NORMAL contains a non-unit vector: ${name}`);
  }
}

function readAccessorComponent(
  view: DataView,
  offset: number,
  componentType: number,
  normalized: boolean,
): number {
  const raw =
    componentType === 5120
      ? view.getInt8(offset)
      : componentType === 5121
        ? view.getUint8(offset)
        : componentType === 5122
          ? view.getInt16(offset, true)
          : componentType === 5123
            ? view.getUint16(offset, true)
            : componentType === 5125
              ? view.getUint32(offset, true)
              : view.getFloat32(offset, true);
  if (!normalized || componentType === 5126) return raw;
  if (componentType === 5120) return Math.max(raw / 127, -1);
  if (componentType === 5121) return raw / 255;
  if (componentType === 5122) return Math.max(raw / 32767, -1);
  if (componentType === 5123) return raw / 65535;
  return raw / 4294967295;
}

function validateExtensionPayloads(
  decoded: unknown,
  used: readonly string[],
  required: readonly string[],
): void {
  const usedSet = new Set(used);
  if (required.some((entry) => !usedSet.has(entry)))
    throw new Error("GLB required extensions must also be declared as used");
  const observed = new Set<string>();
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!isPlainRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key !== "extensions") {
        visit(child, `${path}.${key}`);
        continue;
      }
      if (!isPlainRecord(child)) throw new Error(`GLB extensions payload is malformed: ${path}`);
      for (const [extension, payload] of Object.entries(child)) {
        if (!SUPPORTED_EXTENSIONS.has(extension) || !usedSet.has(extension))
          throw new Error(`Undeclared or unsupported GLB extension payload: ${extension}`);
        observed.add(extension);
        validateExtensionPayload(extension, payload, path);
      }
    }
  };
  visit(decoded, "gltf");
  if (used.some((entry) => !observed.has(entry)))
    throw new Error("GLB declares an extension without an admitted payload");
}

function validateExtensionPayload(extension: string, payload: unknown, path: string): void {
  if (!isPlainRecord(payload)) throw new Error(`GLB ${extension} payload is malformed`);
  if (extension === "KHR_materials_unlit") {
    if (!/^gltf\.materials\[[0-9]+\]$/u.test(path) || Object.keys(payload).length !== 0)
      throw new Error("GLB unlit extension is outside a material or has unknown fields");
    return;
  }
  if (extension === "KHR_materials_emissive_strength") {
    if (!/^gltf\.materials\[[0-9]+\]$/u.test(path))
      throw new Error("GLB emissive-strength extension is outside a material");
    const keys = Object.keys(payload);
    const strength = payload.emissiveStrength;
    if (
      keys.length !== 1 ||
      typeof strength !== "number" ||
      !Number.isFinite(strength) ||
      strength < 0 ||
      strength > 100_000
    )
      throw new Error("GLB emissive-strength extension is malformed");
    return;
  }
  if (!/(?:Texture|normalTexture|occlusionTexture|emissiveTexture)$/u.test(path))
    throw new Error("GLB texture-transform extension is outside a texture reference");
  const allowed = new Set(["offset", "rotation", "scale", "texCoord"]);
  if (Object.keys(payload).some((key) => !allowed.has(key)))
    throw new Error("GLB texture-transform extension has unknown fields");
  const offset = payload.offset;
  const scale = payload.scale;
  const rotation = payload.rotation;
  const texCoord = payload.texCoord;
  if (offset !== undefined && !finiteTuple(offset, 2))
    throw new Error("GLB texture-transform offset is malformed");
  if (scale !== undefined && (!finiteTuple(scale, 2) || scale.some((value) => value === 0)))
    throw new Error("GLB texture-transform scale is malformed");
  if (rotation !== undefined && (typeof rotation !== "number" || !Number.isFinite(rotation)))
    throw new Error("GLB texture-transform rotation is malformed");
  if (texCoord !== undefined && texCoord !== 0)
    throw new Error("GLB texture-transform references an unsupported UV set");
}

function finiteTuple(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inspectEmbeddedImages(
  gltf: z.infer<typeof gltfSchema>,
  binary: Uint8Array,
  maximumPixels: number,
): GlbInspectionReport["images"] {
  return gltf.images.map((image, index) => {
    const bufferView = gltf.bufferViews[image.bufferView!];
    if (!bufferView) throw new Error(`GLB image ${index} references a missing bufferView`);
    const start = bufferView.byteOffset ?? 0;
    const bytes = binary.subarray(start, start + bufferView.byteLength);
    const inspected = inspectTextureImage(bytes, image.mimeType!, maximumPixels);
    return {
      index,
      mimeType: image.mimeType!,
      ...inspected,
    };
  });
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.byteLength < 33 ||
    signature.some((value, index) => bytes[index] !== value) ||
    new TextDecoder().decode(bytes.subarray(12, 16)) !== "IHDR"
  )
    throw new Error("GLB PNG image is malformed");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) throw new Error("GLB PNG image has empty dimensions");
  let offset = 8;
  let ended = false;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw new Error("GLB PNG image is truncated");
    const length = view.getUint32(offset, false);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) throw new Error("GLB PNG chunk exceeds image bytes");
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (type === "IEND") {
      if (end !== bytes.byteLength) throw new Error("GLB PNG image has trailing bytes");
      ended = true;
    }
    offset = end;
  }
  if (!ended) throw new Error("GLB PNG image has no IEND chunk");
  return { width, height };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new Error("GLB JPEG image is malformed");
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) throw new Error("GLB JPEG marker is malformed");
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd9) break;
    if (marker === 0xda) break;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength)
      throw new Error("GLB JPEG segment is truncated");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 7) throw new Error("GLB JPEG frame is malformed");
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      if (!width || !height) throw new Error("GLB JPEG image has empty dimensions");
      return { width, height };
    }
    offset += length;
  }
  throw new Error("GLB JPEG image has no supported frame header");
}

function validateTriangleIndices(
  gltf: z.infer<typeof gltfSchema>,
  binary: Uint8Array,
  accessorIndex: number,
  vertexCount: number,
  name: string,
): void {
  const accessor = gltf.accessors[accessorIndex]!;
  const bufferView = gltf.bufferViews[accessor.bufferView!]!;
  const componentSize = componentBytes.get(accessor.componentType)!;
  const stride = bufferView.byteStride ?? componentSize;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const indices: number[] = [];
  for (let index = 0; index < accessor.count; index += 1) {
    const offset = start + index * stride;
    const value =
      accessor.componentType === 5121
        ? view.getUint8(offset)
        : accessor.componentType === 5123
          ? view.getUint16(offset, true)
          : view.getUint32(offset, true);
    if (value >= vertexCount) throw new Error(`GLB index exceeds POSITION count: ${name}`);
    indices.push(value);
  }
  for (let index = 0; index < indices.length; index += 3)
    if (new Set(indices.slice(index, index + 3)).size !== 3)
      throw new Error(`GLB contains a degenerate indexed triangle: ${name}`);
}

function validateNodeGraph(nodes: z.infer<typeof gltfSchema>["nodes"]): Map<number, number> {
  const parents = new Map<number, number>();
  for (let index = 0; index < nodes.length; index += 1)
    for (const child of nodes[index]!.children ?? []) {
      if (!nodes[child]) throw new Error(`GLB node references missing child: ${child}`);
      if (parents.has(child)) throw new Error(`GLB node has multiple parents: ${child}`);
      parents.set(child, index);
    }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (index: number): void => {
    if (visited.has(index)) return;
    if (visiting.has(index)) throw new Error(`GLB node cycle includes ${index}`);
    visiting.add(index);
    for (const child of nodes[index]?.children ?? []) visit(child);
    visiting.delete(index);
    visited.add(index);
  };
  for (let index = 0; index < nodes.length; index += 1) visit(index);
  return parents;
}

function validateScenes(
  gltf: z.infer<typeof gltfSchema>,
  parents: ReadonlyMap<number, number>,
): void {
  if (gltf.scenes === undefined || gltf.scenes.length === 0)
    throw new Error("GLB requires an explicit scene");
  const sceneIndex = gltf.scene ?? 0;
  const scene = gltf.scenes[sceneIndex];
  if (!scene) throw new Error("GLB default scene is missing");
  const roots = scene.nodes ?? [];
  if (new Set(roots).size !== roots.length) throw new Error("GLB scene root is duplicated");
  for (const root of roots) {
    if (!gltf.nodes[root]) throw new Error(`GLB scene references missing root: ${root}`);
    if (parents.has(root)) throw new Error(`GLB scene root has a parent: ${root}`);
  }
  const reachable = new Set<number>();
  const visit = (index: number): void => {
    if (reachable.has(index)) return;
    reachable.add(index);
    for (const child of gltf.nodes[index]!.children ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  if (reachable.size !== gltf.nodes.length)
    throw new Error("GLB contains nodes outside the declared scene");
}

function accessorCount(gltf: z.infer<typeof gltfSchema>, index: number): number {
  const accessor = gltf.accessors[index];
  if (
    !accessor ||
    accessor.type !== "SCALAR" ||
    ![5121, 5123, 5125].includes(accessor.componentType)
  )
    throw new Error(`GLB index accessor is invalid: ${index}`);
  return accessor.count;
}

function transformedAccessorBounds(
  gltf: z.infer<typeof gltfSchema>,
  binary: Uint8Array,
  index: number,
  transform: GlbNodeReport["worldMatrix"],
): { minimum: [number, number, number]; maximum: [number, number, number] } {
  const accessor = gltf.accessors[index]!;
  const bufferView = gltf.bufferViews[accessor.bufferView!]!;
  const stride = bufferView.byteStride ?? 12;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < accessor.count; vertex += 1) {
    const position = [0, 1, 2].map((axis) =>
      view.getFloat32(start + vertex * stride + axis * 4, true),
    ) as [number, number, number];
    if (position.some((value) => !Number.isFinite(value)))
      throw new Error(`GLB POSITION contains nonfinite value: ${index}`);
    const transformed = transformPoint(transform, position);
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis]!, transformed[axis]!);
      maximum[axis] = Math.max(maximum[axis]!, transformed[axis]!);
    }
  }
  return { minimum, maximum };
}

function nodeWorldMatrices(
  nodes: z.infer<typeof gltfSchema>["nodes"],
  parents: ReadonlyMap<number, number>,
): GlbNodeReport["worldMatrix"][] {
  const result: Array<GlbNodeReport["worldMatrix"] | undefined> = Array(nodes.length);
  const resolveMatrix = (index: number): GlbNodeReport["worldMatrix"] => {
    const existing = result[index];
    if (existing) return existing;
    const local = localMatrix(nodes[index]!);
    const parent = parents.get(index);
    const world = parent === undefined ? local : multiplyMatrix(resolveMatrix(parent), local);
    result[index] = world;
    return world;
  };
  return nodes.map((_, index) => resolveMatrix(index));
}

function localMatrix(
  node: z.infer<typeof gltfSchema>["nodes"][number],
): GlbNodeReport["worldMatrix"] {
  if (node.matrix) {
    if (node.translation || node.rotation || node.scale)
      throw new Error("GLB node cannot declare matrix and TRS together");
    return canonicalMatrix(node.matrix);
  }
  const [x, y, z, w] = (node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number];
  const length = Math.hypot(x, y, z, w);
  if (Math.abs(length - 1) > 1e-4) throw new Error("GLB node quaternion is not normalized");
  const qx = x / length;
  const qy = y / length;
  const qz = z / length;
  const qw = w / length;
  const [sx, sy, sz] = (node.scale ?? [1, 1, 1]) as [number, number, number];
  if (sx === 0 || sy === 0 || sz === 0) throw new Error("GLB node scale is singular");
  const [tx, ty, tz] = (node.translation ?? [0, 0, 0]) as [number, number, number];
  return canonicalMatrix([
    (1 - 2 * (qy * qy + qz * qz)) * sx,
    2 * (qx * qy + qz * qw) * sx,
    2 * (qx * qz - qy * qw) * sx,
    0,
    2 * (qx * qy - qz * qw) * sy,
    (1 - 2 * (qx * qx + qz * qz)) * sy,
    2 * (qy * qz + qx * qw) * sy,
    0,
    2 * (qx * qz + qy * qw) * sz,
    2 * (qy * qz - qx * qw) * sz,
    (1 - 2 * (qx * qx + qy * qy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ]);
}

function multiplyMatrix(
  left: GlbNodeReport["worldMatrix"],
  right: GlbNodeReport["worldMatrix"],
): GlbNodeReport["worldMatrix"] {
  const result = Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1)
    for (let row = 0; row < 4; row += 1)
      for (let index = 0; index < 4; index += 1)
        result[column * 4 + row]! += left[index * 4 + row]! * right[column * 4 + index]!;
  return canonicalMatrix(result);
}

function transformPoint(
  matrix: GlbNodeReport["worldMatrix"],
  point: [number, number, number],
): [number, number, number] {
  return [
    canonicalNumber(
      matrix[0]! * point[0] + matrix[4]! * point[1] + matrix[8]! * point[2] + matrix[12]!,
    ),
    canonicalNumber(
      matrix[1]! * point[0] + matrix[5]! * point[1] + matrix[9]! * point[2] + matrix[13]!,
    ),
    canonicalNumber(
      matrix[2]! * point[0] + matrix[6]! * point[1] + matrix[10]! * point[2] + matrix[14]!,
    ),
  ];
}

function canonicalMatrix(values: readonly number[]): GlbNodeReport["worldMatrix"] {
  if (values.length !== 16 || values.some((value) => !Number.isFinite(value)))
    throw new Error("GLB node transform is malformed");
  if (
    Math.abs(values[3]!) > 1e-7 ||
    Math.abs(values[7]!) > 1e-7 ||
    Math.abs(values[11]!) > 1e-7 ||
    Math.abs(values[15]! - 1) > 1e-7
  )
    throw new Error("GLB node transform is not affine");
  const determinant =
    values[0]! * (values[5]! * values[10]! - values[9]! * values[6]!) -
    values[4]! * (values[1]! * values[10]! - values[9]! * values[2]!) +
    values[8]! * (values[1]! * values[6]! - values[5]! * values[2]!);
  if (Math.abs(determinant) < 1e-10) throw new Error("GLB node transform is singular");
  return values.map(canonicalNumber) as GlbNodeReport["worldMatrix"];
}

function canonicalNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function unionBounds(
  left: GlbNodeReport["bounds"],
  right: NonNullable<GlbNodeReport["bounds"]>,
): NonNullable<GlbNodeReport["bounds"]> {
  if (!left) return right;
  return {
    minimum: left.minimum.map((value, index) => Math.min(value, right.minimum[index]!)) as [
      number,
      number,
      number,
    ],
    maximum: left.maximum.map((value, index) => Math.max(value, right.maximum[index]!)) as [
      number,
      number,
      number,
    ],
  };
}

function trimJsonPadding(bytes: Uint8Array): Uint8Array {
  let end = bytes.byteLength;
  while (end > 0 && [0x20, 0x00, 0x0a, 0x0d, 0x09].includes(bytes[end - 1]!)) end -= 1;
  return bytes.subarray(0, end);
}
