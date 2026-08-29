import { JsonFileTraceSink, defaultTraceDirectory } from "../../flight-recorder/src/index.js";
import { loadMechanicContract, repairProject } from "../../repair/src/orchestrator.js";
import { StudioBridgeServer } from "../../studio-bridge/src/index.js";
import { verifyProject } from "../../verifier/src/index.js";

const args = process.argv.slice(2);

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = args;
  if (command === "verify") {
    await verify(subcommand, rest);
    return;
  }
  if (command === "repair") {
    await repair(subcommand, rest);
    return;
  }
  if (command === "trace" && subcommand === "show") {
    await showTrace(rest[0], rest.slice(1));
    return;
  }
  if (command === "studio" && subcommand === "bridge") {
    await studioBridge(rest);
    return;
  }
  usage();
  process.exitCode = 2;
}

async function repair(projectPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseRepairOptions(optionArgs);
  if (!projectPath || !options.valid || !options.contractPath || !options.destinationRoot) {
    process.stderr.write("Usage: forge repair <project-path> --contract <path> --out <directory> [--trace-dir <path>]\n");
    process.exitCode = 2;
    return;
  }
  try {
    const contract = await loadMechanicContract(options.contractPath);
    const result = await repairProject(projectPath, contract, { destinationRoot: options.destinationRoot, ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}) });
    process.stdout.write(`${JSON.stringify({ kind: "RepairRun", schemaVersion: 1, before: result.before.report, patchSet: result.patchSet, application: result.application, after: result.after.report, proofBundle: result.proofBundle, tracePersistence: result.tracePersistence }, null, 2)}\n`);
    process.stderr.write(`Forge repair traces: ${result.before.trace.id}, ${result.after.trace.id}\n`);
    process.exitCode = result.after.report.gate.status === "incomplete" ? 2 : result.after.report.gate.status === "verified" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Unable to repair project: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

async function verify(projectPath: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseOptions(optionArgs);
  if (!projectPath || !options.valid) {
    process.stderr.write("Usage: forge verify <project-path> [--format json] [--trace-dir <path>]\n");
    process.exitCode = 2;
    return;
  }
  const run = await verifyProject(projectPath, { ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}) });
  process.stdout.write(`${JSON.stringify(run.report, null, 2)}\n`);
  const persistence = run.tracePersistence;
  if (persistence.status === "written") {
    process.stderr.write(`Forge trace: ${persistence.traceId} (${persistence.locator ?? "local JSON"})\n`);
  } else {
    process.stderr.write(`Forge trace persistence ${persistence.status}: ${persistence.error ?? "no artifact written"}\n`);
  }
  process.exitCode = run.report.gate.status === "incomplete" ? 2 : run.report.gate.status === "verified" ? 0 : 1;
}

async function showTrace(traceId: string | undefined, optionArgs: string[]): Promise<void> {
  const options = parseOptions(optionArgs);
  if (!traceId || !options.valid) {
    process.stderr.write("Usage: forge trace show <trace-id> [--trace-dir <path>]\n");
    process.exitCode = 2;
    return;
  }
  try {
    const trace = await new JsonFileTraceSink(options.traceDirectory ?? defaultTraceDirectory()).read(traceId);
    process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Unable to read trace ${traceId}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

async function studioBridge(optionArgs: string[]): Promise<void> {
  const options = parseBridgeOptions(optionArgs);
  if (!options.valid) {
    process.stderr.write("Usage: forge studio bridge [--host <host>] [--port <port>]\n");
    process.exitCode = 2;
    return;
  }
  const bridge = new StudioBridgeServer({ ...(options.host ? { host: options.host } : {}), ...(options.port !== undefined ? { port: options.port } : {}) });
  bridge.subscribe((message) => {
    process.stdout.write(`\n[studio -> forge] ${message.type}${message.sessionId ? ` (${message.sessionId})` : ""}\n${JSON.stringify(message, null, 2)}\n`);
  });
  const address = await bridge.listen();
  process.stdout.write(`Forge Studio bridge listening at http://${address.host}:${address.port}\nPairing token (one use, expires ${address.pairing.expiresAt}): ${address.pairing.token}\n`);
  await new Promise<void>((resolve, reject) => {
    const close = () => { void bridge.close().then(resolve).catch(reject); };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

function parseOptions(values: string[]): { valid: boolean; traceDirectory?: string } {
  let traceDirectory: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (option === "--format" && values[index + 1] === "json") {
      index += 1;
      continue;
    }
    if (option === "--trace-dir" && values[index + 1]) {
      traceDirectory = values[index + 1];
      index += 1;
      continue;
    }
    return { valid: false };
  }
  return traceDirectory ? { valid: true, traceDirectory } : { valid: true };
}

function parseRepairOptions(values: string[]): { valid: boolean; contractPath?: string; destinationRoot?: string; traceDirectory?: string } {
  let contractPath: string | undefined;
  let destinationRoot: string | undefined;
  let traceDirectory: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (option === "--contract" && values[index + 1]) {
      contractPath = values[index + 1];
      index += 1;
      continue;
    }
    if (option === "--out" && values[index + 1]) {
      destinationRoot = values[index + 1];
      index += 1;
      continue;
    }
    if (option === "--trace-dir" && values[index + 1]) {
      traceDirectory = values[index + 1];
      index += 1;
      continue;
    }
    return { valid: false };
  }
  return { valid: true, ...(contractPath ? { contractPath } : {}), ...(destinationRoot ? { destinationRoot } : {}), ...(traceDirectory ? { traceDirectory } : {}) };
}

function parseBridgeOptions(values: string[]): { valid: boolean; host?: string; port?: number } {
  let host: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const next = values[index + 1];
    if (option === "--host" && next) { host = next; index += 1; continue; }
    if (option === "--port" && next && /^\d+$/.test(next)) { port = Number(next); index += 1; continue; }
    return { valid: false };
  }
  return { valid: true, ...(host ? { host } : {}), ...(port !== undefined ? { port } : {}) };
}

function usage(): void {
  process.stderr.write("Usage:\n  forge verify <project-path> [--format json] [--trace-dir <path>]\n  forge repair <project-path> --contract <path> --out <directory> [--trace-dir <path>]\n  forge trace show <trace-id> [--trace-dir <path>]\n  forge studio bridge [--host <host>] [--port <port>]\n");
}

void main();
