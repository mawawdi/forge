from __future__ import annotations

import argparse
import json
import pathlib
from typing import Any

import bpy


ABI = "forge-blend-inspection@2"


def fail(message: str) -> None:
    raise RuntimeError(message)


def parse_arguments() -> argparse.Namespace:
    import sys

    arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--report", required=True)
    parser.add_argument("--scene-id", required=True)
    parser.add_argument("--revision", required=True, type=int)
    parser.add_argument("--blend-inspection", action="store_true")
    parser.add_argument("--binding-spec", required=True)
    return parser.parse_args(arguments)


def main() -> None:
    arguments = parse_arguments()
    scene = bpy.context.scene
    if scene.get("ForgeSceneId") != arguments.scene_id:
        fail("Blend scene identity mismatch")
    if int(scene.get("ForgeRevision", -1)) != arguments.revision:
        fail("Blend scene revision mismatch")
    if scene.get("ForgeSceneAbi") != "blender-scene-spec@2":
        fail("Blend scene ABI mismatch")
    objects: list[dict[str, Any]] = []
    for item in bpy.data.objects:
        stable_id = item.get("ForgeStableId")
        if stable_id is None:
            continue
        if item.type != "MESH":
            fail(f"Stable visual object is not a mesh: {stable_id}")
        objects.append(
            {
                "stableId": str(stable_id),
                "name": item.name,
                "partitionId": str(item.get("ForgePartitionId", "")),
                "meshVertices": len(item.data.vertices),
                "meshPolygons": len(item.data.polygons),
            }
        )
    objects.sort(key=lambda entry: entry["stableId"])
    if len({entry["stableId"] for entry in objects}) != len(objects):
        fail("Blend contains duplicate stable visual identities")
    report = {
        "kind": "ForgeBlendInspection",
        "abi": ABI,
        "sceneId": arguments.scene_id,
        "revision": arguments.revision,
        "objects": objects,
    }
    destination = pathlib.Path(arguments.report)
    with destination.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(report, handle, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        handle.write("\n")


if __name__ == "__main__":
    main()
