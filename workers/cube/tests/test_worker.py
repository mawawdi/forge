"""Offline fixed dependency tests; never import torch or invoke a model."""

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import os

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from contracts import canonical, digest, named_obj, parse_obj, strict_json, validate_job
from installation import exclusive_json, read_regular, file_pin
import installation
import worker

TRIANGLE = b"o mesh\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"
INSTALLATION = "a" * 64
JOB = "00000000-0000-4000-8000-000000000001"
PART_JOB = "00000000-0000-4000-8000-000000000002"
FAILURE_JOB = "00000000-0000-4000-8000-000000000003"


def job():
    return {"kind": "CubeRemoteJob", "jobId": JOB, "installationHash": INSTALLATION,
            "operation": "cube3d", "seed": 7, "prompt": "A sculptural arch",
            "bounds": {"x": 2, "y": 3, "z": 1}}


class ContractsTest(unittest.TestCase):
    def test_canonical_hash_matches_javascript_number_and_unicode_encoding(self):
        value = {"z": -0.0, "a": {"tiny": 0.0000001, "small": 0.000001}, "prompt": "אבג 🌿"}
        expected = '{"a":{"small":0.000001,"tiny":1e-7},"prompt":"אבג 🌿","z":0}'.encode()
        self.assertEqual(canonical(value), expected)
        candidate = job()
        candidate["bounds"]["x"] = 1e-7
        candidate["prompt"] = "אבג 🌿"
        self.assertEqual(validate_job(strict_json(canonical(candidate))), candidate)

    def test_jobs_are_closed_bounded_and_do_not_accept_paths_or_worker_options(self):
        for invalid in [dict(job(), device="cpu"), dict(job(), seed=True),
                        dict(job(), jobId="../escape"), dict(job(), installationHash="unknown"),
                        dict(job(), bounds={"x": 1, "y": float("inf"), "z": 1})]:
            with self.assertRaises(ValueError):
                validate_job(invalid)
        with self.assertRaises(ValueError):
            strict_json(b'{"seed":1,"seed":2}')
        with self.assertRaises(ValueError):
            strict_json(b'{"seed":NaN}')
        with self.assertRaisesRegex(ValueError, "depth limit"):
            strict_json(b"[" * 34 + b"0" + b"]" * 34)
        part = {"kind": "CubeRemoteJob", "jobId": PART_JOB, "installationHash": INSTALLATION,
                "operation": "cubepart", "seed": 0,
                "input": {"path": "input.obj", "sha256": digest(TRIANGLE), "bytes": len(TRIANGLE)},
                "parts": [{"id": "frame", "prompt": "outer frame"}]}
        self.assertEqual(validate_job(part), part)
        for invalid in [dict(part, parts=part["parts"] * 2),
                        dict(part, parts=[{"id": f"p{i}", "prompt": "part"} for i in range(9)]),
                        dict(part, input={**part["input"], "path": "/tmp/mesh.obj"})]:
            with self.assertRaises(ValueError):
                validate_job(invalid)

    def test_common_frame_restores_all_parts_without_independent_recentering(self):
        source = b"v 10 20 30\nv 14 20 30\nv 10 22 30\nf 1 2 3\n"
        vertices, faces, transform = parse_obj(source)
        self.assertEqual(transform, {"center": [12, 21, 30], "scale": 0.48})
        normalized = [[(v[i] - transform["center"][i]) * transform["scale"] for i in range(3)] for v in vertices]
        data, counts = named_obj([("frame", normalized, faces),
                                  ("door", [[v[0] + .48, v[1], v[2]] for v in normalized], faces)], transform)
        restored, restored_faces, _ = parse_obj(data)
        self.assertEqual(restored[:3], vertices)
        self.assertEqual(restored[3][0], vertices[0][0] + 1)
        self.assertEqual(restored_faces[1], [3, 4, 5])
        self.assertEqual([p["id"] for p in counts], ["frame", "door"])
        self.assertIn(b"o frame\n", data)
        self.assertIn(b"o door\n", data)

    def test_empty_parts_unsafe_obj_and_invalid_triangles_reject(self):
        for data in [b"mtllib https://remote\n" + TRIANGLE,
                     TRIANGLE.replace(b"f 1 2 3", b"f 1/1 2/2 3/3"),
                     TRIANGLE.replace(b"v 1 0 0", b"v inf 0 0"),
                     TRIANGLE.replace(b"f 1 2 3", b"f 1 2 8")]:
            with self.assertRaises(ValueError):
                parse_obj(data)
        for generated in [("door", [], []), ("door", None, None),
                          ("door", [[0, 0, 0]], [[0, 0, 0]])]:
            with self.assertRaises(ValueError):
                named_obj([generated])

    def test_regular_file_boundary_rejects_symlinks_and_changed_pin(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "input.obj").write_bytes(TRIANGLE)
            (root / "link.obj").symlink_to(root / "input.obj")
            for relative in ["link.obj", "../input.obj", "/etc/passwd"]:
                with self.assertRaises(ValueError):
                    read_regular(root, relative, 1024)
            expected = file_pin(root, "input.obj")
            (root / "input.obj").write_bytes(TRIANGLE + b"# edited\n")
            self.assertNotEqual(file_pin(root, "input.obj"), expected)


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.jobs = self.root / "jobs"
        self.inputs = self.root / "inputs"
        self.jobs.mkdir()
        self.inputs.mkdir()
        self.patches = [patch.object(worker, "load_installation", return_value={"hash": INSTALLATION})]
        for mocked in self.patches:
            mocked.start()

    def tearDown(self):
        for mocked in self.patches:
            mocked.stop()
        self.temp.cleanup()

    def success(self, _, directory):
        (directory / "output.obj").write_bytes(TRIANGLE)
        exclusive_json(directory / "metadata.json", {
            "parts": [{"id": "mesh", "vertices": 3, "triangles": 1}],
            "coordinateFrame": "cube_normalized_aspect_conditioned"})
        return {"exitCode": 0, "reason": None,
                "stdout": worker.captured(b"recorded fixture"), "stderr": worker.captured(b"")}

    def test_committed_launch_precedes_execution_and_identical_replay_never_executes(self):
        events = []

        def commit():
            self.assertTrue((self.jobs / JOB / "launch.json").is_file())
            events.append("committed")

        def execute(*args):
            self.assertEqual(events, ["committed"])
            events.append("executed")
            return self.success(*args)

        with patch.object(worker, "execute", side_effect=execute) as child:
            result = worker.run_job(job(), self.root, self.jobs, self.inputs, commit)
            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(result["output"]["sha256"], digest(TRIANGLE))
            self.assertEqual(worker.run_job(job(), self.root, self.jobs, self.inputs), result)
            self.assertEqual(child.call_count, 1)
            with self.assertRaisesRegex(ValueError, "another immutable request"):
                worker.run_job(dict(job(), prompt="different"), self.root, self.jobs, self.inputs)

    def test_failed_durable_commit_prevents_execution_and_retains_consumed_job(self):
        def failed_commit():
            raise RuntimeError("recorded volume commit failure")
        with patch.object(worker, "execute") as child:
            result = worker.run_job(job(), self.root, self.jobs, self.inputs, failed_commit)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["failure"]["code"], "launch_commit_failed")
            child.assert_not_called()
            self.assertEqual(worker.run_job(job(), self.root, self.jobs, self.inputs), result)
            child.assert_not_called()

    def test_unknown_execution_output_mismatch_and_failure_logs_remain_auditable(self):
        with patch.object(worker, "execute", side_effect=self.success):
            worker.run_job(job(), self.root, self.jobs, self.inputs)
        directory = self.jobs / JOB
        (directory / "output.obj").write_bytes(TRIANGLE + b"# tampered\n")
        with self.assertRaisesRegex(ValueError, "differs from receipt"):
            worker.read_job_status(self.jobs, JOB)
        (directory / "result.json").unlink()
        with patch.object(worker, "execute") as child:
            result = worker.run_job(job(), self.root, self.jobs, self.inputs)
            self.assertEqual(result["kind"], "CubeRemoteStatus")
            self.assertEqual(result["status"], "recovery_required")
            child.assert_not_called()
        other = dict(job(), jobId=FAILURE_JOB)
        execution = {"exitCode": 1, "reason": None, "stdout": worker.captured(b""),
                     "stderr": worker.captured(b"recorded CUDA failure")}
        with patch.object(worker, "execute", return_value=execution):
            failed = worker.run_job(other, self.root, self.jobs, self.inputs)
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["execution"], execution)
        self.assertEqual(worker.read_job_status(self.jobs, FAILURE_JOB), failed)

    def test_input_hash_rejects_before_claim_and_installation_change_rejects_success(self):
        part = {"kind": "CubeRemoteJob", "jobId": PART_JOB, "installationHash": INSTALLATION,
                "operation": "cubepart", "seed": 0, "input": {
                    "path": "input.obj", "sha256": "b" * 64, "bytes": len(TRIANGLE)},
                "parts": [{"id": "door", "prompt": "door"}]}
        (self.inputs / "input.obj").write_bytes(TRIANGLE)
        with self.assertRaisesRegex(ValueError, "differs from request pin"):
            worker.run_job(part, self.root, self.jobs, self.inputs)
        self.assertFalse((self.jobs / PART_JOB).exists())
        with patch.object(worker, "load_installation", side_effect=[{"hash": INSTALLATION}, ValueError("changed installation")]), patch.object(worker, "execute", side_effect=self.success):
            result = worker.run_job(job(), self.root, self.jobs, self.inputs)
        self.assertEqual(result["status"], "failed")
        self.assertIn("changed installation", result["failure"]["detail"])


class SubprocessTest(unittest.TestCase):
    def test_group_permission_race_checks_exit_before_direct_fallback(self):
        process = Mock(pid=123)
        process.poll.side_effect = [None, 0]
        with patch.object(worker.os, "killpg", side_effect=PermissionError("recorded exited group")):
            self.assertIsNone(worker.terminate_process_group(process))
        process.kill.assert_not_called()

        process = Mock(pid=123)
        process.poll.return_value = None
        with patch.object(worker.os, "killpg", side_effect=PermissionError("recorded denied group")):
            self.assertEqual(worker.terminate_process_group(process), "process_group_termination_incomplete")
        process.kill.assert_called_once()

        process = Mock(pid=123)
        process.poll.return_value = None
        process.kill.side_effect = PermissionError("recorded denied child")
        with patch.object(worker.os, "killpg", side_effect=PermissionError("recorded denied group")):
            with self.assertRaisesRegex(RuntimeError, "unable to kill live worker child"):
                worker.terminate_process_group(process)

    def test_cpu_import_gate_is_offline_in_child_without_poisoning_parent_downloads(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "installation.py").write_text(
                "import json,os\nprint('recorded import log')\n"
                "print(json.dumps({'offline':os.environ.get('HF_HUB_OFFLINE'),"
                "'tokenPresent':'FORGE_CUBE_TOKEN' in os.environ}))\n")
            with patch.object(installation, "WORKER_ROOT", root), patch.dict(os.environ, {
                    "HF_HUB_OFFLINE": "0", "FORGE_CUBE_TOKEN": "test-only"}):
                result = installation.runtime_import_check(root)
                self.assertEqual(result, {"offline": "1", "tokenPresent": False})
                self.assertEqual(os.environ["HF_HUB_OFFLINE"], "0")

    def test_child_environment_has_no_http_model_or_deployment_credentials(self):
        env = worker.child_environment({
            "PATH": "/usr/bin", "HOME": "/home/worker", "CUDA_VISIBLE_DEVICES": "0",
            "LD_LIBRARY_PATH": "/cuda/lib", "HF_HOME": "/cache/hf",
            "TORCHINDUCTOR_CACHE_DIR": "/compile-cache/inductor",
            "TRITON_CACHE_DIR": "/compile-cache/triton", "WARP_CACHE_PATH": "/compile-cache/warp",
            "FORGE_CUBE_TOKEN": "test-only", "MODAL_TOKEN_ID": "test-only",
            "MODAL_TOKEN_SECRET": "test-only", "HF_TOKEN": "test-only",
            "HUGGING_FACE_HUB_TOKEN": "test-only", "AWS_SECRET_ACCESS_KEY": "test-only",
            "PYTHONPATH": "/untrusted", "LD_PRELOAD": "/untrusted/library.so",
        })
        self.assertEqual(set(env), {"PATH", "HOME", "CUDA_VISIBLE_DEVICES", "LD_LIBRARY_PATH",
                                   "HF_HOME", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE",
                                   "PYTHONNOUSERSITE", "PYTHONDONTWRITEBYTECODE",
                                   "HF_HUB_DISABLE_TELEMETRY", "TORCHINDUCTOR_CACHE_DIR",
                                   "TRITON_CACHE_DIR", "WARP_CACHE_PATH"})
        self.assertEqual(env["CUDA_VISIBLE_DEVICES"], "0")
        self.assertEqual(env["HF_HUB_OFFLINE"], "1")
        self.assertEqual(env["TORCHINDUCTOR_CACHE_DIR"], "/compile-cache/inductor")
        self.assertEqual(env["TRITON_CACHE_DIR"], "/compile-cache/triton")
        self.assertEqual(env["WARP_CACHE_PATH"], "/compile-cache/warp")

    def test_fixed_child_nonzero_exit_retains_exact_logs_without_model_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "inference.py").write_text(
                "import sys\nsys.stdout.write('recorded output')\nsys.stderr.write('recorded error')\nsys.exit(7)\n")
            with patch.object(worker, "WORKER_ROOT", root):
                result = worker.execute(root, root)
            self.assertEqual(result["exitCode"], 7)
            self.assertIsNone(result["reason"])
            self.assertEqual(result["stdout"], worker.captured(b"recorded output"))
            self.assertEqual(result["stderr"], worker.captured(b"recorded error"))

    def test_fixed_child_timeout_and_log_limit_terminate_without_unbounded_capture(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for source, limit, expected in [
                ("import time\ntime.sleep(30)\n", .02, "execution_timeout"),
                ("print('x'*10000,flush=True)\n", 10, "log_limit"),
            ]:
                (root / "inference.py").write_text(source)
                with patch.object(worker, "WORKER_ROOT", root), patch.object(worker, "TIMEOUT_SECONDS", limit), patch.object(worker, "MAX_LOG_BYTES", 64):
                    result = worker.execute(root, root)
                self.assertIn(result["reason"], [expected, expected + "; process_group_termination_incomplete"])
                self.assertLessEqual(result["stdout"]["bytes"] + result["stderr"]["bytes"], 64)

    def test_real_child_direct_kill_preserves_timeout_and_reports_group_uncertainty(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "inference.py").write_text("import time\ntime.sleep(30)\n")
            with patch.object(worker, "WORKER_ROOT", root), patch.object(worker, "TIMEOUT_SECONDS", .02), patch.object(worker.os, "killpg", side_effect=PermissionError("recorded denied group")):
                result = worker.execute(root, root)
            self.assertEqual(result["reason"], "execution_timeout; process_group_termination_incomplete")
            self.assertIsNotNone(result["exitCode"])
            self.assertNotEqual(result["exitCode"], 0)


if __name__ == "__main__":
    unittest.main()
