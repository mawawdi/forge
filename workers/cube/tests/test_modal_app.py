"""Real pinned SDK/ASGI definitions, with all cloud and inference edges replaced."""

import importlib
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from contracts import canonical, digest
from installation import exclusive_json
from job_store import SubmissionStore

INSTALLATION = "b" * 64
JOB_ID = "00000000-0000-4000-8000-000000000001"
TOKEN = "offline-test-token-is-at-least-32-characters"


def job():
    return {"kind": "CubeRemoteJob", "jobId": JOB_ID, "installationHash": INSTALLATION,
            "operation": "cube3d", "seed": 3, "prompt": "A sculptural arch",
            "bounds": {"x": 2, "y": 3, "z": 1}}


class AtomicIndex:
    def __init__(self):
        self.values = {}

    def put(self, key, value, *, skip_if_exists):
        if skip_if_exists and key in self.values:
            return False
        self.values[key] = value
        return True

    def get(self, key):
        return self.values.get(key)


class ModalWrapperTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with patch.dict(os.environ, {"FORGE_CUBE_PREPARE": "0",
                        "FORGE_CUBE_PROVISION_KEY": "a" * 64,
                        "FORGE_CUBE_INSTALLATION_HASH": INSTALLATION}):
            cls.module = importlib.import_module("modal_app")

    def test_sdk_definitions_use_bounded_names_and_no_gpu_minimum(self):
        self.assertLessEqual(len(self.module.app.name), 64)
        self.assertIn(INSTALLATION[:40], self.module.app.name)
        self.assertNotIn("/compile-cache", self.module.mounts)
        self.assertIs(self.module.gpu_mounts["/compile-cache"], self.module.compilation_volume)
        self.assertEqual(self.module.COMPILATION_CACHE_ENV,
                         {"TORCHINDUCTOR_CACHE_DIR": "/compile-cache/inductor",
                          "TRITON_CACHE_DIR": "/compile-cache/triton",
                          "WARP_CACHE_PATH": "/compile-cache/warp"})

    def test_authenticated_http_routes_use_real_store_without_cloud_calls(self):
        with tempfile.TemporaryDirectory() as temp:
            events = []
            index = AtomicIndex()
            volume = types.SimpleNamespace(reload=lambda: events.append("reload"),
                                           commit=lambda: events.append("commit"))

            def spawn(value):
                events.append("spawn")
                return types.SimpleNamespace(object_id="fc-offline")

            def make_store(_root, installation, **kwargs):
                kwargs["worker_status"] = lambda _: {"kind": "CubeRemoteStatus", "status": "missing"}
                kwargs["poll"] = lambda _: "pending"
                return SubmissionStore(temp, installation, **kwargs)

            with (patch.dict(os.environ, {"FORGE_CUBE_TOKEN": TOKEN}),
                  patch.object(self.module, "jobs_volume", volume),
                  patch.object(self.module, "claims", index),
                  patch.object(self.module, "execute", types.SimpleNamespace(spawn=spawn)),
                  patch("job_store.installation_manifest", return_value={"hash": INSTALLATION}),
                  patch("job_store.SubmissionStore", side_effect=make_store)):
                client = TestClient(self.module.api.local())
                self.assertEqual(client.get("/health").status_code, 401)
                self.assertEqual(client.post("/jobs", json={"job": job()}).status_code, 401)
                headers = {"Authorization": "Bearer " + TOKEN}
                health = client.get("/health", headers=headers)
                self.assertEqual(health.json(), {"kind": "CubeRemoteHealth",
                                  "installationHash": INSTALLATION, "operations": ["cube3d", "cubepart"]})
                self.assertNotIn("spawn", events)
                self.assertEqual(client.post("/jobs", headers=headers, content=b'{"job":').status_code, 400)
                first = client.post("/jobs", headers=headers, json={"job": job()})
                self.assertEqual(first.status_code, 200)
                self.assertEqual(first.json()["status"], "queued")
                second = client.post("/jobs", headers=headers, json={"job": job()})
                self.assertEqual(first.json(), second.json())
                self.assertEqual(client.get("/jobs/" + JOB_ID, headers=headers).json(), first.json())
                self.assertEqual(events.count("spawn"), 1)
                changed = client.post("/jobs", headers=headers, json={"job": dict(job(), seed=4)})
                self.assertEqual(changed.status_code, 409)
                self.assertEqual(client.get("/jobs/" + JOB_ID + "/output", headers=headers).status_code, 409)
                self.assertEqual(events.count("spawn"), 1)

    def test_gpu_redelivery_cannot_call_core_twice(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            staged = root / "submissions" / JOB_ID
            staged.mkdir(parents=True)
            exclusive_json(staged / "request.json", {"job": job(), "jobHash": digest(canonical(job()))})
            index = AtomicIndex()
            volume = types.SimpleNamespace(reload=lambda: None, commit=lambda: None)
            cache_events = []
            cache = types.SimpleNamespace(reload=lambda: cache_events.append("reload"),
                                          commit=lambda: cache_events.append("commit"))
            real_path = Path

            def mapped_path(value):
                return root / value.removeprefix("/jobs/") if value.startswith("/jobs/") else real_path(value)

            def run_child(*args, before_execute):
                before_execute()
                cache_events.append("child-exited")
                return {"status": "succeeded"}

            with (patch.object(self.module, "Path", side_effect=mapped_path),
                  patch.object(self.module, "jobs_volume", volume),
                  patch.object(self.module, "compilation_volume", cache),
                  patch.object(self.module, "claims", index),
                  patch("worker.run_job", side_effect=run_child) as run,
                  patch("worker.read_job_status", return_value={"status": "recovery_required"})):
                self.assertEqual(self.module.execute.local(job()), {"status": "succeeded"})
                self.assertEqual(self.module.execute.local(job()), {"status": "recovery_required"})
                self.assertEqual(run.call_count, 1)
                self.assertEqual(cache_events, ["reload", "child-exited", "commit"])


if __name__ == "__main__":
    unittest.main()
