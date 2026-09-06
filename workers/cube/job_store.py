"""Durable submission protocol, independent of Modal and inference.

The injected claim operation must be atomic across controllers. Its expiring
index is supplemented by permanent immutable files: winning a new index claim
never authorizes rerunning a job that already has submission history.
"""

import base64
import binascii
import os
from pathlib import Path
import time

from contracts import (HASH, JOB_ID, MAX_JOB_BYTES, MAX_OBJ_BYTES, canonical,
                       digest, parse_obj, strict_json, validate_job)
from installation import exclusive_json, read_regular

MAX_SUBMISSION_BYTES = ((MAX_OBJ_BYTES + 2) // 3) * 4 + MAX_JOB_BYTES + 128


def installation_manifest(root, expected_hash=None):
    """Verify the sealed identity only; the worker verifies every file before use."""
    root = Path(root).resolve(strict=True)
    lock = strict_json(read_regular(root, "installation.json", 4 * 1024 * 1024),
                       4 * 1024 * 1024)
    body = {key: value for key, value in lock.items() if key != "hash"}
    if (lock.get("kind") != "CubeRemoteInstallation" or lock.get("root") != str(root)
            or lock.get("hash") != digest(canonical(body))
            or (expected_hash is not None and lock["hash"] != expected_hash)):
        raise ValueError("Installation manifest identity mismatch")
    return lock


def decode_submission(value, expected_hash):
    if type(value) is not dict or set(value) not in ({"job"}, {"job", "inputBase64"}):
        raise ValueError("Expected job and optional inputBase64 only")
    job = validate_job(value["job"])
    if job["installationHash"] != expected_hash:
        raise ValueError("Job targets a different installation")
    job = strict_json(canonical(job))
    data = None
    if job["operation"] == "cube3d":
        if "inputBase64" in value:
            raise ValueError("Cube3D does not accept mesh input")
    else:
        encoded = value.get("inputBase64")
        if type(encoded) is not str or len(encoded) > ((MAX_OBJ_BYTES + 2) // 3) * 4:
            raise ValueError("CubePart requires bounded base64 input")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise ValueError("Invalid base64 input") from error
        if (base64.b64encode(data).decode("ascii") != encoded
                or len(data) != job["input"]["bytes"]
                or digest(data) != job["input"]["sha256"]):
            raise ValueError("Input does not match its exact byte pin")
        parse_obj(data)
    return job, data


class SubmissionStore:
    def __init__(self, root, installation_hash, *, claim, lookup, reload, commit,
                 spawn, poll, worker_status, clock=time.time):
        if not HASH.fullmatch(installation_hash):
            raise ValueError("Invalid installation identity")
        self.root = Path(root).resolve(strict=True)
        self.installation_hash = installation_hash
        self.claim, self.lookup = claim, lookup
        self.reload, self.commit = reload, commit
        self.spawn, self.poll = spawn, poll
        self.worker_status, self.clock = worker_status, clock

    def _path(self, job_id):
        if type(job_id) is not str or not JOB_ID.fullmatch(job_id):
            raise ValueError("Invalid job identity")
        parent = self.root / "submissions"
        if parent.is_symlink():
            raise ValueError("Invalid submission store")
        parent.mkdir(exist_ok=True, mode=0o700)
        path = parent / job_id
        if path.is_symlink():
            raise ValueError("Invalid submission directory")
        return path

    def _receipt(self, job, status, result=None):
        value = {"kind": "CubeRemoteSubmission", "jobId": job["jobId"],
                 "jobHash": digest(canonical(job)),
                 "installationHash": self.installation_hash, "status": status}
        if result is not None:
            value["result"] = result
        return value

    def _read_claim(self, path):
        claim = strict_json(read_regular(path, "request.json", MAX_JOB_BYTES + 1024),
                            MAX_JOB_BYTES + 1024)
        job = validate_job(claim["job"])
        if (claim.get("kind") != "CubeRemoteClaim" or job["jobId"] != path.name
                or job["installationHash"] != self.installation_hash
                or claim.get("jobHash") != digest(canonical(job))):
            raise ValueError("Retained submission identity mismatch")
        return claim

    def submit(self, value):
        job, data = decode_submission(value, self.installation_hash)
        record = {"kind": "CubeRemoteClaim", "job": job,
                  "jobHash": digest(canonical(job)), "createdAt": self.clock()}
        # Atomic remote claim comes first. A lost acknowledgement cannot spawn.
        won = self.claim(job["jobId"], record)
        self.reload()
        path = self._path(job["jobId"])
        if path.exists() or not won:
            retained = self._read_claim(path) if path.exists() else self.lookup(job["jobId"])
            if retained is None or retained.get("jobHash") != record["jobHash"]:
                raise ValueError("Job identity was already consumed with different or incomplete history")
            return self.status(job["jobId"])
        path.mkdir(mode=0o700)
        exclusive_json(path / "request.json", record)
        if data is not None:
            with os.fdopen(os.open(path / "input.obj", os.O_WRONLY | os.O_CREAT |
                                  os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        # Never call spawn until this permanent claim and input are durable.
        self.commit()
        try:
            call_id = self.spawn(job)
            if type(call_id) is not str or not 1 <= len(call_id) <= 256:
                raise ValueError("Provider did not return a bounded call identity")
            exclusive_json(path / "dispatch.json", {"kind": "CubeRemoteDispatch",
                           "jobHash": record["jobHash"], "callId": call_id})
            self.commit()
        except Exception:
            # It is impossible to distinguish lost acknowledgement from no launch.
            return self._receipt(job, "recovery_required")
        return self._receipt(job, "queued")

    def status(self, job_id):
        self.reload()
        path = self._path(job_id)
        if path.exists():
            record = self._read_claim(path)
        else:
            record = self.lookup(job_id)
            if record is None:
                raise FileNotFoundError("Unknown job")
        job = validate_job(record["job"])
        if (record.get("jobHash") != digest(canonical(job)) or job["jobId"] != job_id
                or job["installationHash"] != self.installation_hash):
            raise ValueError("Submission index identity mismatch")
        result = self.worker_status(job_id)
        if result.get("kind") == "CubeRemoteResult":
            if any(result.get(key) != expected for key, expected in
                   (("jobId", job_id), ("jobHash", record["jobHash"]),
                    ("installationHash", self.installation_hash), ("mayRelaunch", False))):
                raise ValueError("Worker result does not belong to this submission")
            if result.get("status") not in ("succeeded", "failed"):
                raise ValueError("Invalid final worker status")
            return self._receipt(job, result["status"], result)
        try:
            dispatch = strict_json(read_regular(path, "dispatch.json", 1024), 1024)
        except FileNotFoundError:
            return self._receipt(job, "recovery_required")
        if (dispatch.get("kind") != "CubeRemoteDispatch"
                or dispatch.get("jobHash") != record["jobHash"]
                or type(dispatch.get("callId")) is not str):
            raise ValueError("Invalid dispatch identity")
        # Provider status is advisory only. Output authority remains the receipt.
        try:
            pending = self.poll(dispatch["callId"]) == "pending"
        except Exception:
            pending = False
        if pending:
            return self._receipt(job, "queued" if result.get("status") == "missing" else "running")
        return self._receipt(job, "recovery_required")

    def output(self, job_id):
        receipt = self.status(job_id)
        if receipt["status"] != "succeeded":
            raise ValueError("Job has no successful output")
        pin = receipt["result"]["output"]
        if pin.get("path") != "output.obj":
            raise ValueError("Unexpected worker output path")
        data = read_regular(self.root / "executions" / job_id, "output.obj", MAX_OBJ_BYTES)
        if digest(data) != pin["sha256"] or len(data) != pin["bytes"]:
            raise ValueError("Worker output changed")
        return data
