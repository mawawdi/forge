"""Strict, dependency-free wire and geometry contracts for the remote worker."""

import hashlib
import json
import math
import re

import rfc8785

MAX_OBJ_BYTES = 16 * 1024 * 1024
MAX_VERTICES = 300_000
MAX_FACES = 500_000
MAX_JOB_BYTES = 32 * 1024
ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}\Z")
JOB_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")


def canonical(value):
    return rfc8785.dumps(value)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data, maximum=MAX_JOB_BYTES):
    if len(data) > maximum:
        raise ValueError("JSON exceeds byte limit")

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("Nonfinite JSON number")

    try:
        value = json.loads(data, object_pairs_hook=pairs, parse_constant=constant)
        pending = [(value, 0)]
        while pending:
            item, depth = pending.pop()
            if depth > 32:
                raise ValueError("JSON exceeds depth limit")
            if type(item) is dict:
                pending.extend((child, depth + 1) for child in item.values())
            elif type(item) is list:
                pending.extend((child, depth + 1) for child in item)
        return value
    except (RecursionError, UnicodeError) as error:
        raise ValueError("Invalid or excessively deep JSON") from error


def fields(value, required):
    if type(value) is not dict or set(value) != set(required):
        raise ValueError("Unexpected or missing fields: " + ",".join(required))


def text(value, maximum):
    if (type(value) is not str or not value.strip() or len(value.encode("utf-8")) > maximum
            or any(ord(char) < 32 and char not in "\n\t" for char in value)):
        raise ValueError("Invalid bounded text")


def validate_job(value):
    if type(value) is not dict:
        raise ValueError("Job must be an object")
    common = ["kind", "jobId", "operation", "seed", "installationHash"]
    operation = value.get("operation")
    fields(value, common + (["prompt", "bounds"] if operation == "cube3d"
                            else ["input", "parts"] if operation == "cubepart" else []))
    if value["kind"] != "CubeRemoteJob" or operation not in ("cube3d", "cubepart"):
        raise ValueError("Unsupported job kind or operation")
    if type(value["jobId"]) is not str or not JOB_ID.fullmatch(value["jobId"]):
        raise ValueError("Invalid jobId")
    if type(value["installationHash"]) is not str or not HASH.fullmatch(value["installationHash"]):
        raise ValueError("Invalid installationHash")
    if type(value["seed"]) is not int or not 0 <= value["seed"] <= 2**31 - 1:
        raise ValueError("Seed must be a nonnegative int32")
    if operation == "cube3d":
        text(value["prompt"], 4096)
        fields(value["bounds"], ["x", "y", "z"])
        for size in value["bounds"].values():
            if type(size) not in (int, float) or not math.isfinite(size) or not 0 < size <= 2048:
                raise ValueError("Bounds must be finite positive numbers at most 2048")
    else:
        fields(value["input"], ["path", "sha256", "bytes"])
        pin = value["input"]
        if (pin["path"] != "input.obj" or type(pin["sha256"]) is not str
                or not HASH.fullmatch(pin["sha256"]) or type(pin["bytes"]) is not int
                or not 0 < pin["bytes"] <= MAX_OBJ_BYTES):
            raise ValueError("CubePart requires one pinned input.obj")
        if type(value["parts"]) is not list or not 1 <= len(value["parts"]) <= 8:
            raise ValueError("Pinned CubePart supports one through eight parts")
        names = set()
        for part in value["parts"]:
            fields(part, ["id", "prompt"])
            if type(part["id"]) is not str or not ID.fullmatch(part["id"]) or part["id"] in names:
                raise ValueError("Invalid or duplicate part id")
            names.add(part["id"])
            text(part["prompt"], 2048)
    if len(canonical(value)) > MAX_JOB_BYTES:
        raise ValueError("Job exceeds byte limit")
    return value


def parse_obj(data):
    """Only plain geometry is admitted. No material files, URLs or plugin importers."""
    if not 0 < len(data) <= MAX_OBJ_BYTES:
        raise ValueError("OBJ byte limit exceeded")
    vertices, faces = [], []
    for line in data.decode("utf-8").splitlines():
        row = line.split("#", 1)[0].split()
        if not row:
            continue
        if row[0] == "v" and len(row) == 4:
            vertex = [float(n) for n in row[1:]]
            if not all(math.isfinite(n) and abs(n) <= 1e6 for n in vertex):
                raise ValueError("Invalid OBJ vertex")
            vertices.append(vertex)
        elif row[0] == "f" and len(row) == 4:
            face = []
            for item in row[1:]:
                if not re.fullmatch(r"[1-9][0-9]*", item):
                    raise ValueError("OBJ requires positive plain triangle indices")
                index = int(item) - 1
                if index >= len(vertices):
                    raise ValueError("OBJ face references unavailable vertex")
                face.append(index)
            if len(set(face)) != 3:
                raise ValueError("Degenerate OBJ face")
            faces.append(face)
        elif row[0] in ("o", "g") and all(ID.fullmatch(name) for name in row[1:]):
            continue
        else:
            raise ValueError("Unsupported OBJ record: " + row[0])
        if len(vertices) > MAX_VERTICES or len(faces) > MAX_FACES:
            raise ValueError("OBJ geometry limit exceeded")
    if not vertices or not faces:
        raise ValueError("Empty mesh")
    referenced = {i for face in faces for i in face}
    if len(referenced) != len(vertices):
        raise ValueError("Input OBJ contains unreferenced vertices")
    bounds = [[min(v[axis] for v in vertices), max(v[axis] for v in vertices)] for axis in range(3)]
    extent = max(high - low for low, high in bounds)
    if extent <= 0:
        raise ValueError("Input mesh has no extent")
    return vertices, faces, {"center": [(low + high) / 2 for low, high in bounds],
                             "scale": 1.92 / extent}


def named_obj(parts, normalization=None):
    """Export all generated parts in one shared frame, with exact stable OBJ aliases."""
    lines, counts, offset, total_faces = [], [], 0, 0
    normalization = normalization or {"center": [0, 0, 0], "scale": 1}
    scale, center = normalization["scale"], normalization["center"]
    if not math.isfinite(scale) or scale <= 0 or len(center) != 3:
        raise ValueError("Invalid normalization")
    names = set()
    for name, vertices, faces in parts:
        if not ID.fullmatch(name) or name in names:
            raise ValueError("Invalid generated part alias")
        names.add(name)
        if vertices is None or faces is None or len(vertices) == 0 or len(faces) == 0:
            raise ValueError("Requested part has no generated geometry: " + name)
        offset_after = offset + len(vertices)
        total_faces += len(faces)
        if offset_after > MAX_VERTICES or total_faces > MAX_FACES:
            raise ValueError("Generated mesh exceeds geometry budget")
        lines.append("o " + name)
        for vertex in vertices:
            if len(vertex) != 3:
                raise ValueError("Invalid generated vertex")
            restored = [float(vertex[axis]) / scale + center[axis] for axis in range(3)]
            if not all(math.isfinite(n) and abs(n) <= 1e6 for n in restored):
                raise ValueError("Invalid generated vertex")
            lines.append("v " + " ".join(format(n, ".17g") for n in restored))
        for face in faces:
            indices = [int(i) for i in face]
            if (len(indices) != 3 or any(i != original for i, original in zip(indices, face))
                    or min(indices) < 0 or max(indices) >= len(vertices) or len(set(indices)) != 3):
                raise ValueError("Invalid generated triangle")
            lines.append("f " + " ".join(str(i + offset + 1) for i in indices))
        counts.append({"id": name, "vertices": len(vertices), "triangles": len(faces)})
        offset = offset_after
    data = ("\n".join(lines) + "\n").encode("ascii")
    if len(data) > MAX_OBJ_BYTES:
        raise ValueError("Generated OBJ exceeds byte budget")
    return data, counts
