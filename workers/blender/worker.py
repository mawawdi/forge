"""Fixed Forge BlenderSceneSpec ABI 1 compiler.

This file is the only Python entrypoint admitted by the host compiler. Scene JSON
selects data operations from the closed implementation below; it cannot supply
Python, paths, expressions, nodes, callbacks, or Blender launch arguments.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pathlib
import sys
from typing import Any

import bpy
from mathutils import Matrix, Vector


SPEC_ABI = "blender-scene-spec@2"
EXPORT_PREFIX = "Forge_"
COORDINATE_MATRIX = Matrix(((1.0, 0.0, 0.0, 0.0), (0.0, 0.0, -1.0, 0.0), (0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 0.0, 1.0)))
ALLOWED_OUTPUT_KINDS = {
    "blend",
    "glb",
    "native_semantics",
    "geometry_report",
    "material_report",
    "budget_report",
    "review_render",
}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
ADMITTED_RENDER_PNG_CHUNKS = {
    b"IHDR", b"PLTE", b"IDAT", b"IEND", b"cHRM", b"gAMA", b"iCCP", b"sBIT",
    b"sRGB", b"cICP", b"tRNS", b"bKGD", b"hIST", b"pHYs", b"tEXt", b"iTXt",
    b"zTXt", b"eXIf", b"iDOT", b"tIME",
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def parse_arguments() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--directive", required=True)
    parser.add_argument("--inputs", required=True)
    parser.add_argument("--outputs", required=True)
    result = parser.parse_args(argv)
    for value in (result.spec, result.directive, result.inputs, result.outputs):
        if not os.path.isabs(value):
            fail("Worker paths must be absolute")
    return result


def inside(root: pathlib.Path, path: pathlib.Path) -> bool:
    try:
        path.relative_to(root)
        return path != root
    except ValueError:
        return False


def safe_output(root: pathlib.Path, relative: str) -> pathlib.Path:
    if not relative or relative.startswith(("/", ".")) or "\\" in relative:
        fail("Invalid output path")
    path = (root / relative).resolve()
    if not inside(root, path):
        fail("Output path escapes private directory")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def load_spec(path: pathlib.Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 64 * 1024 * 1024:
        fail("Unsafe scene-spec file")
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict) or value.get("kind") != "BlenderSceneSpec" or value.get("abi") != SPEC_ABI:
        fail("Unsupported scene specification")
    if set(value) != {
        "kind", "abi", "sceneId", "revision", "parent", "projectId", "creatorRequestHash",
        "visualBriefHash", "referenceHashes", "seed", "compiler", "visualBrief", "sources",
        "textures", "frames", "zones", "verticalLayers", "routes", "landmarks", "geometries",
        "materials", "objects", "instances", "sockets", "collections", "partitions", "collisionProxies",
        "gameplayAnchors", "interactiveProps", "effects", "reviewViews", "constraints",
        "provenance", "budgets", "expectedOutputs", "geometryAnalysis",
    } and set(value) != {
        "kind", "abi", "sceneId", "revision", "projectId", "creatorRequestHash",
        "visualBriefHash", "referenceHashes", "seed", "compiler", "visualBrief", "sources",
        "textures", "frames", "zones", "verticalLayers", "routes", "landmarks", "geometries",
        "materials", "objects", "instances", "sockets", "collections", "partitions", "collisionProxies",
        "gameplayAnchors", "interactiveProps", "effects", "reviewViews", "constraints",
        "provenance", "budgets", "expectedOutputs", "geometryAnalysis",
    }:
        fail("Scene specification fields do not match ABI 2")
    return value


def load_directive(path: pathlib.Path, spec: dict[str, Any]) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 64 * 1024:
        fail("Unsafe compiler-directive file")
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict) or set(value) != {"kind", "reusedPartitionIds", "reusedViewIds"}:
        fail("Malformed compiler directive")
    if value["kind"] != "ForgeBlenderCompileDirective":
        fail("Unsupported compiler directive")
    for key, admitted in (
        ("reusedPartitionIds", {item["id"] for item in spec["partitions"]}),
        ("reusedViewIds", {item["id"] for item in spec["reviewViews"]}),
    ):
        entries = value[key]
        if (
            not isinstance(entries, list)
            or len(entries) > 512
            or len(entries) != len(set(entries))
            or any(not isinstance(item, str) or item not in admitted for item in entries)
        ):
            fail(f"Malformed compiler directive {key}")
    return value


def roblox_vector(value: dict[str, float]) -> Vector:
    return Vector((float(value["x"]), -float(value["z"]), float(value["y"])))


def roblox_matrix(value: dict[str, Any]) -> Matrix:
    position = value["position"]
    rotation = value["rotation"]
    scale = value["scale"]
    rx = Matrix.Rotation(math.radians(float(rotation["xDegrees"])), 4, "X")
    ry = Matrix.Rotation(math.radians(float(rotation["yDegrees"])), 4, "Y")
    rz = Matrix.Rotation(math.radians(float(rotation["zDegrees"])), 4, "Z")
    roblox = (
        Matrix.Translation(Vector((float(position["x"]), float(position["y"]), float(position["z"]))))
        @ rx
        @ ry
        @ rz
        @ Matrix.Diagonal(Vector((float(scale["x"]), float(scale["y"]), float(scale["z"]), 1.0)))
    )
    return COORDINATE_MATRIX @ roblox @ COORDINATE_MATRIX.inverted()


def export_name(stable_id: str) -> str:
    digest = hashlib.sha256(stable_id.encode("utf-8")).hexdigest()[:10]
    return f"{EXPORT_PREFIX}{stable_id}_{digest}"


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection != bpy.context.scene.collection:
            bpy.data.collections.remove(collection)


def mesh_from_roblox(name: str, vertices: list[tuple[float, float, float]], faces: list[tuple[int, ...]]) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(roblox_vector({"x": x, "y": y, "z": z})) for x, y, z in vertices], [], faces)
    mesh.validate(verbose=False)
    mesh.update()
    result = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(result)
    return result


def copy_mesh_object(source: bpy.types.Object, name: str) -> bpy.types.Object:
    result = source.copy()
    result.data = source.data.copy()
    result.name = name
    bpy.context.scene.collection.objects.link(result)
    return result


def apply_modifier(source: bpy.types.Object, geometry_id: str, modifier_type: str, configure: Any) -> bpy.types.Object:
    result = copy_mesh_object(source, f"Geometry_{geometry_id}")
    bpy.context.view_layer.objects.active = result
    result.select_set(True)
    modifier = result.modifiers.new(name=f"Forge_{modifier_type}", type=modifier_type)
    configure(modifier)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    result.select_set(False)
    return result


def create_solid(geometry: dict[str, Any]) -> bpy.types.Object:
    shape = geometry["shape"]
    segments = int(geometry["segments"])
    size = geometry["size"]
    if shape == "box":
        bpy.ops.mesh.primitive_cube_add()
    elif shape == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=max(3, segments // 2))
    elif shape == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=segments)
    elif shape == "cone":
        bpy.ops.mesh.primitive_cone_add(vertices=segments)
    elif shape == "torus":
        major = max(float(size["x"]), float(size["z"])) / 4.0
        minor = float(geometry.get("minorRadius", min(float(size["x"]), float(size["z"])) / 8.0))
        bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=segments, minor_segments=max(3, segments // 4))
    else:
        fail(f"Unsupported solid: {shape}")
    result = bpy.context.active_object
    result.name = f"Geometry_{geometry['id']}"
    result.dimensions = Vector((abs(float(size["x"])), abs(float(size["z"])), abs(float(size["y"]))))
    bpy.context.view_layer.objects.active = result
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return result


def profile_vertices(profile: dict[str, Any], y: float) -> list[tuple[float, float, float]]:
    return [(float(point["x"]), y, float(point["y"])) for point in profile["points"]]


def extrude_profile(geometry: dict[str, Any], profiles: dict[str, dict[str, Any]]) -> bpy.types.Object:
    profile = profiles[geometry["profileId"]]
    count = len(profile["points"])
    depth = float(geometry["depth"])
    vertices = profile_vertices(profile, -depth / 2.0) + profile_vertices(profile, depth / 2.0)
    faces: list[tuple[int, ...]] = []
    if profile["closed"]:
        faces.extend([tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))])
    limit = count if profile["closed"] else count - 1
    for index in range(limit):
        following = (index + 1) % count
        faces.append((index, following, following + count, index + count))
    return mesh_from_roblox(f"Geometry_{geometry['id']}", vertices, faces)


def revolve_profile(geometry: dict[str, Any], profiles: dict[str, dict[str, Any]]) -> bpy.types.Object:
    profile = profiles[geometry["profileId"]]
    points = profile["points"]
    segments = int(geometry["segments"])
    radians = math.radians(float(geometry["degrees"]))
    axis = geometry["axis"]
    vertices: list[tuple[float, float, float]] = []
    for segment in range(segments + (0 if float(geometry["degrees"]) == 360.0 else 1)):
        angle = radians * segment / segments
        for point in points:
            radius, height = float(point["x"]), float(point["y"])
            if axis == "x":
                vertices.append((height, radius * math.cos(angle), radius * math.sin(angle)))
            elif axis == "y":
                vertices.append((radius * math.cos(angle), height, radius * math.sin(angle)))
            else:
                vertices.append((radius * math.cos(angle), radius * math.sin(angle), height))
    rings = len(vertices) // len(points)
    faces: list[tuple[int, ...]] = []
    for ring in range(rings - 1 + (1 if float(geometry["degrees"]) == 360.0 else 0)):
        following_ring = (ring + 1) % rings
        for point_index in range(len(points) - 1):
            a = ring * len(points) + point_index
            b = following_ring * len(points) + point_index
            faces.append((a, b, b + 1, a + 1))
    return mesh_from_roblox(f"Geometry_{geometry['id']}", vertices, faces)


def loft_profiles(geometry: dict[str, Any], profiles: dict[str, dict[str, Any]]) -> bpy.types.Object:
    selected = [profiles[identifier] for identifier in geometry["profileIds"]]
    point_count = len(selected[0]["points"])
    if any(len(profile["points"]) != point_count for profile in selected):
        fail("Loft profiles require equal point counts")
    vertices: list[tuple[float, float, float]] = []
    for profile, offset in zip(selected, geometry["offsets"], strict=True):
        vertices.extend((float(point["x"]) + float(offset["x"]), float(offset["y"]), float(point["y"]) + float(offset["z"])) for point in profile["points"])
    faces: list[tuple[int, ...]] = []
    for layer in range(len(selected) - 1):
        for point_index in range(point_count if selected[layer]["closed"] else point_count - 1):
            following = (point_index + 1) % point_count
            a = layer * point_count + point_index
            b = (layer + 1) * point_count + point_index
            faces.append((a, b, (layer + 1) * point_count + following, layer * point_count + following))
    return mesh_from_roblox(f"Geometry_{geometry['id']}", vertices, faces)


def evaluated_curve_points(curve: dict[str, Any]) -> list[Vector]:
    authored = [Vector((float(point["x"]), float(point["y"]), float(point["z"]))) for point in curve["points"]]
    if curve["interpolation"] == "polyline":
        return authored + ([authored[0].copy()] if curve["closed"] else [])
    result: list[Vector] = []
    samples = int(curve["samplesPerSegment"])
    for index in range(0, len(authored) - 1, 3):
        a, b, c, d = authored[index : index + 4]
        for sample in range(samples + 1):
            if result and sample == 0:
                continue
            t = sample / samples
            u = 1.0 - t
            result.append((u ** 3) * a + (3 * u * u * t) * b + (3 * u * t * t) * c + (t ** 3) * d)
    if curve["closed"] and (result[0] - result[-1]).length > 1e-8:
        result.append(result[0].copy())
    return result


def sweep_profile(geometry: dict[str, Any], profiles: dict[str, dict[str, Any]], curves: dict[str, dict[str, Any]]) -> bpy.types.Object:
    profile = profiles[geometry["profileId"]]
    points = evaluated_curve_points(curves[geometry["curveId"]])
    count = len(profile["points"])
    vertices: list[tuple[float, float, float]] = []
    for index, location in enumerate(points):
        before = points[max(0, index - 1)]
        after = points[min(len(points) - 1, index + 1)]
        tangent = (after - before).normalized()
        reference = Vector((0.0, 1.0, 0.0)) if abs(tangent.y) < 0.99 else Vector((0.0, 0.0, 1.0))
        right = tangent.cross(reference).normalized()
        up = right.cross(tangent).normalized()
        for profile_point in profile["points"]:
            vertex = location + right * float(profile_point["x"]) + up * float(profile_point["y"])
            vertices.append((vertex.x, vertex.y, vertex.z))
    faces: list[tuple[int, ...]] = []
    for segment in range(len(points) - 1):
        for index in range(count if profile["closed"] else count - 1):
            following = (index + 1) % count
            a = segment * count + index
            b = (segment + 1) * count + index
            faces.append((a, b, (segment + 1) * count + following, segment * count + following))
    return mesh_from_roblox(f"Geometry_{geometry['id']}", vertices, faces)


def join_geometry(geometry_id: str, operands: list[bpy.types.Object]) -> bpy.types.Object:
    copies = [copy_mesh_object(operand, f"Join_{geometry_id}_{index}") for index, operand in enumerate(operands)]
    bpy.ops.object.select_all(action="DESELECT")
    for item in copies:
        item.select_set(True)
    bpy.context.view_layer.objects.active = copies[0]
    bpy.ops.object.join()
    result = bpy.context.active_object
    result.name = f"Geometry_{geometry_id}"
    result.select_set(False)
    return result


def import_external(geometry: dict[str, Any], inputs: pathlib.Path) -> bpy.types.Object:
    source_path = (inputs / f"{geometry['sourceId']}.glb").resolve()
    if not inside(inputs, source_path) or source_path.is_symlink() or not source_path.is_file():
        fail("External GLB is outside fixed input inventory")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(source_path), import_pack_images=False, merge_vertices=False)
    imported = [item for item in bpy.data.objects if item not in before and item.type == "MESH"]
    if not imported:
        fail("External GLB contains no mesh")
    result = join_geometry(geometry["id"], imported) if len(imported) > 1 else imported[0]
    result.name = f"Geometry_{geometry['id']}"
    return result


def compile_geometries(spec: dict[str, Any], inputs: pathlib.Path) -> dict[str, bpy.types.Object]:
    definitions = {entry["id"]: entry for entry in spec["geometries"]}
    profiles = {key: value for key, value in definitions.items() if value["kind"] == "profile"}
    curves = {key: value for key, value in definitions.items() if value["kind"] == "curve"}
    compiled: dict[str, bpy.types.Object] = {}
    visiting: set[str] = set()

    def build(identifier: str) -> bpy.types.Object:
        if identifier in compiled:
            return compiled[identifier]
        if identifier in visiting or identifier not in definitions:
            fail(f"Invalid geometry dependency: {identifier}")
        visiting.add(identifier)
        geometry = definitions[identifier]
        kind = geometry["kind"]
        if kind == "indexed_mesh":
            vertices = [(float(v["x"]), float(v["y"]), float(v["z"])) for v in geometry["vertices"]]
            result = mesh_from_roblox(f"Geometry_{identifier}", vertices, [tuple(face) for face in geometry["triangles"]])
        elif kind == "solid":
            result = create_solid(geometry)
        elif kind == "external_glb":
            result = import_external(geometry, inputs)
        elif kind == "extrude":
            result = extrude_profile(geometry, profiles)
        elif kind == "revolve":
            result = revolve_profile(geometry, profiles)
        elif kind == "loft":
            result = loft_profiles(geometry, profiles)
        elif kind == "sweep":
            result = sweep_profile(geometry, profiles, curves)
        elif kind == "join":
            result = join_geometry(identifier, [build(item) for item in geometry["operandIds"]])
        elif kind == "bevel":
            result = apply_modifier(build(geometry["operandId"]), identifier, "BEVEL", lambda modifier: (setattr(modifier, "width", float(geometry["width"])), setattr(modifier, "segments", int(geometry["segments"]))))
        elif kind == "solidify":
            result = apply_modifier(build(geometry["operandId"]), identifier, "SOLIDIFY", lambda modifier: setattr(modifier, "thickness", float(geometry["thickness"])))
        elif kind == "mirror":
            axis_index = {"x": 0, "y": 2, "z": 1}[geometry["axis"]]
            result = apply_modifier(build(geometry["operandId"]), identifier, "MIRROR", lambda modifier: setattr(modifier, "use_axis", [axis_index == index for index in range(3)]))
        elif kind == "subdivide":
            result = apply_modifier(build(geometry["operandId"]), identifier, "SUBSURF", lambda modifier: (setattr(modifier, "levels", int(geometry["levels"])), setattr(modifier, "render_levels", int(geometry["levels"]))))
        elif kind == "boolean":
            right = build(geometry["rightId"])
            operation = geometry["operation"].upper()
            result = apply_modifier(build(geometry["leftId"]), identifier, "BOOLEAN", lambda modifier: (setattr(modifier, "operation", operation), setattr(modifier, "solver", "EXACT"), setattr(modifier, "object", right)))
        elif kind == "transform_geometry":
            result = copy_mesh_object(build(geometry["operandId"]), f"Geometry_{identifier}")
            result.matrix_world = roblox_matrix(geometry["transform"])
            bpy.context.view_layer.objects.active = result
            result.select_set(True)
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
            result.select_set(False)
        elif kind == "deform":
            result = copy_mesh_object(build(geometry["operandId"]), f"Geometry_{identifier}")
            deform_mesh(result, geometry)
        elif kind in {"profile", "curve"}:
            fail(f"Non-mesh geometry cannot be instantiated: {identifier}")
        else:
            fail(f"Unsupported geometry operation: {kind}")
        visiting.remove(identifier)
        result["ForgeGeometryId"] = identifier
        result.hide_render = True
        result.hide_set(True)
        compiled[identifier] = result
        return result

    for scene_object in spec["objects"]:
        build(scene_object["geometryId"])
    return compiled


def deform_mesh(result: bpy.types.Object, geometry: dict[str, Any]) -> None:
    axis = {"x": 0, "y": 2, "z": 1}[geometry["axis"]]
    amount = math.radians(float(geometry["amount"]))
    coordinates = [vertex.co[axis] for vertex in result.data.vertices]
    extent = max(max(coordinates) - min(coordinates), 1e-6)
    origin = min(coordinates)
    for vertex in result.data.vertices:
        ratio = (vertex.co[axis] - origin) / extent
        if geometry["mode"] == "taper":
            factor = max(0.01, 1.0 + math.degrees(amount) * ratio / 360.0)
            for index in range(3):
                if index != axis:
                    vertex.co[index] *= factor
        else:
            angle = amount * ratio
            indices = [index for index in range(3) if index != axis]
            first, second = vertex.co[indices[0]], vertex.co[indices[1]]
            if geometry["mode"] == "twist":
                vertex.co[indices[0]] = first * math.cos(angle) - second * math.sin(angle)
                vertex.co[indices[1]] = first * math.sin(angle) + second * math.cos(angle)
            else:
                radius = extent / amount if abs(amount) > 1e-6 else 0.0
                vertex.co[axis] = origin + math.sin(angle) * radius
                vertex.co[indices[0]] += (1.0 - math.cos(angle)) * radius
    result.data.update()


def create_materials(spec: dict[str, Any], inputs: pathlib.Path) -> dict[str, bpy.types.Material]:
    result: dict[str, bpy.types.Material] = {}
    textures = {entry["id"]: entry for entry in spec["textures"]}
    images: dict[str, bpy.types.Image] = {}
    for texture in spec["textures"]:
        extension = "png" if texture["mediaType"] == "image/png" else "jpg"
        source_path = (inputs / f"{texture['sourceId']}.{extension}").resolve()
        if not inside(inputs, source_path) or source_path.is_symlink() or not source_path.is_file():
            fail(f"Texture source is outside fixed input inventory: {texture['id']}")
        image = bpy.data.images.load(str(source_path), check_existing=False)
        if image.size[0] != int(texture["width"]) or image.size[1] != int(texture["height"]):
            fail(f"Texture dimensions changed during Blender decode: {texture['id']}")
        image.name = f"Texture_{texture['id']}"
        image.pack()
        images[texture["id"]] = image
    for definition in spec["materials"]:
        material = bpy.data.materials.new(f"Material_{definition['id']}")
        material.diffuse_color = tuple(float(definition["baseColor"][key]) for key in ("r", "g", "b", "a"))
        material.metallic = float(definition["metallic"])
        material.roughness = float(definition["roughness"])
        material.use_nodes = True
        node = material.node_tree.nodes.get("Principled BSDF")
        if node:
            node.inputs["Base Color"].default_value = material.diffuse_color
            node.inputs["Metallic IOR Level" if "Metallic IOR Level" in node.inputs else "Metallic"].default_value = material.metallic
            node.inputs["Roughness"].default_value = material.roughness
            node.inputs["Emission Color" if "Emission Color" in node.inputs else "Emission"].default_value = tuple(float(definition["emissive"][key]) for key in ("r", "g", "b", "a"))
            for texture_id in definition["textureIds"]:
                texture = textures[texture_id]
                texture_node = material.node_tree.nodes.new("ShaderNodeTexImage")
                texture_node.name = f"ForgeTexture_{texture_id}"
                texture_node.image = images[texture_id]
                role = texture["role"]
                if role != "base_color" and texture_node.image:
                    texture_node.image.colorspace_settings.name = "Non-Color"
                if role == "base_color":
                    material.node_tree.links.new(texture_node.outputs["Color"], node.inputs["Base Color"])
                elif role == "normal":
                    normal = material.node_tree.nodes.new("ShaderNodeNormalMap")
                    normal.name = f"ForgeNormal_{texture_id}"
                    material.node_tree.links.new(texture_node.outputs["Color"], normal.inputs["Color"])
                    material.node_tree.links.new(normal.outputs["Normal"], node.inputs["Normal"])
                elif role == "roughness":
                    material.node_tree.links.new(texture_node.outputs["Color"], node.inputs["Roughness"])
                elif role == "metalness":
                    metallic_input = "Metallic IOR Level" if "Metallic IOR Level" in node.inputs else "Metallic"
                    material.node_tree.links.new(texture_node.outputs["Color"], node.inputs[metallic_input])
                elif role == "emissive":
                    emission_input = "Emission Color" if "Emission Color" in node.inputs else "Emission"
                    material.node_tree.links.new(texture_node.outputs["Color"], node.inputs[emission_input])
                else:
                    fail(f"Unsupported texture role: {role}")
        material.surface_render_method = {"opaque": "DITHERED", "mask": "DITHERED", "blend": "BLENDED"}.get(definition["alphaMode"], "DITHERED")
        material["ForgeMaterialId"] = definition["id"]
        result[definition["id"]] = material
    return result


def link_only(collection: bpy.types.Collection, scene_object: bpy.types.Object) -> None:
    for existing in list(scene_object.users_collection):
        existing.objects.unlink(scene_object)
    collection.objects.link(scene_object)


def instantiate_scene(spec: dict[str, Any], geometries: dict[str, bpy.types.Object], materials: dict[str, bpy.types.Material]) -> tuple[dict[str, bpy.types.Collection], dict[str, bpy.types.Object]]:
    collections: dict[str, bpy.types.Collection] = {}
    for partition in spec["partitions"]:
        collection = bpy.data.collections.new(f"Partition_{partition['id']}")
        collection["ForgePartitionId"] = partition["id"]
        collection["ForgePartitionRole"] = partition["role"]
        bpy.context.scene.collection.children.link(collection)
        collections[partition["id"]] = collection
    object_definitions = {entry["id"]: entry for entry in spec["objects"]}
    objects: dict[str, bpy.types.Object] = {}
    for definition in spec["objects"]:
        scene_object = copy_mesh_object(geometries[definition["geometryId"]], export_name(definition["id"]))
        scene_object.hide_render = not definition["visible"]
        scene_object.hide_set(False)
        scene_object.matrix_world = roblox_matrix(definition["transform"])
        scene_object["ForgeStableId"] = definition["id"]
        scene_object["ForgePartitionId"] = definition["partitionId"]
        scene_object["ForgeSemanticRole"] = definition["semanticRole"]
        scene_object["ForgePivot"] = [float(definition["pivot"][axis]) for axis in ("x", "y", "z")]
        for material_id in definition["materialIds"]:
            scene_object.data.materials.append(materials[material_id])
        link_only(collections[definition["partitionId"]], scene_object)
        objects[definition["id"]] = scene_object
    expanded_instances: dict[str, list[bpy.types.Object]] = {}
    for definition in spec["instances"]:
        source_definition = object_definitions[definition["sourceObjectId"]]
        source = objects[definition["sourceObjectId"]]
        expanded_instances[definition["id"]] = []
        for index, transform in enumerate(definition["transforms"]):
            instance = source.copy()
            instance.data = source.data
            stable_id = f"{definition['id']}_{index:04d}"
            instance.name = export_name(stable_id)
            instance.matrix_world = roblox_matrix(transform)
            instance["ForgeStableId"] = stable_id
            instance["ForgePartitionId"] = definition["partitionId"]
            instance["ForgeInstanceIndex"] = index
            instance["ForgeSourceObjectId"] = source_definition["id"]
            link_only(collections[definition["partitionId"]], instance)
            expanded_instances[definition["id"]].append(instance)
            objects[stable_id] = instance
    authored_collections: dict[str, bpy.types.Collection] = {}
    for definition in spec["collections"]:
        authored = bpy.data.collections.new(f"ForgeCollection_{definition['id']}")
        authored["ForgeCollectionId"] = definition["id"]
        authored_collections[definition["id"]] = authored
    for definition in spec["collections"]:
        authored = authored_collections[definition["id"]]
        parent_id = definition.get("parentId")
        parent = authored_collections[parent_id] if parent_id else bpy.context.scene.collection
        parent.children.link(authored)
        for object_id in definition["objectIds"]:
            authored.objects.link(objects[object_id])
        for instance_id in definition["instanceIds"]:
            for instance in expanded_instances[instance_id]:
                authored.objects.link(instance)
    return collections, objects


def configure_scene(spec: dict[str, Any]) -> None:
    scene = bpy.context.scene
    scene["ForgeSceneId"] = spec["sceneId"]
    scene["ForgeRevision"] = int(spec["revision"])
    scene["ForgeSceneAbi"] = SPEC_ABI
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = False
    scene.cycles.seed = int(spec["seed"])
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 4
    scene.render.resolution_percentage = 100
    scene.render.use_file_extension = True
    scene.view_settings.exposure = 1.25
    scene.view_settings.look = "AgX - Medium High Contrast"
    atmosphere = next((effect for effect in spec["effects"] if effect["kind"] == "atmosphere"), None)
    if atmosphere:
        color = atmosphere["color"]
        decay = atmosphere["decay"]
        offset = float(atmosphere["offset"])
        ambient = tuple(
            float(color[axis]) * (1.0 - offset) + float(decay[axis]) * offset
            for axis in ("r", "g", "b")
        )
        strength = max(
            0.01,
            min(
                10.0,
                0.05
                + float(atmosphere["density"]) * 0.35
                + float(atmosphere["haze"]) * 0.04
                + float(atmosphere["glare"]) * 0.08,
            ),
        )
        scene.world.color = tuple(channel * strength for channel in ambient)
        scene.world.use_nodes = True
        background = scene.world.node_tree.nodes.get("Background")
        if background:
            background.inputs["Color"].default_value = ambient + (1.0,)
            background.inputs["Strength"].default_value = strength
    else:
        scene.world.color = (0.018, 0.025, 0.04)
    for effect in spec["effects"]:
        light_type = {"point_light": "POINT", "spot_light": "SPOT", "surface_light": "AREA"}.get(effect["kind"])
        if not light_type:
            continue
        light = bpy.data.lights.new(f"ReviewLight_{effect['id']}", type=light_type)
        light.color = tuple(float(effect["color"][axis]) for axis in ("r", "g", "b"))
        light.energy = float(effect["intensity"]) * 1000.0
        light.use_shadow = bool(effect["shadows"])
        if float(effect["range"]) > 0:
            light.use_custom_distance = True
            light.cutoff_distance = float(effect["range"])
        if light_type == "SPOT":
            light.spot_size = math.radians(float(effect["angleDegrees"]))
            light.spot_blend = 0.4
        elif light_type == "AREA":
            light.shape = "DISK"
            light.size = max(0.1, float(effect["range"]) * 0.25)
            light.spread = math.radians(float(effect["angleDegrees"]))
        light_object = bpy.data.objects.new(f"ReviewLight_{effect['id']}", light)
        bpy.context.scene.collection.objects.link(light_object)
        face_rotation = {
            "Bottom": Matrix.Identity(4),
            "Top": Matrix.Rotation(math.pi, 4, "X"),
            "Front": Matrix.Rotation(math.pi / 2.0, 4, "X"),
            "Back": Matrix.Rotation(-math.pi / 2.0, 4, "X"),
            "Right": Matrix.Rotation(-math.pi / 2.0, 4, "Y"),
            "Left": Matrix.Rotation(math.pi / 2.0, 4, "Y"),
        }.get(effect.get("face"), Matrix.Identity(4))
        light_object.matrix_world = roblox_matrix(effect["transform"]) @ face_rotation


def write_json(path: pathlib.Path, value: Any) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        handle.write("\n")


def normalize_render_png(path: pathlib.Path) -> None:
    data = path.read_bytes()
    if len(data) > 256 * 1024 * 1024 or not data.startswith(PNG_SIGNATURE):
        fail("Rendered PNG is missing, malformed, or oversized")
    normalized = bytearray(PNG_SIGNATURE)
    offset = len(PNG_SIGNATURE)
    ended = False
    while offset < len(data):
        if offset + 12 > len(data):
            fail("Rendered PNG contains a truncated chunk")
        length = int.from_bytes(data[offset : offset + 4], "big")
        end = offset + 12 + length
        if length > 0x7FFFFFFF or end > len(data):
            fail("Rendered PNG contains an invalid chunk length")
        chunk_type = data[offset + 4 : offset + 8]
        if chunk_type in ADMITTED_RENDER_PNG_CHUNKS:
            normalized.extend(data[offset:end])
        elif not chunk_type[0] & 0x20:
            fail(f"Rendered PNG contains unknown critical chunk {chunk_type!r}")
        if chunk_type == b"IEND":
            if end != len(data):
                fail("Rendered PNG contains trailing bytes")
            ended = True
        offset = end
    if not ended:
        fail("Rendered PNG has no IEND chunk")
    temporary = path.with_suffix(f"{path.suffix}.normalized")
    with temporary.open("xb") as handle:
        handle.write(normalized)
    os.replace(temporary, path)


def export_partition(path: pathlib.Path, partition: dict[str, Any], collection: bpy.types.Collection) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    candidates = [item for item in collection.all_objects if item.type == "MESH" and not item.hide_render]
    if not candidates:
        fail(f"GLB partition is empty: {partition['id']}")
    origin = roblox_vector(partition["localOrigin"])
    matrices = {item: item.matrix_world.copy() for item in candidates}
    for item in candidates:
        item.matrix_world.translation -= origin
        item.select_set(True)
    bpy.context.view_layer.objects.active = candidates[0]
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_extras=True,
        export_materials="EXPORT",
    )
    for item, matrix in matrices.items():
        item.matrix_world = matrix
        item.select_set(False)


def render_view(path: pathlib.Path, definition: dict[str, Any]) -> None:
    scene = bpy.context.scene
    camera_data = bpy.data.cameras.new(f"Camera_{definition['id']}")
    camera = bpy.data.objects.new(f"Camera_{definition['id']}", camera_data)
    scene.collection.objects.link(camera)
    camera.location = roblox_vector(definition["position"])
    target = roblox_vector(definition["lookAt"])
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.angle = math.radians(float(definition["fieldOfViewDegrees"]))
    scene.camera = camera
    scene.render.resolution_x = int(definition["width"])
    scene.render.resolution_y = int(definition["height"])
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    normalize_render_png(path)
    bpy.data.objects.remove(camera, do_unlink=True)
    bpy.data.cameras.remove(camera_data)


def reports(spec: dict[str, Any], objects: dict[str, bpy.types.Object]) -> dict[str, Any]:
    geometry_rows = []
    total_triangles = 0
    for stable_id, scene_object in sorted(objects.items()):
        mesh = scene_object.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
        mesh.calc_loop_triangles()
        triangles = len(mesh.loop_triangles)
        total_triangles += triangles
        corners = [scene_object.matrix_world @ Vector(corner) for corner in scene_object.bound_box]
        geometry_rows.append({
            "stableId": stable_id,
            "exportName": scene_object.name,
            "triangles": triangles,
            "blenderBounds": {
                "minimum": [min(corner[axis] for corner in corners) for axis in range(3)],
                "maximum": [max(corner[axis] for corner in corners) for axis in range(3)],
            },
        })
        scene_object.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()
    material_rows = [{"id": item["id"], "textureIds": item["textureIds"], "alphaMode": item["alphaMode"]} for item in spec["materials"]]
    return {
        "geometry_report": {"kind": "ForgeGeometryReport", "sceneId": spec["sceneId"], "revision": spec["revision"], "objects": geometry_rows},
        "material_report": {"kind": "ForgeMaterialReport", "sceneId": spec["sceneId"], "revision": spec["revision"], "materials": material_rows},
        "budget_report": {
            "kind": "ForgeBudgetReport",
            "sceneId": spec["sceneId"],
            "revision": spec["revision"],
            "objects": len(spec["objects"]),
            "expandedInstances": sum(len(item["transforms"]) for item in spec["instances"]),
            "triangles": total_triangles,
            "limits": spec["budgets"],
        },
        "native_semantics": {
            "kind": "ForgeNativeSceneSemantics",
            "sceneId": spec["sceneId"],
            "revision": spec["revision"],
            "coordinateProfile": {"scene": "roblox-y-up-studs", "blenderMapping": "x,-z,y"},
            "partitions": spec["partitions"],
            "collisionProxies": spec["collisionProxies"],
            "gameplayAnchors": spec["gameplayAnchors"],
            "interactiveProps": spec["interactiveProps"],
            "effects": spec["effects"],
            "sockets": spec["sockets"],
            "routes": spec["routes"],
        },
    }


def compile_scene(
    spec: dict[str, Any], directive: dict[str, Any], inputs: pathlib.Path, outputs: pathlib.Path
) -> None:
    clear_scene()
    configure_scene(spec)
    geometries = compile_geometries(spec, inputs)
    materials = create_materials(spec, inputs)
    collections, objects = instantiate_scene(spec, geometries, materials)
    generated_reports = reports(spec, objects)
    outputs_by_kind: dict[str, list[dict[str, Any]]] = {}
    for declaration in spec["expectedOutputs"]:
        if declaration["kind"] == "manifest":
            continue
        if declaration["kind"] not in ALLOWED_OUTPUT_KINDS:
            fail("Unknown compiler output kind")
        outputs_by_kind.setdefault(declaration["kind"], []).append(declaration)
    for declaration in spec["expectedOutputs"]:
        kind = declaration["kind"]
        if kind == "manifest":
            continue
        if kind == "glb" and declaration["partitionId"] in directive["reusedPartitionIds"]:
            continue
        if kind == "review_render" and declaration["viewId"] in directive["reusedViewIds"]:
            continue
        path = safe_output(outputs, declaration["relativePath"])
        if kind == "blend":
            bpy.ops.wm.save_as_mainfile(filepath=str(path), check_existing=False, compress=False)
        elif kind == "glb":
            partition = next(item for item in spec["partitions"] if item["id"] == declaration["partitionId"])
            export_partition(path, partition, collections[partition["id"]])
        elif kind == "review_render":
            view = next(item for item in spec["reviewViews"] if item["id"] == declaration["viewId"])
            render_view(path, view)
        else:
            write_json(path, generated_reports[kind])


def main() -> None:
    arguments = parse_arguments()
    spec_path = pathlib.Path(arguments.spec).resolve()
    directive_path = pathlib.Path(arguments.directive).resolve()
    inputs = pathlib.Path(arguments.inputs).resolve()
    outputs = pathlib.Path(arguments.outputs).resolve()
    if inputs.is_symlink() or outputs.is_symlink() or not inputs.is_dir() or not outputs.is_dir():
        fail("Worker directories are unsafe")
    spec = load_spec(spec_path)
    directive = load_directive(directive_path, spec)
    compile_scene(spec, directive, inputs, outputs)


if __name__ == "__main__":
    main()
