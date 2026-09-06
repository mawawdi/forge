"""Seal and verify a pre-provisioned, local-only Cube installation. Never downloads."""

import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import platform
import stat
import subprocess
import sys

from contracts import canonical, digest, strict_json

WORKER_ROOT = Path(__file__).resolve().parent
PINS_PATH = WORKER_ROOT / "pins.json"
LOCK_NAME = "installation.json"


def read_regular(root, relative, maximum):
    root = Path(root).resolve(strict=True)
    path = Path(relative)
    if path.is_absolute() or not path.parts or any(p in (".", "..") for p in path.parts):
        raise ValueError("Unsafe relative file path")
    current = root
    for part in path.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Symlink input is forbidden")
    fd = os.open(current, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        meta = os.fstat(stream.fileno())
        if not stat.S_ISREG(meta.st_mode) or meta.st_size > maximum:
            raise ValueError("Expected a bounded regular file")
        data = stream.read(maximum + 1)
        if len(data) != meta.st_size or len(data) > maximum:
            raise ValueError("File changed or exceeded limit")
        return data


def file_pin(root, relative):
    """Stream large weights instead of loading them in host RAM."""
    import hashlib
    root = Path(root).resolve(strict=True)
    path = Path(relative)
    if path.is_absolute() or not path.parts or any(p in (".", "..") for p in path.parts):
        raise ValueError("Unsafe installation path")
    current = root
    for part in path.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Symlink installation file is forbidden")
    with os.fdopen(os.open(current, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("Expected regular installation file")
        hasher, size = hashlib.sha256(), 0
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(chunk)
            hasher.update(chunk)
        after = os.fstat(stream.fileno())
        if size != before.st_size or (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
            raise ValueError("Installation changed while hashing")
    return {"path": str(path), "sha256": hasher.hexdigest(), "bytes": size}


def exclusive_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(canonical(value) + b"\n")
        stream.flush()
        os.fsync(stream.fileno())
    parent_fd = os.open(Path(path).parent, os.O_RDONLY)
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def dependencies():
    return sorted({(dist.metadata["Name"].lower(), dist.version)
                   for dist in importlib.metadata.distributions()})


def runtime_import_check(root):
    """CPU setup gate: import fixed APIs without loading checkpoints or invoking inference."""
    # Isolate Hub offline constants: setup still needs online downloads after this check.
    from worker import child_environment
    result = subprocess.run([sys.executable, "-s", str(WORKER_ROOT / "installation.py"),
                             "check-imports", str(Path(root).resolve(strict=True))],
                            env=child_environment(os.environ), capture_output=True,
                            timeout=120, check=False)
    if result.returncode != 0:
        raise ValueError("CPU runtime imports failed: " + result.stderr[-8192:].decode("utf-8", errors="replace"))
    if len(result.stdout) > 1024 * 1024:
        raise ValueError("CPU import check exceeded output limit")
    return strict_json(result.stdout.splitlines()[-1])


def _runtime_import_check(root):
    root = Path(root).resolve(strict=True)
    os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                       "HF_HUB_DISABLE_TELEMETRY": "1"})
    sys.path[:0] = [str(root / "source"), str(root / "source/cubepart")]
    from cube3d.inference.engine import Engine
    from cube3d.inference.utils import normalize_bbox
    from cube_part.pipelines import PartShapeDenoiserPipeline, ShapeInput
    from cube_part.utils.mesh import sample_surface
    from diffusers import DPMSolverMultistepScheduler, AutoModel, QwenImageTransformer2DModel
    from transformers import (AutoProcessor, CLIPTextModelWithProjection, CLIPTokenizerFast,
                              Qwen3VLForConditionalGeneration)
    import fpsample
    import warp
    checks = [
        ("Engine.__init__", Engine.__init__, {"config_path", "gpt_ckpt_path", "shape_ckpt_path", "device"}),
        ("Engine.t2s", Engine.t2s, {"prompts", "use_kv_cache", "resolution_base", "top_p", "bounding_box_xyz"}),
        ("normalize_bbox", normalize_bbox, {"bounding_box_xyz"}),
        ("PartShapeDenoiserPipeline.__init__", PartShapeDenoiserPipeline.__init__,
         {"config_path", "checkpoint_path", "vae_checkpoint_path", "device", "extract_geometry_fn_name"}),
        ("PartShapeDenoiserPipeline.input_to_part_shape", PartShapeDenoiserPipeline.input_to_part_shape,
         {"shape_input", "guidance_scale", "resolution_base", "scheduler_type", "timeshift",
          "num_inference_steps", "seed", "output_mesh"}),
        ("PartShapeDenoiserPipeline.encode_shape", PartShapeDenoiserPipeline.encode_shape, {"surface"}),
        ("ShapeInput", ShapeInput, {"prompt", "latents"}),
        ("sample_surface", sample_surface, {"mesh", "num_samples"}),
        ("DPMSolverMultistepScheduler", DPMSolverMultistepScheduler,
         {"use_flow_sigmas", "flow_shift", "prediction_type"}),
    ]
    for label, function, required in checks:
        if not required.issubset(inspect.signature(function).parameters):
            raise ValueError("Pinned runtime call contract unavailable: " + label)
    for value, member in [(AutoModel, "load_config"), (QwenImageTransformer2DModel, "from_config"),
                          (AutoProcessor, "from_pretrained"), (CLIPTextModelWithProjection, "from_pretrained"),
                          (CLIPTokenizerFast, "from_pretrained"), (Qwen3VLForConditionalGeneration, "from_pretrained"),
                          (fpsample, "bucket_fps_kdline_sampling"), (warp, "MarchingCubes")]:
        if not callable(getattr(value, member, None)):
            raise ValueError("Pinned runtime API unavailable: " + member)
    return {"scope": "imports_and_call_signatures_only", "modelsInitialized": False,
            "cudaExercised": False, "checks": [label for label, _, _ in checks]}


def prepare_installation(root):
    """Operator build step, after exact pinned source/model files have been provisioned."""
    from omegaconf import OmegaConf
    root = Path(root).resolve(strict=True)
    pins = strict_json(PINS_PATH.read_bytes(), 1024 * 1024)
    source = root / "source"
    head = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if head != pins["source"]["revision"]:
        raise ValueError("Wrong Cube source revision")
    tree = subprocess.check_output(["git", "-C", str(source), "ls-tree", "-r", "HEAD"], text=True)
    source_files = []
    for row in tree.splitlines():
        metadata, relative = row.split("\t", 1)
        mode, kind, oid = metadata.split()
        if not (relative.endswith((".py", ".yaml", ".json", ".toml", ".txt")) or relative == "LICENSE"):
            continue
        if mode not in ("100644", "100755") or kind != "blob":
            raise ValueError("Unexpected source tree entry")
        actual = subprocess.check_output(["git", "-C", str(source), "hash-object", "--", relative], text=True).strip()
        if actual != oid:
            raise ValueError("Modified upstream source file: " + relative)
        source_files.append(file_pin(root, "source/" + relative))
    model_files = []
    for name, model in pins["models"].items():
        for expected in model["files"]:
            relative = "models/" + name + "/" + expected["path"]
            actual = file_pin(root, relative)
            if actual != {**expected, "path": relative}:
                raise ValueError("Model file differs from upstream digest: " + relative)
            model_files.append(actual)
    config_root = root / "configs"
    config_root.mkdir(mode=0o700)
    cube = OmegaConf.load(source / "cube3d/configs/open_model_v0.5.yaml")
    cube.text_model_pretrained_model_name_or_path = str(root / "models/clip")
    OmegaConf.save(cube, config_root / "cube3d.yaml")
    part = OmegaConf.load(source / "cubepart/configs/shape_denoiser_multimesh.yaml")
    part.system.base_model_path = str(root / "models/qwen")
    # The pinned factory ignores diffusion_model_config_path; it does honor model_type.
    part.system.diffusion_model_type = str(root / "models/qwen_image")
    OmegaConf.save(part, config_root / "cubepart.yaml")
    worker_files = [file_pin(WORKER_ROOT, name) for name in
                    ("contracts.py", "installation.py", "inference.py", "worker.py", "pins.json",
                     "job_store.py", "modal_app.py", "deploy.py", "requirements.txt",
                     "requirements-deploy.txt")]
    body = {
        "kind": "CubeRemoteInstallation", "root": str(root), "upstream": pins,
        "files": sorted(source_files + model_files + [file_pin(root, "configs/" + name)
                        for name in ("cube3d.yaml", "cubepart.yaml")], key=lambda item: item["path"]),
        "workerFiles": worker_files,
        "python": platform.python_version(), "dependencies": dependencies(),
        "dependencyVersionsHash": digest(canonical(dependencies())),
        "licenseScope": "noncommercial_research_only",
    }
    result = {**body, "hash": digest(canonical(body))}
    exclusive_json(root / LOCK_NAME, result)
    return result


def load_installation(root, expected_hash=None):
    root = Path(root).resolve(strict=True)
    lock = strict_json(read_regular(root, LOCK_NAME, 4 * 1024 * 1024), 4 * 1024 * 1024)
    body = {key: value for key, value in lock.items() if key != "hash"}
    if (lock.get("kind") != "CubeRemoteInstallation" or lock.get("hash") != digest(canonical(body))
            or lock.get("root") != str(root) or (expected_hash is not None and lock["hash"] != expected_hash)
            or lock.get("upstream") != strict_json(PINS_PATH.read_bytes(), 1024 * 1024)):
        raise ValueError("Installation identity mismatch")
    if lock["python"] != platform.python_version() or lock["dependencies"] != [list(p) for p in dependencies()]:
        raise ValueError("Python dependency versions changed")
    expected_source = set()
    for pin in lock["files"]:
        if file_pin(root, pin["path"]) != pin:
            raise ValueError("Installation file changed: " + pin["path"])
        if pin["path"].endswith(".py"):
            expected_source.add(pin["path"])
    # Additional importable upstream code must not silently enter the verified tree.
    actual_source = {str(path.relative_to(root)) for path in (root / "source").rglob("*.py")}
    if actual_source != expected_source:
        raise ValueError("Upstream Python source closure changed")
    for pin in lock["workerFiles"]:
        if file_pin(WORKER_ROOT, pin["path"]) != pin:
            raise ValueError("Worker implementation changed")
    return lock


def gpu_probe(operation):
    if sys.platform != "linux":
        raise ValueError("Remote worker requires Linux with NVIDIA CUDA")
    import torch
    if not torch.cuda.is_available() or torch.cuda.device_count() != 1:
        raise ValueError("Exactly one visible CUDA GPU is required")
    if not torch.cuda.is_bf16_supported():
        raise ValueError("CUDA bfloat16 support is required")
    free, total = torch.cuda.mem_get_info()
    # Policy for first qualification, not an upstream CubePart memory guarantee.
    required = (16 if operation == "cube3d" else 40) * 1024**3
    if free < required:
        raise ValueError("Insufficient free VRAM for this worker qualification policy")
    return {"name": torch.cuda.get_device_name(), "freeBytes": free, "totalBytes": total,
            "computeCapability": list(torch.cuda.get_device_capability()),
            "torchVersion": torch.__version__, "cudaVersion": torch.version.cuda,
            "requiredFreeBytes": required, "policyScope": "unmeasured_qualification_headroom"}


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "check-imports":
        raise SystemExit("Fixed arguments: check-imports installation-root")
    print(canonical(_runtime_import_check(sys.argv[2])).decode("utf-8"))
