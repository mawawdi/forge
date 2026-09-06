"""Explicit operator commands. `manifest` is local and never imports Modal."""

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlparse

from contracts import canonical, digest, strict_json
from installation import exclusive_json, file_pin, read_regular

ROOT = Path(__file__).resolve().parent
DEPLOY_FILES = ("contracts.py", "installation.py", "inference.py", "worker.py", "pins.json",
                "job_store.py", "modal_app.py", "deploy.py", "requirements.txt", "requirements-deploy.txt")


def read_manifest(path):
    path = Path(path).absolute()
    value = strict_json(read_regular(path.parent, path.name, 4 * 1024 * 1024), 4 * 1024 * 1024)
    body = {key: item for key, item in value.items() if key != "hash"}
    if (value.get("kind") != "CubeRemoteInstallation" or value.get("root") != "/opt/forge-cube"
            or value.get("hash") != digest(canonical(body))
            or value.get("licenseScope") != "noncommercial_research_only"):
        raise ValueError("Invalid sealed installation manifest")
    return value


def host_configuration(lock, endpoint, token_environment):
    url = urlparse(endpoint)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.query or url.fragment or endpoint.endswith("/")):
        raise ValueError("Endpoint must be an HTTPS base URL without credentials/query/trailing slash")
    if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", token_environment):
        raise ValueError("Use an environment variable name, never a secret value")
    code = {"workerFiles": lock["workerFiles"],
            "source": [p for p in lock["files"] if p["path"].startswith("source/")]}
    configuration = {"configs": [p for p in lock["files"] if p["path"].startswith("configs/")],
                     "python": lock["python"], "dependencyVersionsHash": lock["dependencyVersionsHash"],
                     "upstream": lock["upstream"], "licenseScope": lock["licenseScope"]}
    checkpoints = [digest(canonical(lock["upstream"]["models"][name]))
                   for name in sorted(lock["upstream"]["models"])]
    return {"kind": "CreatorCubeInstallation", "cube": {
        "kind": "cube_remote", "endpoint": endpoint, "tokenEnvironment": token_environment,
        "installationHash": lock["hash"], "codeHash": digest(canonical(code)),
        "configurationHash": digest(canonical(configuration)), "checkpointHashes": checkpoints,
        "license": "Roblox Cube noncommercial research; see sealed upstream license files"},
        "policy": {"timeoutMs": 900000, "maximumLogBytes": 1048576,
                   "maximumInputBytes": 16777216, "maximumOutputBytes": 16777216}}


def provision_key():
    return digest(canonical([file_pin(ROOT, name) for name in DEPLOY_FILES]))


def reserve_deployment(lock, installation_path, env):
    """Read-only account check, then consume this local deployment attempt once."""
    name = "forge-cube-" + lock["hash"][:40]
    marker = Path(str(Path(installation_path).absolute()) + ".deploy-attempt.json")
    if marker.exists() or marker.is_symlink():
        raise ValueError("Deployment attempt already consumed; inspect its outcome, do not retry")
    listed = subprocess.run([sys.executable, "-m", "modal", "app", "list", "--json"],
                            env=env, check=True, capture_output=True, timeout=30)
    apps = strict_json(listed.stdout, 4 * 1024 * 1024)
    if type(apps) is not list or any(type(item) is not dict or "description" not in item for item in apps):
        raise ValueError("Unexpected Modal app listing; deployment refused")
    if any(item["description"] == name for item in apps):
        raise ValueError("Installation deployment already exists; overwriting is forbidden")
    exclusive_json(marker, {"kind": "CubeDeploymentAttempt", "installationHash": lock["hash"],
                           "appName": name, "provisionKey": env["FORGE_CUBE_PROVISION_KEY"]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare", help="Paid CPU provisioning/download step; no GPU inference")
    prepare.add_argument("--manifest-out", required=True)
    deploy = commands.add_parser("deploy", help="Deploy the fixed authenticated endpoint; no inference")
    deploy.add_argument("--installation", required=True)
    manifest = commands.add_parser("manifest", help="LOCAL ONLY: emit host config from a sealed manifest")
    manifest.add_argument("--installation", required=True)
    manifest.add_argument("--endpoint", required=True)
    manifest.add_argument("--token-environment", default="FORGE_CUBE_TOKEN")
    manifest.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.command == "manifest":
        value = host_configuration(read_manifest(args.installation), args.endpoint, args.token_environment)
        exclusive_json(Path(args.output).absolute(), value)
        print("Wrote local installation config; no cloud calls were made.")
        return
    env = dict(os.environ, FORGE_CUBE_PROVISION_KEY=provision_key())
    if args.command == "prepare":
        if Path(args.manifest_out).exists():
            raise ValueError("Manifest output must be absent")
        env["FORGE_CUBE_PREPARE"] = "1"
        command = [sys.executable, "-m", "modal", "run", str(ROOT / "modal_app.py") + "::prepare",
                   "--manifest-out", str(Path(args.manifest_out).absolute())]
    else:
        lock = read_manifest(args.installation)
        if lock["workerFiles"] != [file_pin(ROOT, pin["path"]) for pin in lock["workerFiles"]]:
            raise ValueError("Worker files changed since provisioning; seal a new installation")
        env.pop("FORGE_CUBE_PREPARE", None)
        env["FORGE_CUBE_INSTALLATION_HASH"] = lock["hash"]
        reserve_deployment(lock, args.installation, env)
        command = [sys.executable, "-m", "modal", "deploy", str(ROOT / "modal_app.py")]
    subprocess.run(command, env=env, check=True)


if __name__ == "__main__":
    main()
