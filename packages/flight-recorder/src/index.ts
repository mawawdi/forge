import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, relative, resolve } from "node:path";
import { assertBuildTrace, contentHash, stableJson, type BuildOutcome, type BuildTrace, type BuildTraceEvent, type BuildTraceSpan, type ComponentVersion, type ForgeEventName, type ForgeSpanName, type Hash, type ID, type ModelConfiguration, type TraceAttributeValue, type TracePersistence } from "../../contracts/src/index.js";

export interface FlightRecorderContext {
  projectId: ID;
  project?: Partial<BuildTrace["project"]>;
  references?: BuildTrace["references"];
  components?: Partial<BuildTrace["components"]>;
}

export interface FlightRecorderOptions {
  now?: () => Date;
  traceIdFactory?: () => ID;
}

export interface ActiveSpan {
  id: ID;
  name: ForgeSpanName;
  startedAt: Date;
  attributes: Record<string, TraceAttributeValue>;
}

export interface TraceSink {
  persist(trace: BuildTrace): Promise<TracePersistence>;
}

export class FlightRecorder {
  private readonly now: () => Date;
  private readonly traceId: ID;
  private readonly startedAt: Date;
  private readonly spans: BuildTraceSpan[] = [];
  private readonly events: BuildTraceEvent[] = [];
  private readonly activeSpans = new Map<ID, ActiveSpan>();
  private sequence = 0;
  private project: BuildTrace["project"];
  private references: BuildTrace["references"];
  private components: BuildTrace["components"];
  private completed = false;

  constructor(context: FlightRecorderContext, options: FlightRecorderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.traceId = options.traceIdFactory?.() ?? `trace_${randomUUID()}`;
    this.startedAt = this.now();
    this.project = {
      id: context.projectId,
      snapshotRetention: context.project?.snapshotRetention ?? "not_retained",
      ...withoutUndefined(context.project ?? {})
    };
    this.references = withoutUndefined(context.references ?? {});
    const optionalComponents: Pick<BuildTrace["components"], "agent" | "model" | "repairPolicy"> = {};
    if (context.components?.agent) optionalComponents.agent = context.components.agent;
    if (context.components?.model) optionalComponents.model = context.components.model;
    if (context.components?.repairPolicy) optionalComponents.repairPolicy = context.components.repairPolicy;
    this.components = {
      toolchain: context.components?.toolchain ?? [],
      verifiers: context.components?.verifiers ?? [],
      ...optionalComponents
    };
  }

  setProject(project: Partial<BuildTrace["project"]>): void {
    this.assertOpen();
    this.project = { ...this.project, ...withoutUndefined(project) };
  }

  setReferences(references: Partial<BuildTrace["references"]>): void {
    this.assertOpen();
    this.references = { ...this.references, ...withoutUndefined(references) };
  }

  setComponents(components: Partial<BuildTrace["components"]>): void {
    this.assertOpen();
    this.components = { ...this.components, ...withoutUndefined(components) };
  }

  startSpan(name: ForgeSpanName, attributes: Record<string, TraceAttributeValue> = {}): ActiveSpan {
    this.assertOpen();
    const span: ActiveSpan = { id: `span_${this.sequence + 1}`, name, startedAt: this.now(), attributes: { ...attributes } };
    this.activeSpans.set(span.id, span);
    return span;
  }

  endSpan(span: ActiveSpan, status: BuildTraceSpan["status"], attributes: Record<string, TraceAttributeValue> = {}): number {
    this.assertOpen();
    if (!this.activeSpans.delete(span.id)) throw new Error(`Unknown or completed span: ${span.id}`);
    const endedAt = this.now();
    const durationMs = Math.max(0, endedAt.getTime() - span.startedAt.getTime());
    this.spans.push({ id: span.id, sequence: this.nextSequence(), name: span.name, startedAt: span.startedAt.toISOString(), endedAt: endedAt.toISOString(), durationMs, status, attributes: { ...span.attributes, ...attributes } });
    return durationMs;
  }

  addEvent(name: ForgeEventName, attributes: Record<string, TraceAttributeValue> = {}): void {
    this.assertOpen();
    const event: BuildTraceEvent = { id: `event_${this.sequence + 1}`, sequence: this.nextSequence(), name, occurredAt: this.now().toISOString(), attributes: { ...attributes } };
    this.events.push(event);
  }

  complete(outcome: BuildOutcome, evidence: BuildTrace["evidence"], replayability: BuildTrace["replayability"]): BuildTrace {
    this.assertOpen();
    if (this.activeSpans.size > 0) {
      for (const span of [...this.activeSpans.values()]) this.endSpan(span, "error", { "forge.instrumentation.error": "span_not_closed" });
    }
    this.addEvent("forge.build.completed", { "forge.build.status": outcome.status, "forge.build.verified": outcome.verified, "forge.issue.count": Object.values(outcome.issueCounts).reduce((total, count) => total + count, 0) });
    this.completed = true;
    const endedAt = this.now();
    const buildKey = createBuildKey({ project: this.project, references: this.references, components: this.components });
    return {
      kind: "BuildTrace",
      schemaVersion: 1,
      id: this.traceId,
      buildKey,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      project: this.project,
      references: this.references,
      components: this.components,
      spans: [...this.spans].sort(bySequence),
      events: [...this.events].sort(bySequence),
      outcome,
      evidence,
      replayability,
      privacy: { rawSourceStored: false, rawPromptStored: false, creatorIdentityStored: false }
    };
  }

  elapsedMs(): number {
    return Math.max(0, this.now().getTime() - this.startedAt.getTime());
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private assertOpen(): void {
    if (this.completed) throw new Error("Cannot record after trace completion");
  }
}

export class JsonFileTraceSink implements TraceSink {
  constructor(private readonly directory: string) {}

  async persist(trace: BuildTrace): Promise<TracePersistence> {
    assertBuildTrace(trace);
    const fileName = traceFileName(trace.id);
    await mkdir(this.directory, { recursive: true });
    const destination = join(this.directory, fileName);
    const temporary = join(this.directory, `.${fileName}.${randomUUID()}.tmp`);
    const serialized = `${stableJson(trace)}\n`;
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
    return { kind: "TracePersistence", schemaVersion: 1, traceId: trace.id, buildKey: trace.buildKey, status: "written", artifactHash: contentHash(serialized), locator: relative(process.cwd(), destination) || basename(destination) };
  }

  async read(traceId: ID): Promise<BuildTrace> {
    const source = await readFile(join(this.directory, traceFileName(traceId)), "utf8");
    const trace = JSON.parse(source) as unknown;
    assertBuildTrace(trace);
    return trace;
  }
}

export function defaultTraceDirectory(cwd: string = process.cwd()): string {
  return resolve(cwd, ".forge", "flight-recorder");
}

export function createBuildKey(context: Pick<BuildTrace, "project" | "references" | "components">): ID {
  return `build_${contentHash(stableJson(context)).slice(0, 24)}`;
}

export function compactIssueEvidence(issues: BuildTrace["evidence"]["issues"]): Hash {
  return contentHash(stableJson(issues));
}

function traceFileName(traceId: ID): string {
  if (!/^trace_[A-Za-z0-9-]+$/.test(traceId)) throw new Error(`Invalid trace ID: ${traceId}`);
  return `${traceId}.json`;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function bySequence<T extends { sequence: number }>(left: T, right: T): number {
  return left.sequence - right.sequence;
}

export type { ComponentVersion, ModelConfiguration };
