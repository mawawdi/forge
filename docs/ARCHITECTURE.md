# Lemonade Forge Architecture

Status: M1, M1.5, M2, M2.5, M3, M3.25, and M3.5 complete
Scope: candidate proof-of-work; local verifier plus portable execution evidence

## M3.25 generation boundary

M3.25 adds a single model proposal boundary around—not inside—the verified M3
runtime. A strict `IntentDraft` becomes Forge-owned `GameIntent`, `CoreLoop`,
and `MechanicContract`. Forge then compiles a non-evictable
`MechanicImplementationSpec` containing the existing remote identity and path,
positional ABI, state bindings, exact constants, required validations,
authority invariants, and allowed source targets. A strict payload-only model
response still authors the substantive Luau implementation; Forge stamps its
bounded replacements into a typed PatchSet with current source/hash
preconditions. The model cannot define security requirements, assertions,
project identity, or evidence. Candidates pass official syntax, Roblox-aware
type analysis, and M2 in an atomic local directory before the unchanged M3
bridge/plugin/harness/ProofBundle boundary is entered.

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
│   ├── SPEC.md
│   ├── ARCHITECTURE.md
│   ├── ROADMAP.md
│   ├── EVALS.md
│   └── rfcs/
│       ├── flight-recorder.md
│       ├── project-semantic-map.md
│       ├── context-compiler.md
│       ├── verified-mechanic-capsules.md
│       └── studio-plugin-protocol.md
├── packages/
│   ├── contracts/              # JSON schemas and TypeScript types; no I/O
│   ├── intent/                 # intent -> CoreLoop resolution interfaces
│   ├── semantic-map/            # project tree, scripts, remotes, services, dependencies
│   ├── patch-model/             # bounded PatchSet operations, hashes, and atomic staging
│   ├── luau-toolchain/          # official syntax plus Roblox-host-aware type analysis
│   ├── generation/              # strict provider boundary and bounded model-authored candidates
│   ├── verifier/                # rule engine, issue normalization, deterministic ordering
│   ├── flight-recorder/         # BuildTrace, spans/events, sink interface, local JSON sink
│   ├── repair/                  # narrow deterministic repairs; no model dependency in M2
│   ├── context-compiler/        # bounded, provenance-bearing model-neutral context selection
│   ├── capsules/                # candidate/verified mechanic capability schema
│   ├── studio-protocol/         # versioned plugin/backend messages and validators
│   ├── studio-bridge/           # loopback HTTP polling transport and pairing
│   ├── studio-proof/            # StudioTestPlan, assertion results, ProofBundle integration
│   ├── preflight/               # pure Luau/Lute/Lune test adapter; never authoritative
│   ├── proofs/                  # ProofBundle assembly and serialization
│   ├── benchmarks/              # CoreLoopBench manifest and fixture loader
│   └── cli/                     # forge verify, repair, and trace inspection
├── examples/
│   ├── insecure-tycoon/         # M1 fixture: valid Luau plus intentional vulnerabilities
│   └── collect-fruit/            # M2 contract, vulnerable/repaired projects, and patch fixtures
│       └── studio/               # Rojo place tree; Forge injects its proof harness per run
├── benchmarks/
│   └── core-loop-bench/         # ten initial fixture directories and manifest
├── tools/
│   └── toolchain/               # pinned download/checksum/install documentation
├── test/
│   ├── contracts/
│   ├── verifier/
│   ├── cli/
│   └── fixtures/
└── README.md
```

M1 should remain a local CLI and library monorepo. A database, hosted API, auth system, queue, dashboard, and Studio worker fleet are not prerequisites.

## 3. Component boundaries

### Contracts

Pure, serializable schemas are the system boundary. They must validate at load and output. Contracts contain no model-specific fields that would make a provider the semantic authority.

### Intent compiler

Transforms a raw creator request into a candidate `CoreLoop`. It may use a model in a later milestone, but its output is always validated and may contain unresolved questions. It must not generate arbitrary source as its primary output.

### Agent runtime boundary

There is no autonomous `AgentRuntime` implementation in M2.5. The future runtime should depend on the stable interfaces around intent, context, patches, tool calls, verification, Studio sessions, and traces—not on a specific model or planner topology. Its capability profile is explicit: read a retained project view, write only an isolated workspace, call allowlisted tools, and spend bounded attempts. Provider-specific model telemetry remains an optional component behind the generic `BuildTrace` model/component fields.

### Project Semantic Map

Represents the relevant project structure: Instances, script execution context and hashes, modules, remotes, M2 replication relationships, persistent state, UI bindings, mechanic contracts, and dependency edges. M2.5 formalizes the existing script/remote graph inside a versioned map and derives a canonical projection that excludes absolute paths and raw source. The loaded source remains available only to the local analyzer. `ProjectSnapshot` carries layered source, structure, contract, aggregate semantic, and canonical-map hashes.

The map is adapter-owned. The current adapter is deterministic filesystem/fixture input; M3 adds a live Studio adapter. An optional rbx-dom adapter remains behind the same boundary for serialized Roblox place/model input. A missing world fact is unknown, not inferred as safe.

### Patch model

Represents a bounded proposed change as operations with provenance and expected effects. M2 applies exact text replacements only after matching project and before-content hashes. It stages a copied project and atomically publishes the destination after bounds checks; this is filesystem atomicity, not a Roblox Studio commit. The semantic map supplies the affected verification cone; it does not yet authorize skipping global verification.

### Luau toolchain adapter

The adapter has two explicit tiers. `luau-compile --only-parse` is the official
language syntax authority. `luau-lsp analyze --platform=roblox` is the
Roblox-host-aware type tier and receives pinned Roblox global/type definitions,
a deterministic Rojo sourcemap, and the project `.luaurc`. Forge records binary
or tool versions plus hashes for the definitions, sourcemap, and configuration.
Missing host tooling is an `incomplete` tooling result; it is never rewritten as
a source `LUAU_TYPE_ERROR`.

No JavaScript Lua parser, regex-only parser, or custom “compatible” parser may stand in for official Luau parsing. If either required tier is unavailable, Forge fails clearly with a tool-health issue; it does not silently downgrade. Details and pinned provenance are specified in `docs/rfcs/luau-toolchain.md`.

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

The `StudioRunController` turns a `MechanicContract` into a versioned `StudioTestPlan` and delegates execution to a replaceable adapter. M3 uses an explicit plugin-action Play Solo adapter. The backend first arms an exact run without starting Studio. When the creator selects **Run StudioProof**, the edit-mode root Script plugin confirms a fresh live revision, injects a temporary default-context server harness in `Workspace` and a client driver in `StarterPlayerScripts`, then calls `ExecutePlayModeAsync`. The sole server harness returns one structured JSON string directly through `EndTest(JSON)`; the plugin validates its complete binding and nonce before forwarding `StudioTestResult`. Protocol v10 transports a complete `ProjectObservation`; only the backend semantic adapter creates a canonical `ProjectSnapshot`. It also uses deterministic timestamp-free SHA-256 live revisions, persistent `_forgeStableId` mutation handles excluded from semantic hashes, capability-checked pairing, and a per-run nonce commitment. The raw nonce remains in ephemeral plugin memory while armed, is never sent to the backend or stored in the place, and is embedded only in the temporary server harness when the run starts. The Forge Studio Plugin is the only Forge component allowed to forward authoritative claims about engine behavior. MCP is optional development/debugging infrastructure, not the Forge product boundary.

### M3.5 combined regression proof

Protocol v10 hard-cuts the Studio harness boundary to an exact registry. The
immutable historical `collect-fruit@collect-fruit-v7` harness remains available
only for the original seven-assertion proof. The new
`collect-sell@collect-sell-v4` harness is a separately hashed implementation,
not an arbitrary assertion interpreter. It returns one server-owned EndTest
envelope containing seven CollectFruit regression assertions, six SellInventory
assertions, and one Collect→Sell composition assertion. A schema-v3
`StudioTestPlan` explicitly names the prior CollectFruit contract, ProofBundle,
and source hashes; every assertion declares either the primary contract or a
listed regression contract.

`InteractionBinding` is a narrow project-interface object, not an arbitrary
interaction DSL. It currently represents the CollectFruit pointer click and
SellInventory ProximityPrompt shapes. It separates production initiation from
server authorization. Semantic-map instances include prompt properties and
BasePart positions, and the Context Compiler emits the selected mechanic's
resolved binding as required P1 context. When explicit action is required, the
verifier requires the declared input event to invoke one bounded model-authored
client action module, and verifies that the module owns the production
RemoteEvent request. It rejects periodic initiation only for explicit-action
contracts. It does not globally ban Heartbeat or other frame events.

StudioProof preserves the same split. Roblox does not grant an injected Play
Solo LocalScript the `LocalUser` capability needed for synthetic mouse input.
The production LocalScript and temporary client driver therefore call the same
model-authored action-module function. Static verification proves the real
Button1Down/Triggered wiring; Studio executes the exact production request
function. Direct RemoteEvent calls remain adversarial-only.
Adversarial assertions may call the real RemoteEvent directly to attack the
server boundary. Before any action, the server harness confirms a live Humanoid,
HumanoidRootPart, initialized attributes, and all declared world objects.

### Proof assembler

Combines all tier results into an immutable `ProofBundle` identified by source/dependency/rule/tool hashes. “Not run” and “unknown” remain visible. It does not infer a pass from a green static result.

### Context Compiler

Compiles one bounded mechanic task into ordered `ContextItem` values. P0 contains
the contract, non-evictable `MechanicImplementationSpec`, requested change,
generation policy, and current failures. P1 contains complete source for the
allowed affected scripts plus the exact M2 remote neighborhood. Repair context
also contains the candidate PatchSet and normalized ranged diagnostics. P2
contains canonical project metadata. Each item carries a reason, source,
entity, content hash, token estimate, and required/evictable flags. Correctness
takes priority over minimizing token count; required P0/P1 items are not
evicted. Retrieval and learned ranking remain future work.

### Verified Mechanic Capsules

Defines a reusable parameterized capability linked to a contract, invariants, adaptation rules, executable assertions, and provenance. M2.5 permits candidate schemas only. A capsule cannot claim `verified` without ProofBundle IDs, Studio runtime versions, assertions, and timestamped provenance. Adaptation always creates a new candidate and re-runs verification.

### Flight Recorder

Records one build execution without becoming the verification authority. A `BuildTrace` has a content-derived `buildKey`, a unique `traceId`, project snapshot hashes/references, component versions, timing spans, discrete events, objective outcome dimensions, and compact issue summaries. It stores no raw source or creator-identifying data by default.

The recorder owns a generic sink interface. M1.5 provides an atomic local JSON/debug sink; future OpenTelemetry collectors, optional Langfuse export, and production backends are adapters. They are never required for Forge to verify a project.

M2.5 may attach context composition counts and a composition hash to the trace. It does not store the selected context body in telemetry.

`BuildTrace` is execution history. `ProofBundle` is decision evidence. A CoreLoopBench case is a reproducible fixture promoted from a reviewed failure. `ExperimentResult` later compares a fixed case/dataset across candidate configurations. These objects link by IDs and content hashes rather than embed redundant source trees.

### CLI

Current command surface:

```text
forge verify <project-path> [--format json]
forge repair <project-path> --contract <path> --out <directory> [--trace-dir <path>]
forge trace show <trace-id> [--trace-dir <path>]
forge candidate reverify <regression-path> [--studio] [--timeout-ms <ms>]
forge candidate repair <regression-path> [--model <model>] [--run-dir <path>]
forge candidate studio <candidate-artifact> [--fault client-controlled-reward|client-controlled-payout] [--timeout-ms <ms>]
forge studio bridge
forge studio verify <project-path> [--timeout-ms <ms>]
```

Candidate repair and runtime execution are deliberately separate. `candidate
repair` performs one model call, materializes a bounded project, verifies it,
and seals its paths, source hashes, contract, implementation spec, PatchSet,
and report in a content-hashed private artifact. `candidate studio` performs no
model call: it validates that artifact against the current seed/output bytes,
reruns local verification, and only then delegates the exact PatchSet to the
existing StudioProof transaction. The Studio place must be built from the
artifact's original `seedRoot`, not its already-patched `outputRoot`: the
plugin validates the PatchSet's exact before-state before applying it.

The CLI discovers the fixture, validates its manifest, invokes the official toolchain, runs deterministic Forge rules, emits one structured result, and sets exit status. `repair` composes the same verifier around one bounded deterministic repair and emits the resulting ProofBundle. Future commands (`intent`, `compile`, `commit`, `bench`) remain deferred.

## 4. M1 verification data flow

```text
project path
  -> canonical path + fixture manifest
  -> source inventory
  -> luau-compile syntax tier
  -> luau-lsp Roblox platform tier + pinned definitions/sourcemap
  -> normalized ranged Luau issues
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

## 6. Capability and trust boundaries

The eventual autonomous worker is modeled by a capability profile, not by an instruction to the model:

```text
WorkerCapabilityProfile
├── filesystem: read project snapshot; write isolated temporary workspace
├── network: explicit allowlist; deny by default where practical
├── credentials: no production DataStore; test credentials scoped
├── execution: timeout, CPU/memory, token, and attempt budgets
└── Studio: test place/universe only; never production persistence
```

M2.5 documents this boundary but does not build sandbox infrastructure. Static analysis proves static properties, semantic analysis proves modeled graph properties, pure Luau proves pure-code behavior, and only real Studio proves Roblox engine behavior.

## 7. M3 Studio Plugin + StudioProof integration

```text
ProjectSemanticMap (static adapter)
          + live Studio DataModel adapter
          -> mapped Studio session
          -> StudioAssertion actions and observations
          -> authoritative StudioProof
          -> ProofBundle linked to MechanicContract, Snapshot, and BuildTrace
```

The Forge Plugin is the product transport and execution boundary. Roblox Studio's built-in MCP server remains development/debugging infrastructure: it exposes generic data-model exploration, script reads/edits, Luau execution, play state, console output, and input simulation through a local stdio process. Forge will not make MCP a product dependency or clone the archived `studio-rust-mcp-server`.

The current candidate M3 adapter has `ExecuteAssertionPlan` store one ephemeral armed run and publish
its nonce commitment. It does not launch Studio. The creator's explicit plugin
action takes a fresh pre-play observation, rejects a stale revision, injects
temporary scripts into the edit DataModel, and owns one yielding
`ExecutePlayModeAsync` request on a dedicated task. Normal Play Solo supplies
one real client and server simulation in the same Studio window. The server
creates a play-only relay, drives real client requests through
`Remotes.CollectFruit`, reads server-owned state and actual player/fruit
positions, and is the only code allowed to call `EndTest`, once, with the JSON
envelope as its direct value. There is no F5 handoff, multiplayer
worker process, `GetTestArgs` dependency, test-mode plugin runtime, persisted
armed record, LogService relay, or Output proof message.

The temporary dependency-free API canary recorded in
`docs/research/studio-test-service-blocker.md` proved both Run and Play server
roundtrips on the target Studio build. It also exposed
that Forge had supplied an undocumented `timeoutSeconds` test-argument key and
expected Lemonade's wrapped `{ returnValue }` shape. The accepted adapter uses
an outer plugin deadline, passes only a neutral non-secret run hint as the test
argument, and uses Roblox's documented direct `EndTest(result)` contract. The
next isolated gate is a real LocalScript-to-server RemoteEvent roundtrip before
the seven-assertion CollectFruit harness is retried. Output and Studio's
internal runner fields remain non-authoritative.

The canary is a characterization scaffold, not a StudioProof producer and not
an evaluation fixture. It cannot create a ProofBundle. Production execution is
dispatched through an explicit mechanic-runner boundary. The CollectFruit
runner declares the exact assertion ID set it supports and rejects unknown,
missing, or duplicate plan/result IDs. A future second mechanic adds another
runner behind that boundary; Forge will generalize shared behavior from two
real runners instead of inventing an arbitrary authoritative test DSL from one.

An interrupted or timed-out `ExecutePlayModeAsync` cannot be forcibly cancelled
by the edit plugin. Forge cleans temporary edit objects, marks the run incomplete,
and requires the creator to press Stop and reload before another proof. It never
assumes the underlying play session ended.

M3 must merge live hierarchy facts with the static map, reject stable-identity/class/path/source mismatches, run all seven `CollectFruit` assertions (valid collect, exact inventory delta, consumed state, duplicate, spoofed ID, impossible distance, and reward spoof), and mark every unavailable tier explicitly. No pure runtime, mock, Output line, or MCP-only run can substitute for Studio authority. Screenshot capture, richer captures, cross-place stable identity, and remote relay infrastructure remain future work.

## 8. Official tooling references

The initial toolchain decision is based on the official Luau implementation and its maintained tooling:

- [Luau](https://github.com/luau-lang/luau) provides the language implementation and the `luau-compile --only-parse` syntax tier.
- [Luau Language Server](https://github.com/JohnnyMorganz/luau-lsp) provides Roblox-platform analysis using pinned engine declarations and a Rojo sourcemap.
- [Lute lint](https://lute.luau.org/cli/lint/index.html) remains a possible programmable preflight rule host; it is not the current Roblox type authority.

These references are implementation inputs, not a commitment to embed native C++ libraries in M1 or M2. A subprocess adapter is the smallest inspectable boundary; embedding or a long-running sidecar can be evaluated after correctness is established.

## 9. TypeScript contracts

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

export interface TrajectoryEvent {
  kind: "TrajectoryEvent";
  schemaVersion: 1;
  id: ID;
  sequence: number;
  occurredAt: ISO8601;
  event: "intent_received" | "core_loop_resolved" | "contract_compiled" | "patch_proposed" | "verification_completed" | "repair_applied" | "studio_run_completed" | "creator_accepted" | "creator_rejected";
  actor: "creator" | "forge" | "model" | "tool" | "studio" | "system";
  projectId: ID;
  references: Partial<BuildTrace["references"]>;
  payloadHash: Hash;
  attributes: Record<string, TraceAttributeValue>;
  privacyClass: "none" | "project" | "creator_sensitive";
}
```

The schema is intentionally one current format. A future breaking change updates the schema version and replaces affected fixtures/results; readers will not accept a mixture of old and new shapes.

## 10. Rule and issue identity

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

## 11. Security and reproducibility boundaries

- Analyzer and verifier workers receive a project-scoped read-only view for verification.
- No model or verifier gets production credentials.
- M1 has no network dependency and no persistence side effects.
- Test projects never point at production DataStores.
- Paths are canonicalized and constrained to the requested project root.
- Raw tool output is retained as provenance, while normalized output is stable and project-relative.
- Dynamic execution is isolated and separately authorized when it exists.
- A proof certificate includes enough hashes and versions to reproduce the decision.
- Trace artifacts retain hashes/references and normalized evidence, not raw project source by default.
