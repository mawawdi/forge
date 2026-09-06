"""Fixed upstream APIs. Imported GPU dependencies only run inside the child process."""

import os
from pathlib import Path
import random
import sys

from contracts import canonical, digest, named_obj, parse_obj, strict_json, validate_job
from installation import exclusive_json, gpu_probe, read_regular

SETTINGS = {
    "cube3d": {"engine": "Engine", "resolutionBase": 8.0, "topP": 0.95, "useKvCache": True},
    "cubepart": {"resolutionBase": 8.5, "guidanceScale": 7.5, "steps": 50,
                 "scheduler": "dpm_solver", "timeshift": 4.0, "samples": 128000},
}


def infer(job, root, directory):
    root, directory = Path(root), Path(directory)
    # Inference must fail on missing cached dependencies, never fetch from model hubs.
    os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                       "HF_DATASETS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"})
    sys.path[:0] = [str(root / "source"), str(root / "source/cubepart")]
    import numpy as np
    import torch
    probe = gpu_probe(job["operation"])
    random.seed(job["seed"])
    np.random.seed(job["seed"])
    torch.manual_seed(job["seed"])
    torch.cuda.manual_seed_all(job["seed"])
    normalization = None
    settings = SETTINGS[job["operation"]]
    if job["operation"] == "cube3d":
        from cube3d.inference.engine import Engine
        from cube3d.inference.utils import normalize_bbox
        engine = Engine(str(root / "configs/cube3d.yaml"),
                        str(root / "models/cube3d/shape_gpt.safetensors"),
                        str(root / "models/cube3d/shape_tokenizer.safetensors"),
                        device=torch.device("cuda"))
        bounds = normalize_bbox([job["bounds"][axis] for axis in ("x", "y", "z")])
        meshes = engine.t2s([job["prompt"]], use_kv_cache=True, resolution_base=8.0,
                           top_p=0.95, bounding_box_xyz=bounds)
        if len(meshes) != 1:
            raise ValueError("Cube3D returned an unexpected mesh count")
        parts = [("mesh", meshes[0][0], meshes[0][1])]
        coordinate_frame = "cube_normalized_aspect_conditioned"
    else:
        import trimesh
        from cube_part.pipelines import PartShapeDenoiserPipeline, ShapeInput
        from cube_part.utils.mesh import sample_surface
        # Avoid trimesh file loaders: the strict plain OBJ parser never loads external materials.
        data = read_regular(directory, "input.obj", job["input"]["bytes"])
        if len(data) != job["input"]["bytes"] or digest(data) != job["input"]["sha256"]:
            raise ValueError("Staged CubePart input changed")
        vertices, faces, normalization = parse_obj(data)
        normalized = (np.asarray(vertices) - np.asarray(normalization["center"])) * normalization["scale"]
        mesh = trimesh.Trimesh(vertices=normalized, faces=faces, process=False)
        pipe = PartShapeDenoiserPipeline(
            config_path=str(root / "configs/cubepart.yaml"),
            checkpoint_path=str(root / "models/cubepart/multi_part_dit.safetensors"),
            vae_checkpoint_path=str(root / "models/cubepart/vae.safetensors"),
            device="cuda", extract_geometry_fn_name="extract_geometry_coarse_to_fine")
        surface = sample_surface(mesh, num_samples=128000)
        surface = torch.from_numpy(surface).to(pipe.device).unsqueeze(0).float()
        latents, _ = pipe.encode_shape(surface)
        meshes = pipe.input_to_part_shape(
            ShapeInput(prompt=[[part["prompt"] for part in job["parts"]]], latents=latents),
            guidance_scale=7.5, resolution_base=8.5, scheduler_type="dpm_solver",
            timeshift=4.0, num_inference_steps=50, seed=job["seed"], output_mesh=True)
        if len(meshes) != len(job["parts"]):
            raise ValueError("CubePart did not return exactly the requested parts")
        parts = [(part["id"], mesh[0], mesh[1]) for part, mesh in zip(job["parts"], meshes)]
        coordinate_frame = "input_obj_common_frame"
    data, counts = named_obj(parts, normalization)
    with (directory / "output.obj").open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    exclusive_json(directory / "metadata.json", {
        "coordinateFrame": coordinate_frame, "normalization": normalization,
        "parts": counts, "settings": settings, "gpu": probe,
        "reproducibility": "seed_and_settings_recorded_outputs_not_guaranteed_deterministic",
    })


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Fixed child arguments: installation-root job-directory")
    run_root, run_directory = map(Path, sys.argv[1:])
    run_job = validate_job(strict_json(read_regular(run_directory, "job.json", 32768)))
    infer(run_job, run_root, run_directory)
