"""Durable, bounded filesystem worker; network/authentication belongs to the deploy adapter."""

import argparse
import base64
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

from contracts import MAX_OBJ_BYTES, canonical, digest, strict_json, validate_job, parse_obj, JOB_ID
from installation import (WORKER_ROOT, exclusive_json, gpu_probe, load_installation,
                          prepare_installation, read_regular)

TIMEOUT_SECONDS = 1800
MAX_LOG_BYTES = 1024 * 1024
CHILD_ENVIRONMENT_KEYS = frozenset({
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "LD_LIBRARY_PATH",
    "CUDA_VISIBLE_DEVICES", "CUDA_HOME", "CUDA_PATH", "CUDA_CACHE_PATH",
    "NVIDIA_VISIBLE_DEVICES", "NVIDIA_DRIVER_CAPABILITIES",
    "TORCHINDUCTOR_CACHE_DIR", "TRITON_CACHE_DIR", "WARP_CACHE_PATH", "PYTORCH_CUDA_ALLOC_CONF",
    "HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "XDG_CACHE_HOME",
    "OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS",
})


def child_environment(environ):
    # Only host runtime/cache settings enter inference. HTTP and provider credentials do not.
    env = {key: value for key, value in environ.items() if key in CHILD_ENVIRONMENT_KEYS}
    env.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "PYTHONNOUSERSITE": "1",
                "PYTHONDONTWRITEBYTECODE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"})
    return env


def captured(data):
    return {"encoding": "base64", "content": base64.b64encode(data).decode("ascii"),
            "bytes": len(data), "sha256": digest(data)}


def terminate_process_group(process):
    """Handle an exited-child race; report a live group's unconfirmed termination."""
    if process.poll() is not None:
        return None
    try:
        os.killpg(process.pid, signal.SIGKILL)
        return None
    except (ProcessLookupError, PermissionError):
        if process.poll() is not None:
            return None
    # A denied group signal must not leave the actual child running silently.
    try:
        process.kill()
    except (ProcessLookupError, PermissionError) as error:
        if process.poll() is None:
            raise RuntimeError("process_group_termination_incomplete; unable to kill live worker child") from error
    return "process_group_termination_incomplete"


def execute(root, directory):
    env = child_environment(os.environ)
    process = subprocess.Popen([sys.executable, "-s", str(WORKER_ROOT / "inference.py"),
                                str(root), str(directory)], cwd=WORKER_ROOT, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               stdin=subprocess.DEVNULL, start_new_session=True)
    logs = {"stdout": bytearray(), "stderr": bytearray()}
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    deadline, reason, termination_deadline = time.monotonic() + TIMEOUT_SECONDS, None, None
    termination_failed = False

    def kill_group():
        nonlocal reason, termination_failed
        try:
            note = terminate_process_group(process)
        except Exception as error:
            termination_failed = True
            raise RuntimeError((reason + "; " if reason else "") + str(error)) from error
        if note is not None and (reason is None or note not in reason):
            reason = reason + "; " + note if reason else note

    try:
        while selector.get_map():
            if time.monotonic() >= deadline and reason is None:
                reason = "execution_timeout"
                termination_deadline = time.monotonic() + 5
                kill_group()
            for key, _ in selector.select(timeout=0.1):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                remaining = MAX_LOG_BYTES - sum(len(log) for log in logs.values())
                logs[key.data].extend(data[:remaining])
                if len(data) > remaining and reason is None:
                    reason = "log_limit"
                    termination_deadline = time.monotonic() + 5
                    kill_group()
            # A descendant retaining a pipe cannot keep the supervisor alive indefinitely.
            if termination_deadline is not None and time.monotonic() > termination_deadline:
                break
        code = process.wait(timeout=5)
    finally:
        selector.close()
        for stream in (process.stdout, process.stderr):
            stream.close()
        if process.poll() is None and not termination_failed:
            kill_group()
            process.wait(timeout=5)
    return {"exitCode": code, "reason": reason,
            "stdout": captured(bytes(logs["stdout"])), "stderr": captured(bytes(logs["stderr"]))}


def read_job_status(job_root, job_id):
    if type(job_id) is not str or not JOB_ID.fullmatch(job_id):
        raise ValueError("Invalid jobId")
    root = Path(job_root).resolve(strict=True)
    directory = root / job_id
    if directory.is_symlink():
        raise ValueError("Symlink job directory")
    if not directory.exists():
        return {"kind": "CubeRemoteStatus", "jobId": job_id, "status": "missing"}
    job = validate_job(strict_json(read_regular(directory, "job.json", 32768)))
    job_hash = digest(canonical(job))
    base = {"kind": "CubeRemoteResult", "jobId": job_id, "jobHash": job_hash,
            "installationHash": job["installationHash"], "mayRelaunch": False}
    if not (directory / "result.json").exists():
        return {**base, "kind": "CubeRemoteStatus", "status": "recovery_required",
                "detail": "Consumed job has no final receipt; inspect retained output and logs. It will not execute again."}
    result = strict_json(read_regular(directory, "result.json", 2 * MAX_LOG_BYTES), 2 * MAX_LOG_BYTES)
    if any(result.get(key) != value for key, value in base.items()):
        raise ValueError("Retained result identity mismatch")
    if result.get("status") == "succeeded":
        output = read_regular(directory, "output.obj", MAX_OBJ_BYTES)
        if result.get("output") != {"path": "output.obj", "sha256": digest(output), "bytes": len(output)}:
            raise ValueError("Retained output differs from receipt")
    elif result.get("status") != "failed":
        raise ValueError("Unexpected retained result status")
    return result


def run_job(job, installation_root, job_root, input_root, before_execute=None):
    """The adapter must durably commit the exclusive launch in before_execute before inference."""
    job = validate_job(strict_json(canonical(job)))
    root = Path(installation_root).resolve(strict=True)
    jobs = Path(job_root).resolve(strict=True)
    directory = jobs / job["jobId"]
    if directory.exists() or directory.is_symlink():
        retained = read_job_status(jobs, job["jobId"])
        if retained.get("jobHash") != digest(canonical(job)):
            raise ValueError("JobId already belongs to another immutable request")
        return retained
    lock = load_installation(root, job["installationHash"])
    data = None
    if job["operation"] == "cubepart":
        data = read_regular(input_root, "input.obj", MAX_OBJ_BYTES)
        if len(data) != job["input"]["bytes"] or digest(data) != job["input"]["sha256"]:
            raise ValueError("Input OBJ differs from request pin")
        parse_obj(data)
    # This directory itself is a consumed claim. No failure path removes it or starts another attempt.
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        retained = read_job_status(jobs, job["jobId"])
        if retained.get("jobHash") != digest(canonical(job)):
            raise ValueError("JobId already belongs to another immutable request")
        return retained
    exclusive_json(directory / "job.json", job)
    if data is not None:
        with (directory / "input.obj").open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    job_hash = digest(canonical(job))
    exclusive_json(directory / "launch.json", {"kind": "CubeRemoteLaunch", "jobHash": job_hash,
                                               "installationHash": lock["hash"]})
    result = {"kind": "CubeRemoteResult", "jobId": job["jobId"], "jobHash": job_hash,
              "installationHash": lock["hash"], "mayRelaunch": False}
    committed = False
    try:
        if before_execute is not None:
            before_execute()
        committed = True
        execution = execute(root, directory)
        result["execution"] = execution
        if execution["reason"] is not None or execution["exitCode"] != 0:
            raise RuntimeError(execution["reason"] or "inference_process_failed")
        output = read_regular(directory, "output.obj", MAX_OBJ_BYTES)
        # Strict records and finite/index/size checks are repeated before host ingestion.
        parse_obj(output)
        metadata = strict_json(read_regular(directory, "metadata.json", 32768))
        expected_parts = [part["id"] for part in job["parts"]] if job["operation"] == "cubepart" else ["mesh"]
        output_parts = [line[2:] for line in output.decode("ascii").splitlines() if line.startswith("o ")]
        if output_parts != expected_parts or [part["id"] for part in metadata["parts"]] != expected_parts:
            raise ValueError("Output part aliases differ from the exact requested schema")
        # Verify pins again after execution; changed installation never receives a successful receipt.
        load_installation(root, lock["hash"])
        result.update({"status": "succeeded", "output": {
            "path": "output.obj", "sha256": digest(output), "bytes": len(output)}, "metadata": metadata})
    except Exception as error:
        result.update({"status": "failed", "failure": {
            "code": "execution_failed" if committed else "launch_commit_failed",
            "detail": str(error)[:4096]}})
    exclusive_json(directory / "result.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description="Pinned headless Cube research worker")
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--installation-root", required=True)
    probe = commands.add_parser("probe")
    probe.add_argument("--installation-root", required=True)
    probe.add_argument("--operation", choices=["cube3d", "cubepart"], required=True)
    run = commands.add_parser("run")
    run.add_argument("--installation-root", required=True)
    run.add_argument("--job-root", required=True)
    run.add_argument("--input-root", required=True)
    run.add_argument("--job", required=True)
    status = commands.add_parser("status")
    status.add_argument("--job-root", required=True)
    status.add_argument("--job-id", required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare_installation(args.installation_root)
    elif args.command == "probe":
        lock = load_installation(args.installation_root)
        result = {"installationHash": lock["hash"], "gpu": gpu_probe(args.operation)}
    elif args.command == "status":
        result = read_job_status(args.job_root, args.job_id)
    else:
        job_path = Path(args.job).absolute()
        job = validate_job(strict_json(read_regular(job_path.parent, job_path.name, 32768)))
        result = run_job(job, args.installation_root, args.job_root, args.input_root)
    print(canonical(result).decode("utf-8"))


if __name__ == "__main__":
    main()
