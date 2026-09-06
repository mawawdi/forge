import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Provisioning is an operator command. Tests use local dependencies and fake providers only.
const localPython = resolve(".forge/cube-client-venv/bin/python");
const python = process.env.FORGE_CUBE_PYTHON ?? (existsSync(localPython) ? localPython : "python3");
const probe = spawnSync(python, ["-c", "import rfc8785, modal, fastapi, httpx"], {
  encoding: "utf8",
});
if (probe.status !== 0) {
  process.stderr.write(
    "Cube offline tests need the small CPU client environment. Run python3 -m venv .forge/cube-client-venv, then .forge/cube-client-venv/bin/python -m pip install -r workers/cube/requirements-deploy.txt. No GPU packages or model weights are required.\n",
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(
    python,
    ["-m", "unittest", "discover", "-s", "workers/cube/tests", "-v"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    },
  );
  process.exitCode = result.status ?? 1;
}
