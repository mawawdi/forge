/** Host-process cache of successful official parser output, never semantic gate results. */
export class LuauParseCache {
  private readonly entries = new Map<string, { stdout: string; stderr: string; bytes: number }>();
  private bytes = 0;

  constructor(private readonly maximumBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
      throw new Error("Parser cache byte capacity must be a positive safe integer");
  }

  get(key: string): { stdout: string; stderr: string } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { stdout: entry.stdout, stderr: entry.stderr };
  }

  put(key: string, output: { stdout: string; stderr: string }): void {
    const bytes =
      Buffer.byteLength(key) + Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr);
    if (bytes > this.maximumBytes) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(key);
    }
    while (this.bytes + bytes > this.maximumBytes) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
    this.entries.set(key, { stdout: output.stdout, stderr: output.stderr, bytes });
    this.bytes += bytes;
  }
}
