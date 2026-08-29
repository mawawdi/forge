# Lemonade Forge Architecture

Status: M1 and M1.5 complete  
Scope: candidate proof-of-work; local verifier plus portable execution evidence

## 1. Architectural stance

Forge is a control plane around replaceable models. One context-rich execution agent may propose a change, but deterministic services define its allowed semantic shape and decide whether it is eligible for commit. A forest of planner/executor agents is not part of the initial architecture.

The central flow is:

```text
GameIntent -> CoreLoop -> MechanicContract -> PatchSet
                                      |
                                      v
                           static + semantic verification
                                      |
                     preflight (non-authoritative, optional)
                                      |
                    StudioProof (authoritative, later)
                                      |
                                ProofBundle
                                      |
                            verified commit
                                      |
                                      v
                       BuildTrace -> local/debug sink
```

## 2. Proposed monorepo

```text
forge/
├── docs/
│   ├── deep-research-report.md
│   └── rfcs/flight-recorder.md
├── packages/
│   ├── contracts/              # JSON schemas and TypeScript types; no I/O
│   ├── intent/                 # intent -> CoreLoop resolution interfaces
│   ├── semantic-map/            # project tree, scripts, remotes, services, dependencies
│   ├── patch-model/             # bounded PatchSet operations and diff normalization
│   ├── luau-toolchain/          # official luau-analyze/Lute adapters and version checks
│   ├── verifier/                # rule engine, issue normalization, deterministic ordering
│   ├── flight-recorder/          # BuildTrace, spans/events, sink interface, local JSON sink
│   ├── preflight/               # pure Luau/Lute/Lune test adapter; never authoritative
│   ├── studio-proof/             # Studio assertion protocol; later implementation
│   ├── proofs/                  # ProofBundle assembly and serialization
│   ├── benchmarks/              # CoreLoopBench manifest and fixture loader
│   └── cli/                     # forge commands; M1 exposes verify
├── examples/
│   ├── insecure-tycoon/         # M1 fixture: valid Luau plus intentional vulnerabilities
│   └── fruit-loop/               # later vertical-slice place/contract/Studio fixture
├── benchmarks/
│   └── core-loop-bench/         # ten initial fixture directories and manifest
├── tools/
│   └── toolchain/               # pinned download/checksum/install documentation
├── test/
│   ├── contracts/
│   ├── verifier/
│   ├── cli/
│   └── fixtures/
├── SPEC.md
├── ARCHITECTURE.md
├── ROADMAP.md
└── EVALS.md
```

M1 should remain a local CLI and library monorepo. A database, hosted API, auth system, queue, dashboard, and Studio worker fleet are not prerequisites.

## 3. Component boundaries

### Contracts

Pure, serializable schemas are the system boundary. They must validate at load and output. Contracts contain no model-specific fields that would make a provider the semantic authority.

### Intent compiler

Transforms a raw creator request into a candidate `CoreLoop`. It may use a model in a later milestone, but its output is always validated and may contain unresolved questions. It must not generate arbitrary source as its primary output.

### Semantic map

Represents the relevant project structure: paths, script execution context, services, instances, remotes, module dependencies, persistence calls, and known state fields. M1 may build this from a deterministic filesystem fixture. Dynamic runtime discovery is an open question.

### Patch model

Represents a bounded proposed change as operations with provenance and expected effects. A raw whole-repository replacement is outside the initial safe patch surface. Patch application and rollback are later milestones; M1 only needs the representation for fixtures and diagnostic evidence.

### Luau toolchain adapter

The adapter invokes a pinned official Luau toolchain. The first required executable is `luau-analyze`; Lute may provide programmable rules once its version and invocation are pinned. The adapter records command, version, configuration, exit status, and raw diagnostic provenance.

No JavaScript Lua parser, regex-only parser, or custom “compatible” parser may stand in for official Luau parsing. If the official tool is unavailable, Forge fails clearly with a tool-health issue; it does not silently downgrade.

### Verifier

Runs independent deterministic rule families:

- official language/type/lint diagnostics;
- execution-context rules;
- remote graph and authority rules;
- persistence rules;
- economy and input-trust rules;
- structure and dependency rules.

The verifier aggregates issues, deduplicates only by a defined issue key, sorts them stably, and computes a gate result. Rule implementations may evolve, but rule IDs and evidence semantics must be documented.

### Preflight

Runs pure Luau tests and modeled simulations in Lute/Lune or an equivalent controlled runtime. It is useful for fast feedback and repair, but its output is labeled preflight. It cannot certify Roblox physics, network ownership, replication scheduling, DataStore behavior, or Studio lifecycle semantics.

### StudioProof

Later, a Studio connector executes `StudioAssertion` actions in an isolated place/session and reports observed state. It is the only component allowed to produce authoritative claims about engine behavior. The connector should use Roblox-native/official integration where available and keep interactive checks separate from long-running benchmark runs.

### Proof assembler

Combines all tier results into an immutable `ProofBundle` identified by source/dependency/rule/tool hashes. “Not run” and “unknown” remain visible. It does not infer a pass from a green static result.

### Flight Recorder

Records one build execution without becoming the verification authority. A `BuildTrace` has a content-derived `buildKey`, a unique `traceId`, project snapshot hashes/references, component versions, timing spans, discrete events, objective outcome dimensions, and compact issue summaries. It stores no raw source or creator-identifying data by default.

The recorder owns a generic sink interface. M1.5 provides an atomic local JSON/debug sink; future OpenTelemetry collectors, optional Langfuse export, and production backends are adapters. They are never required for Forge to verify a project.

`BuildTrace` is execution history. `ProofBundle` is decision evidence. A CoreLoopBench case is a reproducible fixture promoted from a reviewed failure. `ExperimentResult` later compares a fixed case/dataset across candidate configurations. These objects link by IDs and content hashes rather than embed redundant source trees.

### CLI

M1 command surface:

```text
forge verify <project-path> [--format json]
```

The CLI discovers the fixture, validates its manifest, invokes the official toolchain, runs deterministic Forge rules, emits one structured result, and sets exit status. Future commands (`intent`, `compile`, `proof`, `commit`, `bench`) are intentionally not required in M1.

## 4. M1 verification data flow

```text
project path
  -> canonical path + fixture manifest
  -> source inventory
  -> luau-analyze subprocess
  -> normalized Luau issues
  -> project semantic map
  -> deterministic Forge rules
  -> stable issue ordering
  -> M1 verification result / ProofBundle-shaped report
```

The command must be hermetic with respect to network and model providers. Tool paths and versions are explicit. Diagnostics must not contain machine-local absolute paths unless the output contract explicitly asks for them; use project-relative paths for reproducibility.

## 5. Flight Recorder flow and replay boundary

```text
verification invocation
  -> project snapshot hash + deterministic buildKey
  -> Forge spans/events
  -> VerificationReport (deterministic stdout)
  -> BuildTrace (unique local execution artifact)
  -> local JSON sink / optional future telemetry adapter
```

Current M1.5 replay is semantic reproduction only: use the recorded snapshot hash, manifest hash, rule set hash, and toolchain binary/configuration to rerun verification against a retained matching project. Exact replay needs immutable snapshots, patches, model responses, seeds, and Studio environment captures; it is deferred. Benchmark rerun is separate again: it executes a promoted fixture's assertions against a candidate configuration.

Instrumentation failures are visible but non-gating. A sink failure must not convert a valid verifier result into a rejected result, and it must not be hidden.

## 6. Official tooling references

The initial toolchain decision is based on the official Luau implementation and its maintained tooling:

- [Luau](https://github.com/luau-lang/luau) provides the language implementation, AST, and `luau-analyze` command-line type checker/linter.
- [Lute lint](https://lute.luau.org/cli/lint/index.html) is a programmable linter built on the official Luau language stack and is a candidate source for custom rules after its version is pinned.

These references are implementation inputs, not a commitment to embed native C++ libraries in M1. A subprocess adapter is the smallest inspectable boundary; embedding or a long-running sidecar can be evaluated after correctness is established.

## 7. TypeScript contracts

These are the proposed canonical shapes. They are intentionally JSON-serializable and use discriminated unions. The implementation should generate runtime validators from the same source or maintain equivalent checked schemas; hand-waving that “the TypeScript compiler validates JSON” is insufficient.

```ts
export type ID = string;
export type ISO8601 = string;
export type RelativePath = string;
export type Hash = string;

export type Risk = "low" | "medium" | "high" | "critical";
export type Authority = "client" | "server" | "shared" | "external";
export type VerificationStatus = "pass" | "fail" | "not_run" | "unknown";

export interface GameIntent {
  kind: "GameIntent";
  schemaVersion: 1;
  id: ID;
  rawPrompt: string;
  normalizedGoal: string;
  audience: "novice_creator" | "experienced_creator" | "unknown";
  genreSignals: string[];
  desiredOutcomes: string[];
  constraints: Array<{ id: ID; statement: string; source: "creator" | "system" }>;
  referencedMechanics: string[];
  unresolvedQuestions: string[];
  source: { type: "creator_prompt"; createdAt: ISO8601 };
}

export interface CoreLoop {
  kind: "CoreLoop";
  schemaVersion: 1;
  id: ID;
  intentId: ID;
  title: string;
  nodes: Array<{
    id: ID;
    label: string;
    category: "acquisition" | "conversion" | "progression" | "social" | "retention" | "monetization";
    mechanicContractId?: ID;
    status: "proposed" | "in_progress" | "verified";
  }>;
  edges: Array<{ from: ID; to: ID; condition?: string }>;
  entryNodeId: ID;
  nextRecommendedNodeId?: ID;
  invariants: string[];
}

export interface MechanicContract {
  kind: "MechanicContract";
  schemaVersion: 1;
  id: ID;
  coreLoopId: ID;
  name: string;
  playerGoal: string;
  preconditions: Array<{ id: ID; statement: string; authority: Authority }>;
  postconditions: Array<{ id: ID; statement: string; authority: Authority }>;
  authorityModel: {
    stateOwner: Authority;
    clientInputs: Array<{ name: string; type: string; trust: "untrusted" | "informational" }>;
    serverValidations: Array<"type" | "value" | "context" | "permission" | "rate_limit" | "ownership">;
    stateMutations: Array<{ field: string; authority: Authority; operation: string }>;
  };
  persistentState: Array<{ field: string; type: string; owner: "server"; durability: "session" | "persistent" }>;
  uiOutputs: Array<{ binding: string; sourceField: string; direction: "server_to_client" | "local" }>;
  economyEffects: Array<{ currency: string; delta: string; computedBy: "server" | "none" }>;
  instrumentation: Array<{ event: string; fields: string[]; privacyClass: "none" | "project" | "creator_sensitive" }>;
  studioAssertions: ID[];
  risk: Risk;
}

export interface PatchSet {
  kind: "PatchSet";
  schemaVersion: 1;
  id: ID;
  projectHash: Hash;
  mechanicContractId: ID;
  operations: Array<
    | { type: "create_script"; path: RelativePath; source: string; executionContext: "server" | "client" | "shared" }
    | { type: "replace_function"; path: RelativePath; symbol: string; beforeHash: Hash; source: string }
    | { type: "insert_statement"; path: RelativePath; symbol: string; anchor: string; source: string }
    | { type: "create_remote"; path: RelativePath; name: string; direction: "client_to_server" | "server_to_client" }
    | { type: "bind_ui"; path: RelativePath; binding: string; sourceField: string }
  >;
  expectedEffects: Array<{ statement: string; evidence: "static" | "contract" | "preflight" | "studio" }>;
  provenance: { model?: string; promptHash?: Hash; generatedAt: ISO8601 };
  bounds: { maxFiles: number; maxAddedLines: number; maxRemovedLines: number };
}

export interface VerificationIssue {
  kind: "VerificationIssue";
  schemaVersion: 1;
  id: ID;
  ruleId: string;
  severity: "info" | "warning" | "error" | "critical";
  category: "language" | "runtime_boundary" | "replication" | "security" | "persistence" | "economy" | "structure" | "performance" | "tooling";
  message: string;
  path?: RelativePath;
  location?: { line: number; column: number; endLine?: number; endColumn?: number };
  evidence: Array<{ type: "analyzer" | "ast" | "semantic_graph" | "test" | "studio"; statement: string; data?: Record<string, string | number | boolean> }>;
  remediation?: { kind: "deterministic" | "model_required" | "manual"; steps: string[] };
  authoritativeTier: "static" | "preflight" | "studio";
}

export interface StudioAssertion {
  kind: "StudioAssertion";
  schemaVersion: 1;
  id: ID;
  mechanicContractId: ID;
  name: string;
  setup: Array<{ action: string; actor: "server" | "client_1" | "client_2" | "system"; args?: Record<string, string | number | boolean> }>;
  actions: Array<{ action: string; actor: "server" | "client_1" | "client_2" | "system"; args?: Record<string, string | number | boolean> }>;
  observations: Array<{ path: string; relation: "equals" | "not_equals" | "increases_by" | "exists" | "rejected"; expected: string | number | boolean }>;
  authorityExpectation?: { mutationPath: string; owner: "server"; clientCannotSet: string[] };
  timeoutMs: number;
  tags: string[];
}

export interface ProofBundle {
  kind: "ProofBundle";
  schemaVersion: 1;
  id: ID;
  projectHash: Hash;
  patchSetId?: ID;
  generatedAt: ISO8601;
  toolchain: Array<{ name: string; version: string; command: string; configHash: Hash }>;
  checks: Array<{ name: string; tier: "static" | "preflight" | "studio"; status: VerificationStatus; issueIds: ID[]; resultHash?: Hash }>;
  issues: VerificationIssue[];
  assertions: Array<{ assertionId: ID; status: VerificationStatus; observed?: Record<string, string | number | boolean>; runId?: ID }>;
  gate: { status: "verified" | "rejected" | "incomplete"; reasons: string[] };
  reproducibility: { inputHash: Hash; dependencyHash: Hash; ruleSetHash: Hash; deterministic: boolean };
}

export interface BuildTrace {
  kind: "BuildTrace";
  schemaVersion: 1;
  id: ID;
  buildKey: ID;
  project: { id: ID; startingSnapshotHash?: Hash; resultingSnapshotHash?: Hash };
  references: { coreLoopId?: ID; mechanicContractId?: ID; patchSetId?: ID; benchmarkCaseId?: ID };
  components: { toolchain: ComponentVersion[]; verifiers: ComponentVersion[]; model?: ModelConfiguration };
  spans: BuildTraceSpan[];
  events: BuildTraceEvent[];
  outcome: BuildOutcome;
  evidence: { verificationReportHash?: Hash; proofBundleId?: ID; issues: TraceIssueSummary[] };
  replayability: { level: "none" | "semantic_reproduction" | "exact_replay"; reasons: string[]; randomSeeds: Record<string, number> };
  privacy: { rawSourceStored: false; rawPromptStored: false; creatorIdentityStored: false };
}
```

The schema is intentionally one current format. A future breaking change updates the schema version and replaces affected fixtures/results; readers will not accept a mixture of old and new shapes.

## 8. Rule and issue identity

Initial rule IDs should be explicit and stable:

```text
LUAU_PARSE_ERROR
LUAU_TYPE_ERROR
LUAU_LINT_WARNING
RUNTIME_CLIENT_SERVER_CONTEXT
REMOTE_UNVALIDATED_INPUT
REMOTE_CLIENT_CONTROLLED_REWARD
REMOTE_MISSING_HANDLER
REMOTE_INVALID_DIRECTION
PERSISTENCE_CLIENT_ACCESS
PERSISTENCE_PRODUCTION_STORE_IN_TEST
STRUCTURE_MISSING_INSTANCE
STRUCTURE_ORPHAN_SCRIPT
```

For M1, at minimum `LUAU_PARSE_ERROR`, `LUAU_TYPE_ERROR`, and `REMOTE_CLIENT_CONTROLLED_REWARD` must be exercised by `examples/insecure-tycoon`. The semantic rule must be derived from a project graph/data-flow representation, not a string search for a particular variable name.

## 9. Security and reproducibility boundaries

- Analyzer and verifier workers receive a project-scoped read-only view for verification.
- No model or verifier gets production credentials.
- M1 has no network dependency and no persistence side effects.
- Test projects never point at production DataStores.
- Paths are canonicalized and constrained to the requested project root.
- Raw tool output is retained as provenance, while normalized output is stable and project-relative.
- Dynamic execution is isolated and separately authorized when it exists.
- A proof certificate includes enough hashes and versions to reproduce the decision.
- Trace artifacts retain hashes/references and normalized evidence, not raw project source by default.
