import { JsonFileTraceSink, defaultTraceDirectory } from "../../flight-recorder/src/index.js";
import { verifyProject } from "../../verifier/src/index.js";

const args = process.argv.slice(2);

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = args;
  if (command === "verify") {
    await verify(subcommand, rest);
    return;
  }
  if (command === "trace" && subcommand === "show") {
    await showTrace(rest[0], rest.slice(1));
    return;
  }
  usage();
  process.exitCode = 2;
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

function usage(): void {
  process.stderr.write("Usage:\n  forge verify <project-path> [--format json] [--trace-dir <path>]\n  forge trace show <trace-id> [--trace-dir <path>]\n");
}

void main();
