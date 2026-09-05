import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ImmutableJsonArtifactStore,
  assertSafeAbsoluteDirectory,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";

export const HOST_PHASES = [
  "conversation_context",
  "project_capture",
  "source_analysis",
  "build_preparation",
  "local_build_review",
  "source_transfer",
  "prepare_transport",
  "preflight_roundtrip",
  "apply_readback_roundtrip",
  "post_state_capture",
  "reconciliation",
  "finalization_roundtrip",
  "acknowledgement_send",
  "conversation_publication",
] as const;
export type HostPhase = (typeof HOST_PHASES)[number];
export interface HostPhaseCorrelation {
  sessionId: string;
  projectId?: string;
  conversationId?: string;
  episodeId?: string;
  jobId?: string;
  agentRunId?: string;
  requestId?: string;
  revisionHash?: string;
  changeSetHash?: string;
}
export interface HostPhaseStart {
  kind: "HostPhaseStart";
  id: string;
  phase: HostPhase;
  correlation: HostPhaseCorrelation;
  startedAt: string;
  measurement: "host_elapsed";
}
export interface HostPhaseCompletion {
  kind: "HostPhaseCompletion";
  start: ArtifactReference;
  span: HostPhaseStart;
  endedAt: string;
  durationMs: number;
  /** Promise resolution is not a local gate or Studio verdict. */
  outcome: "returned" | "threw";
}
export interface HostPhaseClock {
  now(): Date;
  monotonicNow(): number;
}
const MAX_ARTIFACT_BYTES = 16 * 1024;
const MAX_ARTIFACTS = 20_000;
const MAX_REPORT_BYTES = 32 * 1024 * 1024;

/** Operational timing never supplies mutation authority or changes a work result. */
export class HostPhaseRecorder {
  readonly persistenceFailures: Array<{ sessionId: string; phase: HostPhase }> = [];
  constructor(
    private readonly directory: string,
    private readonly clock: HostPhaseClock = {
      now: () => new Date(),
      monotonicNow: () => performance.now(),
    },
  ) {}

  async start(phase: HostPhase, correlation: HostPhaseCorrelation) {
    const span: HostPhaseStart = {
      kind: "HostPhaseStart",
      id: `host_phase_${randomUUID()}`,
      phase,
      correlation: { ...correlation },
      startedAt: this.clock.now().toISOString(),
      measurement: "host_elapsed",
    };
    assertHostPhaseStart(span);
    const monotonicStart = this.clock.monotonicNow();
    const store = timingStore(this.directory, correlation.sessionId);
    let start: ArtifactReference | undefined;
    try {
      start = await store.write(span);
    } catch {
      this.failed(span);
    }
    let closed = false;
    return async (outcome: HostPhaseCompletion["outcome"]) => {
      if (closed) throw new Error("Host phase already completed");
      closed = true;
      const durationMs = Math.max(0, Math.round(this.clock.monotonicNow() - monotonicStart));
      if (start === undefined) return;
      const completed: HostPhaseCompletion = {
        kind: "HostPhaseCompletion",
        start,
        span,
        durationMs,
        outcome,
        endedAt: new Date(Date.parse(span.startedAt) + durationMs).toISOString(),
      };
      try {
        await store.write(completed);
      } catch {
        this.failed(span);
      }
    };
  }

  async measure<T>(
    phase: HostPhase,
    correlation: HostPhaseCorrelation,
    work: () => Promise<T> | T,
  ): Promise<T> {
    const finish = await this.start(phase, correlation);
    try {
      const result = await work();
      await finish("returned");
      return result;
    } catch (error) {
      await finish("threw");
      throw error;
    }
  }

  private failed(span: HostPhaseStart) {
    this.persistenceFailures.push({ sessionId: span.correlation.sessionId, phase: span.phase });
  }
}

export async function loadCreatorHostTimingReport(directory: string, sessionId: string) {
  assertSessionId(sessionId);
  const store = timingStore(directory, sessionId);
  const artifacts = join(store.root, "artifacts");
  const starts = new Map<string, { span: HostPhaseStart; reference: ArtifactReference }>();
  const completions: HostPhaseCompletion[] = [];
  let entries: string[] = [];
  try {
    await assertSafeAbsoluteDirectory(resolve(directory));
    for (const path of [join(resolve(directory), "host-timings"), store.root, artifacts]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Unsafe host timing directory");
    }
    entries = await readdir(artifacts);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (entries.length > MAX_ARTIFACTS)
    throw new Error("Host timing artifact count exceeds report limit");
  let totalBytes = 0;
  for (const name of entries.sort()) {
    // Ignore only unpublished atomic-write files; they never establish a start or finish.
    if (name.startsWith(".")) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Invalid host timing artifact name");
    const stat = await lstat(join(artifacts, name));
    totalBytes += stat.size;
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_ARTIFACT_BYTES ||
      totalBytes > MAX_REPORT_BYTES
    )
      throw new Error("Unsafe or oversized host timing evidence");
    const reference = {
      locator: `artifacts/${name}`,
      artifactHash: name.slice(0, -5),
      bytes: stat.size,
    };
    const value = await store.read(reference);
    if (record(value) && value.kind === "HostPhaseStart") {
      assertHostPhaseStart(value);
      if (value.correlation.sessionId !== sessionId || starts.has(value.id))
        throw new Error("Host timing session or ID mismatch");
      starts.set(value.id, { span: value, reference });
    } else {
      assertHostPhaseCompletion(value);
      if (value.span.correlation.sessionId !== sessionId)
        throw new Error("Host timing session mismatch");
      completions.push(value);
    }
  }
  const completedIds = new Set<string>();
  for (const completion of completions) {
    const start = starts.get(completion.span.id);
    if (
      !start ||
      completedIds.has(completion.span.id) ||
      stableJson(start.span) !== stableJson(completion.span) ||
      stableJson(start.reference) !== stableJson(completion.start)
    )
      throw new Error("Host timing completion lost its unique immutable start");
    completedIds.add(completion.span.id);
  }
  completions.sort(
    (a, b) =>
      a.span.startedAt.localeCompare(b.span.startedAt) || a.span.id.localeCompare(b.span.id),
  );
  const incomplete = [...starts.values()]
    .filter(({ span }) => !completedIds.has(span.id))
    .map(({ span }) => span);
  const phases = HOST_PHASES.flatMap((phase) => {
    const spans = completions.filter((item) => item.span.phase === phase);
    const durations = spans.map((item) => item.durationMs).sort((a, b) => a - b);
    if (durations.length === 0) return [];
    return [
      {
        phase,
        count: spans.length,
        threw: spans.filter((item) => item.outcome === "threw").length,
        durationMs: {
          sum: durations.reduce((a, b) => a + b, 0),
          p50: percentile(durations, 0.5),
          p95: percentile(durations, 0.95),
        },
      },
    ];
  });
  return {
    kind: "CreatorHostTimingReport" as const,
    sessionId,
    status: starts.size === 0 ? ("unavailable" as const) : ("available" as const),
    spans: completions,
    incomplete,
    phases,
    agentRunIds: [
      ...new Set(
        [...starts.values()].flatMap(({ span }) =>
          span.correlation.agentRunId ? [span.correlation.agentRunId] : [],
        ),
      ),
    ].sort(),
    limitations: [
      "Durations measure host-observed elapsed time, including start-marker persistence; Studio round trips include transport, scheduling and engine work.",
      "A returned phase is not a successful mutation or verification verdict. Unfinished starts have unknown duration and outcome.",
      "Phases may overlap or nest; phase sums are not total turn latency. Absent phases are unavailable, not zero.",
      "Use correlated AgentRun traces for model-client and tool intervals; these do not isolate provider computation from network latency.",
    ],
  };
}

function timingStore(directory: string, sessionId: string) {
  assertSessionId(sessionId);
  return new ImmutableJsonArtifactStore(
    join(resolve(directory), "host-timings", contentHash(sessionId)),
    { maxBytes: MAX_ARTIFACT_BYTES },
  );
}
function assertSessionId(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_:-]{1,256}$/.test(value))
    throw new Error("Invalid host timing session ID");
}
function assertHostPhaseStart(value: unknown): asserts value is HostPhaseStart {
  if (
    !record(value) ||
    value.kind !== "HostPhaseStart" ||
    typeof value.id !== "string" ||
    !/^host_phase_[a-f0-9-]{36}$/.test(value.id) ||
    !HOST_PHASES.includes(value.phase as HostPhase) ||
    value.measurement !== "host_elapsed" ||
    !canonicalIso(value.startedAt) ||
    !record(value.correlation)
  )
    throw new Error("Invalid host phase start");
  assertSessionId(value.correlation.sessionId as string);
  const fields = new Set([
    "sessionId",
    "projectId",
    "conversationId",
    "episodeId",
    "jobId",
    "agentRunId",
    "requestId",
    "revisionHash",
    "changeSetHash",
  ]);
  if (
    Object.entries(value.correlation).some(
      ([key, item]) =>
        !fields.has(key) || typeof item !== "string" || item.length === 0 || item.length > 256,
    )
  )
    throw new Error("Invalid host phase correlation");
}
function assertHostPhaseCompletion(value: unknown): asserts value is HostPhaseCompletion {
  if (
    !record(value) ||
    value.kind !== "HostPhaseCompletion" ||
    !record(value.start) ||
    !Number.isSafeInteger(value.durationMs) ||
    (value.durationMs as number) < 0 ||
    !canonicalIso(value.endedAt) ||
    !["returned", "threw"].includes(value.outcome as string)
  )
    throw new Error("Invalid host phase completion");
  assertHostPhaseStart(value.span);
  if (Date.parse(value.endedAt as string) - Date.parse(value.span.startedAt) !== value.durationMs)
    throw new Error("Host phase duration mismatch");
}
function percentile(values: number[], percentile: number) {
  return values[Math.ceil(values.length * percentile) - 1]!;
}
function canonicalIso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
