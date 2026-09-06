import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

export const DEFAULT_LUAU_ANALYSIS_DEADLINE_MS = 120_000;
export const MAXIMUM_LUAU_ANALYSIS_OUTPUT_BYTES = 20 * 1024 * 1024;

export interface LuauAnalysisExecutionOptions {
  /** Host policy, independent of model deadlines and candidate source/configuration. */
  deadlineMs?: number;
}

export interface AnalysisProcessFailure {
  kind: "timeout" | "output_limit" | "process_error" | "signal";
  detail: string;
}

export interface AnalysisProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  failure?: AnalysisProcessFailure;
}

/** A shared subprocess budget; adding source files cannot multiply the deadline. */
export class AnalysisProcessDeadline {
  readonly policy: { deadlineMs: number; killSignal: "SIGKILL"; maximumOutputBytes: number };
  private readonly expiresAt: number;
  private remainingOutputBytes = MAXIMUM_LUAU_ANALYSIS_OUTPUT_BYTES;

  constructor(options: LuauAnalysisExecutionOptions = {}) {
    const deadlineMs = options.deadlineMs ?? DEFAULT_LUAU_ANALYSIS_DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 2_147_483_647)
      throw new Error("Luau analysis deadlineMs must be an integer from 1 to 2147483647");
    this.policy = {
      deadlineMs,
      killSignal: "SIGKILL",
      maximumOutputBytes: MAXIMUM_LUAU_ANALYSIS_OUTPUT_BYTES,
    };
    this.expiresAt = performance.now() + deadlineMs;
  }

  run(
    executable: string,
    args: string[],
    options: { cwd: string; maxBuffer: number },
  ): AnalysisProcessResult {
    const timeout = Math.floor(this.expiresAt - performance.now());
    if (timeout < 1) return this.timeoutResult("before this process could start");
    if (this.remainingOutputBytes < 1)
      return {
        status: null,
        stdout: "",
        stderr: "",
        failure: this.outputFailure(),
      };
    const maxBuffer = Math.min(options.maxBuffer, this.remainingOutputBytes);
    // This bounds the invoked process, not descendants or OS capabilities.
    // Production should resolve direct tool binaries when using a launcher
    // that does not replace itself with the selected analyzer process.
    const result = spawnSync(executable, args, {
      ...options,
      maxBuffer,
      encoding: "utf8",
      timeout,
      // SIGTERM can be intercepted, causing spawnSync to wait indefinitely.
      killSignal: this.policy.killSignal,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rawStdout = result.stdout ?? "";
    const rawStderr = result.stderr ?? "";
    const stdout = takeUtf8(rawStdout, this.remainingOutputBytes);
    this.remainingOutputBytes -= Buffer.byteLength(stdout);
    const stderr = takeUtf8(rawStderr, this.remainingOutputBytes);
    this.remainingOutputBytes -= Buffer.byteLength(stderr);
    const output = { status: result.status, stdout, stderr };
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ETIMEDOUT") return { ...this.timeoutResult("while running"), ...output };
    if (
      code === "ENOBUFS" ||
      Buffer.byteLength(rawStdout) + Buffer.byteLength(rawStderr) > maxBuffer
    )
      return {
        ...output,
        failure: this.outputFailure(),
      };
    if (result.error)
      return {
        ...output,
        failure: { kind: "process_error", detail: result.error.message },
      };
    if (result.signal)
      return {
        ...output,
        failure: { kind: "signal", detail: `Terminated by ${result.signal}` },
      };
    return output;
  }

  /** Reused parser bytes still consume the current invocation's time/output budget. */
  reuse(output: { stdout: string; stderr: string }): AnalysisProcessResult {
    if (Math.floor(this.expiresAt - performance.now()) < 1)
      return this.timeoutResult("before cached output could be consumed");
    const bytes = Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr);
    if (bytes > this.remainingOutputBytes)
      return { status: null, stdout: "", stderr: "", failure: this.outputFailure() };
    this.remainingOutputBytes -= bytes;
    return { status: 0, ...output };
  }

  private outputFailure(): AnalysisProcessFailure {
    return {
      kind: "output_limit",
      detail: `Exceeded the subprocess output allowance within the shared ${this.policy.maximumOutputBytes}-byte analysis output budget`,
    };
  }

  private timeoutResult(stage: string): AnalysisProcessResult {
    return {
      status: null,
      stdout: "",
      stderr: "",
      failure: {
        kind: "timeout",
        detail: `Exceeded the shared ${this.policy.deadlineMs} ms analysis deadline ${stage}`,
      },
    };
  }
}

/** Keep retained UTF-8 output within the budget without splitting a code point. */
function takeUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.byteLength, maximumBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
