"""Fixed authenticated asynchronous Cube endpoint. Importing never deploys it."""

import os
from pathlib import Path
import sys
import threading

import modal

LOCAL_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(LOCAL_ROOT))
from contracts import HASH, canonical, digest, strict_json

PREPARING = os.environ.get("FORGE_CUBE_PREPARE") == "1"
QUALIFIER = os.environ.get("FORGE_CUBE_PROVISION_KEY", "")
EXPECTED_HASH = os.environ.get("FORGE_CUBE_INSTALLATION_HASH", "")
if not HASH.fullmatch(QUALIFIER) or (not PREPARING and not HASH.fullmatch(EXPECTED_HASH)):
    raise ValueError("Use deploy.py with an exact provisioning key and sealed installation")

app = modal.App("forge-cube-" + ("prepare-" + QUALIFIER[:24] if PREPARING else EXPECTED_HASH[:40]))
installation_volume = modal.Volume.from_name("forge-cube-install-" + QUALIFIER[:40],
                                             create_if_missing=PREPARING)
image = (modal.Image.debian_slim(python_version="3.12")
         .apt_install("git", "build-essential")
         .pip_install_from_requirements(str(LOCAL_ROOT / "requirements.txt"))
         .env({"FORGE_CUBE_PREPARE": "1" if PREPARING else "0",
               "FORGE_CUBE_PROVISION_KEY": QUALIFIER,
               "FORGE_CUBE_INSTALLATION_HASH": EXPECTED_HASH})
         .add_local_dir(str(LOCAL_ROOT), "/worker", copy=True,
                        ignore=["tests/**", "**/__pycache__/**"]))
INSTALLATION_ROOT = "/opt/forge-cube"


if PREPARING:
    @app.function(image=image, volumes={INSTALLATION_ROOT: installation_volume},
                  cpu=2, memory=8192, timeout=7200, retries=0, max_containers=1)
    def provision():
        """Explicit CPU-only operator action: download exact pins, then seal."""
        import shutil
        import subprocess
        from huggingface_hub import hf_hub_download
        sys.path.insert(0, "/worker")
        from installation import PINS_PATH, load_installation, prepare_installation, runtime_import_check
        root = Path(INSTALLATION_ROOT)
        installation_volume.reload()
        if (root / "installation.json").exists():
            return load_installation(root)
        if any(root.iterdir()):
            raise ValueError("Partial provision requires a new explicit provisioning attempt")
        pins = strict_json(PINS_PATH.read_bytes(), 1024 * 1024)
        source = root / "source"
        source.mkdir()
        for command in (["git", "init", str(source)],
                        ["git", "-C", str(source), "remote", "add", "origin", pins["source"]["repository"]],
                        ["git", "-C", str(source), "fetch", "--depth=1", "origin", pins["source"]["revision"]],
                        ["git", "-C", str(source), "checkout", "--detach", "FETCH_HEAD"]):
            subprocess.run(command, check=True, timeout=600, capture_output=True)
        runtime_import_check(root)
        for name, model in pins["models"].items():
            destination = root / "models" / name
            destination.mkdir(parents=True)
            for pin in model["files"]:
                downloaded = Path(hf_hub_download(model["repository"], filename=pin["path"],
                                                  revision=model["revision"]))
                target = destination / pin["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(downloaded, target)
        lock = prepare_installation(root)
        installation_volume.commit()
        return lock

    @app.local_entrypoint()
    def prepare(manifest_out: str):
        from installation import exclusive_json
        lock = provision.remote()
        exclusive_json(Path(manifest_out).absolute(), lock)
        print("Sealed installation " + lock["hash"] + "; no GPU inference was run.")

else:
    jobs_volume = modal.Volume.from_name("forge-cube-jobs-" + EXPECTED_HASH[:40], create_if_missing=True)
    claims = modal.Dict.from_name("forge-cube-claims-" + EXPECTED_HASH[:40], create_if_missing=True)
    mounts = {INSTALLATION_ROOT: installation_volume.with_mount_options(read_only=True),
              "/jobs": jobs_volume}
    compilation_volume = modal.Volume.from_name(
        "forge-cube-compile-" + EXPECTED_HASH[:40] + "-a100", create_if_missing=True)
    COMPILATION_CACHE_ENV = {"TORCHINDUCTOR_CACHE_DIR": "/compile-cache/inductor",
                             "TRITON_CACHE_DIR": "/compile-cache/triton",
                             "WARP_CACHE_PATH": "/compile-cache/warp"}
    gpu_mounts = {**mounts, "/compile-cache": compilation_volume}

    @app.function(image=image.env(COMPILATION_CACHE_ENV), volumes=gpu_mounts,
                  gpu="A100-80GB", cpu=4, memory=65536,
                  timeout=3600, retries=0, min_containers=0, max_containers=1,
                  scaledown_window=60)
    def execute(job):
        sys.path.insert(0, "/worker")
        from contracts import validate_job
        from installation import read_regular
        from worker import read_job_status, run_job
        validate_job(job)
        if job["installationHash"] != EXPECTED_HASH:
            raise ValueError("Wrong deployment installation")
        job_hash = digest(canonical(job))
        # Modal may redeliver after container failure even with retries=0.
        won = claims.put("execute:" + job["jobId"], job_hash, skip_if_exists=True)
        jobs_volume.reload()
        job_root = Path("/jobs/executions")
        job_root.mkdir(exist_ok=True)
        if not won:
            return read_job_status(job_root, job["jobId"])
        staged = Path("/jobs/submissions") / job["jobId"]
        record = strict_json(read_regular(staged, "request.json", 33792), 33792)
        if record.get("jobHash") != job_hash or record.get("job") != job:
            raise ValueError("GPU input lacks its exact durable submission")
        compilation_volume.reload()
        child_authorized = False

        def before_execute():
            nonlocal child_authorized
            jobs_volume.commit()
            child_authorized = True

        try:
            result = run_job(job, INSTALLATION_ROOT, job_root, staged,
                             before_execute=before_execute)
            jobs_volume.commit()
            return result
        finally:
            # run_job has reaped its bounded child before returning/raising here.
            # Duplicate/preflight-only calls cannot publish an empty cache snapshot.
            if child_authorized:
                try:
                    compilation_volume.commit()
                except Exception:
                    print("Compilation cache commit failed; retained job receipt remains authoritative.",
                          file=sys.stderr)

    @app.function(image=image, volumes=mounts,
                  secrets=[modal.Secret.from_name("forge-cube-http-auth",
                                                   required_keys=["FORGE_CUBE_TOKEN"])],
                  cpu=1, memory=1024, timeout=120,
                  min_containers=0, max_containers=1, scaledown_window=60)
    @modal.concurrent(max_inputs=1)
    @modal.asgi_app()
    def api():
        import secrets
        from fastapi import FastAPI, HTTPException, Request, Response
        from starlette.concurrency import run_in_threadpool
        sys.path.insert(0, "/worker")
        from job_store import MAX_SUBMISSION_BYTES, SubmissionStore, installation_manifest
        from worker import read_job_status
        token = os.environ["FORGE_CUBE_TOKEN"]
        if len(token) < 32:
            raise ValueError("HTTP bearer secret must contain at least 32 characters")
        installation_manifest(INSTALLATION_ROOT, EXPECTED_HASH)
        mutex = threading.RLock()

        def worker_status(key):
            root = Path("/jobs/executions")
            if not root.exists():
                return {"kind": "CubeRemoteStatus", "jobId": key, "status": "missing"}
            return read_job_status(root, key)

        def poll(call_id):
            try:
                modal.FunctionCall.from_id(call_id).get(timeout=0)
                return "complete"
            except modal.exception.TimeoutError:
                return "pending"

        store = SubmissionStore("/jobs", EXPECTED_HASH,
            claim=lambda key, value: claims.put("submit:" + key, value, skip_if_exists=True),
            lookup=lambda key: claims.get("submit:" + key),
            reload=jobs_volume.reload, commit=jobs_volume.commit,
            spawn=lambda job: execute.spawn(job).object_id, poll=poll,
            worker_status=worker_status)
        web = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

        def authenticate(request):
            header = request.headers.get("authorization", "")
            if not secrets.compare_digest(header.encode(), ("Bearer " + token).encode()):
                raise HTTPException(status_code=401, detail="Unauthorized")

        def serialized(action):
            with mutex:
                try:
                    return action()
                except FileNotFoundError as error:
                    raise HTTPException(status_code=404, detail="Job or retained artifact unavailable") from error
                except ValueError as error:
                    raise HTTPException(status_code=409, detail=str(error)[:1024]) from error

        @web.get("/health")
        async def health(request: Request):
            authenticate(request)
            # Metadata identity, deliberately not a GPU/model readiness claim.
            await run_in_threadpool(installation_manifest, INSTALLATION_ROOT, EXPECTED_HASH)
            return {"kind": "CubeRemoteHealth", "installationHash": EXPECTED_HASH,
                    "operations": ["cube3d", "cubepart"]}

        @web.post("/jobs")
        async def submit(request: Request):
            authenticate(request)
            data = bytearray()
            async for chunk in request.stream():
                if len(data) + len(chunk) > MAX_SUBMISSION_BYTES:
                    raise HTTPException(status_code=413, detail="Submission exceeds byte limit")
                data.extend(chunk)
            try:
                value = strict_json(data, MAX_SUBMISSION_BYTES)
            except ValueError as error:
                raise HTTPException(status_code=400, detail="Invalid bounded JSON") from error
            return await run_in_threadpool(serialized, lambda: store.submit(value))

        @web.get("/jobs/{job_id}")
        async def status(job_id: str, request: Request):
            authenticate(request)
            return await run_in_threadpool(serialized, lambda: store.status(job_id))

        @web.get("/jobs/{job_id}/output")
        async def output(job_id: str, request: Request):
            authenticate(request)
            data = await run_in_threadpool(serialized, lambda: store.output(job_id))
            return Response(data, media_type="model/obj", headers={"Content-Length": str(len(data)),
                            "X-Content-SHA256": digest(data), "Cache-Control": "no-store"})

        return web
