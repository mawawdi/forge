"""Offline submission/receipt tests: no Modal connection, torch or inference."""

import base64
import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import types

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from contracts import canonical, digest
from deploy import host_configuration, read_manifest, reserve_deployment
from installation import exclusive_json
from job_store import SubmissionStore, decode_submission

INSTALLATION = "a" * 64
JOB_ID = "00000000-0000-4000-8000-000000000001"
TRIANGLE = b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"


def job():
    return {"kind": "CubeRemoteJob", "jobId": JOB_ID, "installationHash": INSTALLATION,
            "operation": "cube3d", "seed": 3, "prompt": "A sculptural arch",
            "bounds": {"x": 2, "y": 3, "z": 1}}


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.index, self.events = {}, []
        self.outcome = {"kind": "CubeRemoteStatus", "jobId": JOB_ID, "status": "missing"}
        self.provider = "pending"

        def claim(key, value):
            self.events.append("claim")
            if key in self.index:
                return False
            self.index[key] = copy.deepcopy(value)
            return True

        def spawn(value):
            self.events.append("spawn")
            self.assertEqual(self.events[-2], "commit")
            self.assertTrue((self.root / "submissions" / JOB_ID / "request.json").is_file())
            return "fc-fixed-host-issued"

        self.store = SubmissionStore(self.root, INSTALLATION, claim=claim,
            lookup=self.index.get, reload=lambda: self.events.append("reload"),
            commit=lambda: self.events.append("commit"), spawn=spawn,
            poll=lambda _: self.provider, worker_status=lambda _: self.outcome,
            clock=lambda: 12345)

    def test_duplicate_is_never_dispatched_and_different_content_rejects(self):
        self.assertEqual(self.store.submit({"job": job()})["status"], "queued")
        self.assertEqual(self.store.submit({"job": job()})["status"], "queued")
        self.assertEqual(self.events.count("spawn"), 1)
        with self.assertRaisesRegex(ValueError, "different"):
            self.store.submit({"job": dict(job(), seed=4)})
        self.assertEqual(self.events.count("spawn"), 1)

    def test_expired_index_cannot_authorize_second_spawn(self):
        self.store.submit({"job": job()})
        self.index.clear()  # Modal Dict expires; the immutable volume does not.
        self.store.submit({"job": job()})
        self.assertEqual(self.events.count("spawn"), 1)

    def test_ambiguous_spawn_is_recovery_only_across_restart(self):
        def ambiguous(_):
            self.events.append("ambiguous-spawn")
            raise OSError("Provider accepted, acknowledgement lost")
        self.store.spawn = ambiguous
        self.assertEqual(self.store.submit({"job": job()})["status"], "recovery_required")
        self.index.clear()
        self.assertEqual(self.store.submit({"job": job()})["status"], "recovery_required")
        self.assertEqual(self.events.count("ambiguous-spawn"), 1)

    def test_claim_commit_failure_prevents_spawn_and_remains_consumed(self):
        def fail():
            raise OSError("Cannot persist volume")
        self.store.commit = fail
        with self.assertRaises(OSError):
            self.store.submit({"job": job()})
        self.assertNotIn("spawn", self.events)
        self.assertEqual(self.store.submit({"job": job()})["status"], "recovery_required")

    def test_remote_claim_without_volume_history_does_not_dispatch(self):
        self.index[JOB_ID] = {"kind": "CubeRemoteClaim", "job": job(),
                             "jobHash": digest(canonical(job())), "createdAt": 12345}
        self.assertEqual(self.store.submit({"job": job()})["status"], "recovery_required")
        self.assertNotIn("spawn", self.events)

    def test_pending_and_unknown_execution_are_distinct_from_final_failure(self):
        self.store.submit({"job": job()})
        self.outcome = {"kind": "CubeRemoteStatus", "jobId": JOB_ID, "status": "recovery_required"}
        self.assertEqual(self.store.status(JOB_ID)["status"], "running")
        self.provider = "complete"
        receipt = self.store.status(JOB_ID)
        self.assertEqual(receipt["status"], "recovery_required")
        self.assertNotIn("result", receipt)
        self.outcome = {"kind": "CubeRemoteResult", "jobId": JOB_ID,
                        "jobHash": digest(canonical(job())), "installationHash": INSTALLATION,
                        "status": "failed", "mayRelaunch": False,
                        "failure": {"code": "execution_failed", "detail": "Fixed child failed"}}
        self.assertEqual(self.store.status(JOB_ID)["result"], self.outcome)
        self.outcome["installationHash"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "does not belong"):
            self.store.status(JOB_ID)

    def test_output_is_rehashed_and_download_does_not_dispatch(self):
        self.store.submit({"job": job()})
        execution = self.root / "executions" / JOB_ID
        execution.mkdir(parents=True)
        (execution / "output.obj").write_bytes(TRIANGLE)
        self.outcome = {"kind": "CubeRemoteResult", "jobId": JOB_ID,
                        "jobHash": digest(canonical(job())), "installationHash": INSTALLATION,
                        "status": "succeeded", "mayRelaunch": False,
                        "output": {"path": "output.obj", "sha256": digest(TRIANGLE), "bytes": len(TRIANGLE)}}
        self.assertEqual(self.store.output(JOB_ID), TRIANGLE)
        (execution / "output.obj").write_bytes(TRIANGLE + b"# changed\n")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.store.output(JOB_ID)
        self.assertEqual(self.events.count("spawn"), 1)

    def test_input_base64_and_geometry_are_exact_before_claim(self):
        part = {"kind": "CubeRemoteJob", "jobId": JOB_ID, "installationHash": INSTALLATION,
                "operation": "cubepart", "seed": 3,
                "input": {"path": "input.obj", "sha256": digest(TRIANGLE), "bytes": len(TRIANGLE)},
                "parts": [{"id": "frame", "prompt": "outer frame"}]}
        value = {"job": part, "inputBase64": base64.b64encode(TRIANGLE).decode()}
        self.assertEqual(decode_submission(value, INSTALLATION), (part, TRIANGLE))
        for invalid in [dict(value, inputBase64=value["inputBase64"] + "\n"),
                        dict(value, job=dict(part, installationHash="b" * 64)),
                        {"job": job(), "inputBase64": value["inputBase64"]}]:
            with self.assertRaises(ValueError):
                self.store.submit(invalid)
        self.assertNotIn("claim", self.events)


class ManifestTest(unittest.TestCase):
    def test_existing_or_ambiguous_deployment_attempt_cannot_overwrite(self):
        lock = {"hash": INSTALLATION}
        env = {"FORGE_CUBE_PROVISION_KEY": "b" * 64}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "installation.json"
            existing = [{"description": "forge-cube-" + INSTALLATION[:40]}]
            with patch("deploy.subprocess.run", return_value=types.SimpleNamespace(stdout=canonical(existing))):
                with self.assertRaisesRegex(ValueError, "overwriting"):
                    reserve_deployment(lock, path, env)
            self.assertFalse(Path(str(path) + ".deploy-attempt.json").exists())
            with patch("deploy.subprocess.run", return_value=types.SimpleNamespace(stdout=b"[]")) as run:
                reserve_deployment(lock, path, env)
                with self.assertRaisesRegex(ValueError, "already consumed"):
                    reserve_deployment(lock, path, env)
                self.assertEqual(run.call_count, 1)

    def test_local_manifest_configuration_binds_source_models_dependencies(self):
        body = {"kind": "CubeRemoteInstallation", "root": "/opt/forge-cube",
                "licenseScope": "noncommercial_research_only", "workerFiles": [],
                "files": [], "python": "3.12.0", "dependencyVersionsHash": "a" * 64,
                "upstream": {"models": {"cube3d": {"revision": "pinned", "files": []}}}}
        lock = dict(body, hash=digest(canonical(body)))
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "installation.json"
            exclusive_json(path, lock)
            read = read_manifest(path)
            config = host_configuration(read, "https://example.modal.run", "FORGE_CUBE_TOKEN")
            self.assertEqual(config["cube"]["installationHash"], lock["hash"])
            self.assertEqual(config["cube"]["checkpointHashes"],
                             [digest(canonical(body["upstream"]["models"]["cube3d"]))])
            changed = copy.deepcopy(lock)
            changed["dependencyVersionsHash"] = "b" * 64
            self.assertNotEqual(host_configuration(changed, "https://example.modal.run", "FORGE_CUBE_TOKEN")
                                ["cube"]["configurationHash"], config["cube"]["configurationHash"])
            with self.assertRaises(ValueError):
                host_configuration(lock, "https://secret@example.modal.run", "FORGE_CUBE_TOKEN")


if __name__ == "__main__":
    unittest.main()
