import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FORGE_NATIVE_RUNTIME_IDENTITY,
  ForgeNativeAgentRuntime,
  INITIAL_EXPERIMENT_BUDGETS,
  assertAgentRun,
  persistCreatorPhaseAgentRun,
  type AgentRun,
  type AgentRuntime,
  type AgentRuntimeInput,
  type AgentRuntimeResult,
} from "../packages/agent-runtime/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  CREATOR_PLANNER_SYSTEM_PROMPT,
  CreatorBuilderToolHost,
  advanceSession,
  assertCreatorControlActionBinding,
  assertCreatorPlan,
  assertCreatorReviewReport,
  assertCreatorSessionBundle,
  createCreatorApproval,
  createCreatorChangeSet,
  createCreatorControlView,
  createCreatorPlan,
  createCreatorReviewReport,
  createCreatorSession,
  createStudioOwnershipMap,
  creatorOrientation,
  loadCreatorBundle,
  persistCreatorBundle,
  persistCreatorPrompt,
  runCreatorBuilder,
  runCreatorPlanner,
  type CreatorSession,
  type StudioOwnershipMap,
} from "../packages/creator-session/src/index.js";
import {
  LocalCreatorAgentWorker,
  type CreatorAgentWorker,
} from "../packages/creator-session/src/worker.js";
import {
  CreatorSessionCoordinator,
  createChangeReviewPresentation,
  reconcileAppliedChangeSet,
} from "../packages/creator-session/src/coordinator.js";
import type {
  ModelClient,
  ModelTurnRequest,
  ModelTurnResult,
} from "../packages/model-client/src/contracts.js";
import type { StudioSnapshotObservation } from "../packages/semantic-map/src/index.js";
import type { StudioBridgeConnection } from "../packages/studio-bridge/src/index.js";

const REVISION = contentHash("creator-revision");
const PROMPT =
  "Add a status beacon above Generator and preserve PreservedTree.";
const OBSERVATION: StudioSnapshotObservation = {
  kind: "StudioSnapshotObservation",
  project: { name: "StatusBeacon", placeId: 0, universeId: 0 },
  capturedAt: "2026-08-31T00:00:00.000Z",
  instances: [
    {
      stableId: "forge_service_root_Workspace",
      path: "Workspace",
      className: "Workspace",
      properties: [],
      attributes: [],
      tags: [],
    },
    {
      stableId: "forge_service_root_ServerScriptService",
      path: "ServerScriptService",
      className: "ServerScriptService",
      properties: [],
      attributes: [],
      tags: [],
    },
    {
      stableId: "instance_generator",
      path: "Workspace/Generator",
      className: "Part",
      position: { x: 0, y: 4, z: 0 },
      properties: [{ name: "Anchored", value: true }],
      attributes: [],
      tags: [],
    },
    {
      stableId: "instance_tree",
      path: "Workspace/PreservedTree",
      className: "Model",
      properties: [],
      attributes: [],
      tags: [],
    },
    {
      stableId: "instance_crown",
      path: "Workspace/PreservedTree/Crown",
      className: "Part",
      position: { x: 0, y: 8, z: 0 },
      properties: [],
      attributes: [],
      tags: [],
    },
    {
      stableId: "instance_trunk",
      path: "Workspace/PreservedTree/Trunk",
      className: "Part",
      position: { x: 0, y: 3, z: 0 },
      properties: [],
      attributes: [],
      tags: [],
    },
  ],
  scripts: [],
  remotes: [],
};

class CreatorRuntime implements AgentRuntime {
  readonly identity = FORGE_NATIVE_RUNTIME_IDENTITY;
  readonly modelClientDescriptor = {
    transport: "fake-creator",
    configuration: {
      aiSdk: { package: "fake" },
      providerAdapter: { package: "fake" },
      routing: {
        only: ["fake"],
        allowFallbacks: false as const,
        requireParameters: true as const,
      },
      reasoning: { effort: "medium" as const, exclude: false as const },
      request: {
        steps: 1 as const,
        toolChoice: "auto" as const,
        providerParallelToolCalls: "not_requested" as const,
        toolBatchExecution: "atomic_validate_then_sequential" as const,
        toolNameEncoding: "openai_function_slug" as const,
        maxRetries: 0 as const,
        telemetry: false as const,
        timeoutPolicy: "remaining_runtime_budget" as const,
        maxOutputTokensPerTurn: 4096,
      },
      continuation: { maxBytes: 262144 },
    },
  };
  constructor(
    private readonly handler: (input: AgentRuntimeInput) => Promise<void>,
  ) {}
  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    await this.handler(input);
    return {
      status: "completed",
      trialStarted: true,
      usage: { turns: 1, inputTokens: 10, outputTokens: 10, costUsd: 0 },
      timing: { startedAt: "2026-08-31T00:00:00.000Z", endedAt: "2026-08-31T00:00:00.000Z", durationMs: 0 },
      turns: [],
      toolCalls: [],
    };
  }
}

test("prompt-only planner and builder expose Studio facts, respect ownership, and persist phase evidence", async () => {
  const ownership = createStudioOwnershipMap({
    projectId: "studio_project_status",
    revisionHash: REVISION,
    observation: OBSERVATION,
    externalRojoPaths: ["Workspace/PreservedTree"],
  });
  assert.equal(
    ownership.entries.find((entry) => entry.path === "Workspace")?.writable,
    true,
  );
  assert.equal(
    ownership.entries.find((entry) => entry.stableId === "instance_tree")
      ?.writable,
    false,
  );
  const session = createCreatorSession({
    prompt: PROMPT,
    projectId: ownership.projectId,
    revisionHash: REVISION,
    ownership,
    now: new Date("2026-08-31T00:00:00.000Z"),
  });
  const plannerRuntime = new CreatorRuntime(async (input) => {
    const visible = stableJson(input.orientation);
    assert.deepEqual(
      input.tools.definitions().map((tool) => tool.name),
      ["studio.inspect", "creator.propose_plan"],
    );
    assert.match(visible, /Workspace\/Generator|Workspace\/PreservedTree/);
    assert.match(
      visible,
      /inline_source_required|initial_snapshot_scripts_only|allowlisted_studio_roots/,
    );
    assert.doesNotMatch(
      visible,
      /\/Users\/|evaluator|acceptanceSpec|benchmark_oracle/,
    );
    const planSchema = input.tools
      .definitions()
      .find((tool) => tool.name === "creator.propose_plan")!.schema as {
      properties?: Record<string, unknown>;
    };
    assert.equal(
      "goal" in (planSchema.properties ?? {}),
      false,
      "the model cannot author a substitute goal",
    );
    const uninspected = await input.tools.execute("creator.propose_plan", {
      inspectionPaths: ["Workspace/Generator"],
      steps: [
        {
          id: "create",
          statement: "Create an output",
          changeIds: ["create_output"],
        },
      ],
      changes: [
        {
          id: "create_output",
          kind: "create",
          path: "Workspace/InspectedOutput",
          className: "Part",
          initialization: "initial_properties",
        },
      ],
      clauses: [
        {
          id: "output_exists",
          kind: "studio_check",
          check: "instance_exists",
          path: "Workspace/InspectedOutput",
          expectedClass: "Part",
        },
        {
          id: "diagnostics",
          kind: "studio_check",
          check: "playtest_diagnostics",
          maximumErrors: 0,
          maximumWarnings: 5,
        },
      ],
    });
    assert.equal(uninspected.error?.code, "PLAN_INSPECTION_NOT_OBSERVED");
    const inspected = await input.tools.execute("studio.inspect", {
      paths: ["Workspace/Generator", "Workspace/PreservedTree"],
    });
    assert.equal(inspected.ok, true);
    assert.doesNotMatch(
      stableJson(inspected.value),
      /local source|return true/,
    );
    const invalid = await input.tools.execute("creator.propose_plan", {
      inspectionPaths: ["Workspace/Generator"],
      steps: [
        {
          id: "beacon",
          statement: "Create the beacon",
          changeIds: ["create_beacon"],
        },
        {
          id: "script",
          statement: "Create the controller",
          changeIds: ["create_script"],
        },
        {
          id: "deferred_source",
          statement: "Write controller source",
          changeIds: ["write_script"],
        },
      ],
      changes: [
        {
          id: "create_beacon",
          kind: "create",
          path: "Workspace/Generator/StatusBeacon",
          className: "Part",
          initialization: "initial_properties",
        },
        {
          id: "create_script",
          kind: "create",
          path: "ServerScriptService/StatusBeaconController",
          className: "Script",
          initialization: "inline_source_required",
        },
        {
          id: "write_script",
          kind: "write_source",
          path: "ServerScriptService/StatusBeaconController",
          expectedClass: "Script",
        },
      ],
      clauses: [
        {
          id: "beacon_exists",
          kind: "studio_check",
          check: "instance_exists",
          path: "Workspace/Generator/StatusBeacon",
          expectedClass: "Part",
        },
        {
          id: "script_exists",
          kind: "studio_check",
          check: "instance_exists",
          path: "ServerScriptService/StatusBeaconController",
          expectedClass: "Script",
        },
        { id: "syntax", kind: "local_check", check: "luau_syntax" },
        {
          id: "diagnostics",
          kind: "studio_check",
          check: "playtest_diagnostics",
          maximumErrors: 0,
          maximumWarnings: 5,
        },
      ],
    });
    assert.equal(
      invalid.ok,
      false,
      "a newly planned script cannot defer its source to a separate operation",
    );
    assert.equal(invalid.error?.code, "PLAN_INVALID");
    assert.match(
      invalid.error?.message ?? "",
      /New scripts must be authored by their corresponding create operation/,
    );
    const incompleteSteps = await input.tools.execute("creator.propose_plan", {
      inspectionPaths: ["Workspace/Generator"],
      steps: [
        {
          id: "beacon",
          statement: "Create only the beacon",
          changeIds: ["create_beacon"],
        },
      ],
      changes: [
        {
          id: "create_beacon",
          kind: "create",
          path: "Workspace/Generator/OtherBeacon",
          className: "Part",
          initialization: "initial_properties",
        },
        {
          id: "create_script",
          kind: "create",
          path: "ServerScriptService/OtherController",
          className: "Script",
          initialization: "inline_source_required",
        },
      ],
      clauses: [
        {
          id: "beacon_exists",
          kind: "studio_check",
          check: "instance_exists",
          path: "Workspace/Generator/OtherBeacon",
          expectedClass: "Part",
        },
        {
          id: "script_exists",
          kind: "studio_check",
          check: "instance_exists",
          path: "ServerScriptService/OtherController",
          expectedClass: "Script",
        },
        { id: "syntax", kind: "local_check", check: "luau_syntax" },
        {
          id: "diagnostics",
          kind: "studio_check",
          check: "playtest_diagnostics",
          maximumErrors: 0,
          maximumWarnings: 5,
        },
      ],
    });
    assert.equal(incompleteSteps.ok, false);
    assert.match(
      incompleteSteps.error?.message ?? "",
      /steps must bind every change exactly once/,
    );
    const missingSyntax = await input.tools.execute("creator.propose_plan", {
      inspectionPaths: ["Workspace/Generator"],
      steps: [
        {
          id: "script",
          statement: "Create the controller",
          changeIds: ["create_script"],
        },
      ],
      changes: [
        {
          id: "create_script",
          kind: "create",
          path: "ServerScriptService/OtherController",
          className: "Script",
          initialization: "inline_source_required",
        },
      ],
      clauses: [
        {
          id: "script_exists",
          kind: "studio_check",
          check: "instance_exists",
          path: "ServerScriptService/OtherController",
          expectedClass: "Script",
        },
        {
          id: "diagnostics",
          kind: "studio_check",
          check: "playtest_diagnostics",
          maximumErrors: 0,
          maximumWarnings: 5,
        },
      ],
    });
    assert.equal(missingSyntax.ok, false);
    assert.match(missingSyntax.error?.message ?? "", /requires luau_syntax/);
    const result = await input.tools.execute("creator.propose_plan", {
      inspectionPaths: ["Workspace/Generator", "Workspace/PreservedTree"],
      steps: [
        {
          id: "beacon",
          statement:
            "Create sibling beacon and runtime script without changing PreservedTree",
          changeIds: ["create_beacon", "create_script"],
        },
      ],
      changes: [
        {
          id: "create_beacon",
          kind: "create",
          path: "Workspace/Generator/StatusBeacon",
          className: "Part",
          initialization: "initial_properties",
        },
        {
          id: "create_script",
          kind: "create",
          path: "ServerScriptService/StatusBeaconController",
          className: "Script",
          initialization: "inline_source_required",
        },
      ],
      clauses: [
        {
          id: "generator_exists",
          kind: "studio_check",
          check: "instance_exists",
          path: "Workspace/Generator",
          expectedClass: "BasePart",
        },
        {
          id: "tree_exists",
          kind: "studio_check",
          check: "instance_exists",
          path: "Workspace/PreservedTree",
          expectedClass: "Model",
        },
        {
          id: "beacon_exists",
          kind: "studio_check",
          check: "instance_exists",
          path: "Workspace/Generator/StatusBeacon",
          expectedClass: "Part",
        },
        {
          id: "script_exists",
          kind: "studio_check",
          check: "instance_exists",
          path: "ServerScriptService/StatusBeaconController",
          expectedClass: "Script",
        },
        { id: "syntax", kind: "local_check", check: "luau_syntax" },
        {
          id: "preserved",
          kind: "snapshot_check",
          check: "subtree_unchanged",
          path: "Workspace/PreservedTree",
          expectedClass: "Model",
        },
        {
          id: "diagnostics",
          kind: "studio_check",
          check: "playtest_diagnostics",
          maximumErrors: 0,
          maximumWarnings: 5,
        },
        {
          id: "review",
          kind: "creator_review",
          statement:
            "Confirm the beacon alternates green and red about once per second and the tree looks unchanged.",
        },
      ],
    });
    assert.equal(result.ok, true);
  });
  const planned = await runCreatorPlanner({
    session,
    ownership,
    observation: OBSERVATION,
    prompt: PROMPT,
    runtime: plannerRuntime,
  });
  assert.ok(planned.plan, JSON.stringify(planned.finalization));
  const plan = planned.plan;
  assert.equal(plan.charter.visibility, "creator_visible");
  assert.equal(plan.changes.length, 2);
  assert.equal(plan.goal, PROMPT);
  assert.equal("assumptions" in plan, false);
  const {
    id: _planId,
    hash: _planHash,
    ...tamperedPayload
  } = { ...plan, goal: "Create only empty structure." };
  const tamperedHash = contentHash(stableJson(tamperedPayload));
  assert.throws(
    () =>
      assertCreatorPlan({
        ...tamperedPayload,
        id: `creator_plan_${tamperedHash.slice(0, 24)}`,
        hash: tamperedHash,
      }),
    /Invalid CreatorPlan/,
    "a self-consistent plan identity cannot substitute a different creator goal",
  );
  assert.equal(
    plan.charter.clauses.find((clause) => clause.id === "tree_exists")
      ?.statement,
    "Workspace/PreservedTree resolves as Model during the approved playtest.",
  );
  assert.equal(
    plan.charter.clauses
      .find((clause) => clause.id === "diagnostics")
      ?.statement.includes("attributable"),
    false,
  );
  const approval = createCreatorApproval({
    sessionId: session.id,
    artifactKind: "plan",
    artifactId: plan.id,
    artifactHash: plan.hash,
    decision: "approved",
    decidedAt: "2026-08-31T00:01:00.000Z",
  });
  const builderRuntime = new CreatorRuntime(async (input) => {
    assert.deepEqual(
      input.tools.definitions().map((tool) => tool.name),
      [
        "studio.inspect",
        "studio.read_source",
        "studio.stage",
        "studio.diff",
        "forge.verify",
      ],
    );
    assert.doesNotMatch(input.systemPrompt, /plan\.update/);
    assert.match(input.systemPrompt, /CreatorBuildContract \(verbatim\)/);
    assert.match(
      input.systemPrompt,
      /Approved CreatorPlan semantics \(verbatim\)/,
    );
    assert.match(input.systemPrompt, /Workspace\/Generator\/StatusBeacon/);
    const inspected = await input.tools.execute("studio.inspect", {
      paths: ["Workspace/Generator", "ServerScriptService"],
    });
    assert.equal(inspected.ok, true);
    assert.equal(
      (
        inspected.value as {
          instances: Array<{ stableId: string; instanceHash: string }>;
        }
      ).instances.find((entry) => entry.stableId === "instance_generator")
        ?.instanceHash,
      contentHash(
        stableJson(
          OBSERVATION.instances.find(
            (entry) => entry.stableId === "instance_generator",
          ),
        ),
      ),
    );
    assert.equal(
      (
        await input.tools.execute("studio.inspect", {
          paths: ["Workspace/PreservedTree"],
        })
      ).ok,
      true,
      "semantic and preservation references have targeted initial facts",
    );
    const unknown = await input.tools.execute("studio.stage", {
      change: { planChangeId: "not_approved" },
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error?.code, "PLAN_CHANGE_UNKNOWN");
    const position = await input.tools.execute("studio.stage", {
      change: {
        planChangeId: "create_beacon",
        properties: { Position: { x: 0, y: 8, z: 0 } },
      },
    });
    assert.equal(position.ok, false);
    assert.equal(position.error?.code, "PROPERTY_NOT_ALLOWED");
    assert.match(position.error?.message ?? "", /CFrame/);
    const nullAttribute = await input.tools.execute("studio.stage", {
      change: { planChangeId: "create_beacon", attributes: { invalid: null } },
    });
    assert.equal(nullAttribute.ok, false);
    const wrongPayload = await input.tools.execute("studio.stage", {
      change: {
        planChangeId: "create_script",
        properties: { Anchored: true },
      },
    });
    assert.equal(wrongPayload.ok, false);
    const sourceLess = await input.tools.execute("studio.stage", {
      change: { planChangeId: "create_script" },
    });
    assert.equal(
      sourceLess.ok,
      false,
      "planned script creation cannot defer source authoring",
    );
    assert.equal(sourceLess.error?.code, "SOURCE_REQUIRED");
    assert.equal(
      (
        await input.tools.execute("studio.stage", {
          change: {
            planChangeId: "create_beacon",
            properties: {
              Anchored: true,
              CanCollide: false,
              CanTouch: false,
              Color: { r: 0.1, g: 1, b: 0.2 },
              Material: "Neon",
              Size: { x: 2, y: 1, z: 2 },
              Transparency: 0,
              CFrame: {
                position: { x: 0, y: 7.5, z: 0 },
                rotation: { x: 0, y: 0, z: 0 },
              },
            },
            attributes: { ForgePurpose: "status-beacon" },
          },
        })
      ).ok,
      true,
    );
    const duplicate = await input.tools.execute("studio.stage", {
      change: { planChangeId: "create_beacon" },
    });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error?.code, "PLAN_CHANGE_DUPLICATE");
    const incompleteGate = await input.tools.execute("forge.verify", {});
    assert.equal(
      (incompleteGate.value as { status: string }).status,
      "rejected",
    );
    assert.equal(
      (
        await input.tools.execute("studio.stage", {
          change: {
            planChangeId: "create_script",
            source:
              'local beacon = workspace.Generator:WaitForChild("StatusBeacon")\nwhile true do\n\tbeacon.Color = Color3.new(0, 1, 0)\n\ttask.wait(1)\n\tbeacon.Color = Color3.new(1, 0, 0)\n\ttask.wait(1)\nend',
          },
        })
      ).ok,
      true,
    );
    assert.equal((await input.tools.execute("forge.verify", {})).ok, true);
  });
  const built = await runCreatorBuilder({
    session,
    ownership,
    observation: OBSERVATION,
    prompt: PROMPT,
    plan,
    planApproval: approval,
    runtime: builderRuntime,
  });
  assert.ok(built.changeSet);
  assert.equal(built.changeSet.operations.length, 2);
  assert.equal(built.changeSet.localGate.status, "eligible");
  const beaconOperation = built.changeSet.operations.find(
    (operation) => operation.planChangeId === "create_beacon",
  );
  assert.equal(
    beaconOperation?.kind === "create" &&
      beaconOperation.properties.Color?.type,
    "color3",
  );
  assert.deepEqual(
    beaconOperation?.kind === "create" && beaconOperation.properties.Color,
    {
      type: "color3",
      r: 0.10196078568696976,
      g: 1,
      b: 0.20000000298023224,
    },
    "creator colors must be canonicalized to the exact Studio storage domain before review",
  );
  assert.deepEqual(
    beaconOperation?.kind === "create" && beaconOperation.properties.CFrame,
    {
      type: "cframe",
      components: [0, 7.5, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    },
  );
  assert.ok(beaconOperation?.kind === "create");
  const scriptOperation = built.changeSet.operations.find(
    (operation) => operation.planChangeId === "create_script",
  );
  assert.ok(scriptOperation?.kind === "create" && scriptOperation.source);
  const observedProperties = Object.entries(beaconOperation.properties).map(
    ([name, value]) => ({
      name,
      value:
        value.type === "boolean" ||
        value.type === "number" ||
        value.type === "string"
          ? value.value
          : value.type === "vector3"
            ? `${value.x},${value.y},${value.z}`
            : value.type === "color3"
              ? `${value.r},${value.g},${value.b}`
              : value.components.join(","),
    }),
  );
  const appliedObservation: StudioSnapshotObservation = {
    ...structuredClone(OBSERVATION),
    instances: [
      ...structuredClone(OBSERVATION.instances),
      {
        stableId: "studio_beacon",
        path: `${beaconOperation.parentPath}/${beaconOperation.name}`,
        className: beaconOperation.className,
        properties: observedProperties,
        attributes: Object.entries(beaconOperation.attributes).map(
          ([name, value]) => ({ name, value }),
        ),
        tags: [],
      },
      {
        stableId: "studio_controller",
        path: `${scriptOperation.parentPath}/${scriptOperation.name}`,
        className: scriptOperation.className,
        properties: [],
        attributes: [],
        tags: [],
      },
    ],
    scripts: [
      {
        stableId: "studio_controller",
        path: `${scriptOperation.parentPath}/${scriptOperation.name}`,
        executionContext: "server",
        source: scriptOperation.source,
        sourceHash: contentHash(scriptOperation.source),
      },
    ],
  };
  assert.equal(
    reconcileAppliedChangeSet(built.changeSet, appliedObservation),
    undefined,
    "the exact canonical color Studio stores must reconcile",
  );
  const wrongColorObservation = structuredClone(appliedObservation);
  const observedBeacon = wrongColorObservation.instances.find(
    (instance) => instance.stableId === "studio_beacon",
  )!;
  observedBeacon.properties.find(
    (property) => property.name === "Color",
  )!.value = "0.2,1,0.2";
  assert.match(
    reconcileAppliedChangeSet(built.changeSet, wrongColorObservation) ?? "",
    /mismatched Color/,
    "canonicalization must not weaken reconciliation for a materially different color",
  );
  await assert.rejects(
    () =>
      runCreatorBuilder({
        session,
        ownership,
        observation: OBSERVATION,
        prompt: PROMPT,
        plan,
        planApproval: { ...approval, decision: "rejected" },
        runtime: builderRuntime,
      }),
    /exact approved plan/,
  );
  await assert.rejects(
    () =>
      runCreatorBuilder({
        session,
        ownership,
        observation: OBSERVATION,
        prompt: `${PROMPT} altered`,
        plan,
        planApproval: approval,
        runtime: builderRuntime,
      }),
    /prompt does not match/,
  );

  const directory = await mkdtemp(join(tmpdir(), "forge-creator-evidence-"));
  try {
    const executionWorker = {
      kind: "CreatorAgentWorkerDescriptor" as const,
      name: "forge-local-creator-agent-worker" as const,
      environment: "local_process" as const,
      isolation: "none" as const,
    };
    const phase = await persistCreatorPhaseAgentRun({
      phase: "creator_builder",
      creatorSession: { id: session.id, hash: session.hash },
      promptHash: session.promptHash,
      projectId: session.projectId,
      revisionHash: session.currentRevisionHash,
      orientation: creatorOrientation({
        session,
        ownership,
        observation: OBSERVATION,
      }),
      systemPrompt: built.systemPrompt,
      finalization: built.finalization,
      runtime: builderRuntime,
      runtimeResult: {
        status: "completed",
        trialStarted: true,
        usage: { turns: 1, inputTokens: 10, outputTokens: 10, costUsd: 0 },
        timing: { startedAt: "2026-08-31T00:00:00.000Z", endedAt: "2026-08-31T00:00:00.000Z", durationMs: 0 },
        turns: [],
        toolCalls: [],
      },
      toolHost: built.toolHost,
      budgets: INITIAL_EXPERIMENT_BUDGETS,
      directory,
      traceDirectory: join(directory, "traces"),
      executionWorker,
      creatorBuildContract: {
        id: built.toolHost.contract.id,
        hash: built.toolHost.contract.hash,
      },
    });
    assertAgentRun(phase.run);
    const { creatorPhaseOutcome: _outcome, ...withoutOutcome } = phase.run;
    assert.throws(
      () =>
        assertAgentRun({
          ...withoutOutcome,
          creatorArtifact: {
            kind: "change_set",
            id: built.changeSet!.id,
            hash: built.changeSet!.hash,
          },
        }),
      /phase outcome/,
    );
    assert.equal(phase.run.phase, "creator_builder");
    assert.equal(phase.run.origin.kind, "creator_session");
    assert.deepEqual(phase.run.executionWorker, executionWorker);
    assert.equal(phase.trace.references.creatorSessionId, session.id);
    assert.equal((await stat(phase.persistence.path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.ok(CREATOR_PLANNER_SYSTEM_PROMPT.includes("read-only"));
});

test("builder derives structural fields and rejects creative payload outside its contract", async () => {
  const ownership = createStudioOwnershipMap({
    projectId: "studio_project_update",
    revisionHash: REVISION,
    observation: OBSERVATION,
  });
  const session = createCreatorSession({
    prompt: PROMPT,
    projectId: ownership.projectId,
    revisionHash: REVISION,
    ownership,
    now: new Date("2026-08-31T00:00:00.000Z"),
  });
  const plan = createCreatorPlan(
    {
      sessionId: session.id,
      promptHash: session.promptHash,
      projectRevisionHash: REVISION,
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      creatorPrompt: PROMPT,
      inspectionPaths: ["Workspace/Generator"],
      steps: [
        {
          id: "update_generator",
          statement: "Apply one approved Generator update",
          changeIds: ["update_generator"],
        },
      ],
      changes: [
        {
          id: "update_generator",
          kind: "update",
          path: "Workspace/Generator",
          expectedClass: "Part",
        },
      ],
      charter: {
        clauses: [
          {
            id: "generator_exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "Workspace/Generator",
            expectedClass: "BasePart",
          },
          {
            id: "diagnostics",
            kind: "studio_check",
            check: "playtest_diagnostics",
            maximumErrors: 0,
            maximumWarnings: 5,
          },
        ],
      },
    },
    OBSERVATION,
    ownership,
  );
  const approval = createCreatorApproval({
    sessionId: session.id,
    artifactKind: "plan",
    artifactId: plan.id,
    artifactHash: plan.hash,
    decision: "approved",
    decidedAt: "2026-08-31T00:01:00.000Z",
  });
  const host = new CreatorBuilderToolHost({
    session,
    ownership,
    observation: OBSERVATION,
    plan,
    planApproval: approval,
  });
  assert.match(
    stableJson(host.contract),
    /"expectedPath":"Workspace\/Generator"/,
  );
  assert.match(stableJson(host.contract), /"beforeHash":"[0-9a-f]{64}"/);
  assert.equal(
    (
      await host.execute("studio.inspect", {
        paths: ["Workspace/PreservedTree/Crown"],
      })
    ).ok,
    false,
  );
  const internalTaggedInput = await host.execute("studio.stage", {
    change: {
      planChangeId: "update_generator",
      properties: { Anchored: { type: "boolean", value: true } },
    },
  });
  assert.equal(internalTaggedInput.ok, false);
  assert.equal(internalTaggedInput.error?.code, "TOOL_ARGUMENTS_INVALID");
  assert.match(
    internalTaggedInput.error?.message ?? "",
    /change\.properties\.Anchored/,
  );
  assert.equal(
    (
      await host.execute("studio.stage", {
        change: {
          planChangeId: "update_generator",
          properties: { Position: { x: 0, y: 0, z: 0 } },
        },
      })
    ).ok,
    false,
  );
  for (const properties of [
    { Transparency: 2 },
    { Material: "NotAMaterial" },
    { Size: { x: 1, y: 0, z: 1 } },
  ]) {
    assert.equal(
      (
        await host.execute("studio.stage", {
          change: { planChangeId: "update_generator", properties },
        })
      ).ok,
      false,
    );
  }
  assert.equal(
    (
      await host.execute("studio.stage", {
        change: {
          planChangeId: "update_generator",
          properties: { Transparency: 0.1 },
          attributes: { NewFlag: true },
          removedAttributes: ["OldFlag"],
        },
      })
    ).ok,
    true,
  );
  const operation = host.stagedOperations()[0]!;
  assert.equal(operation.kind, "update");
  assert.equal(
    operation.kind === "update" && operation.expectedPath,
    "Workspace/Generator",
  );
  assert.equal(
    operation.kind === "update" && operation.stableId,
    "instance_generator",
  );
  assert.deepEqual(operation.kind === "update" && operation.removedAttributes, [
    "OldFlag",
  ]);
  assert.equal(
    (
      await host.execute("studio.stage", {
        change: { planChangeId: "update_generator" },
      })
    ).ok,
    false,
  );
  assert.equal((await host.execute("forge.verify", {})).ok, true);
  assert.equal(host.seal().operations.length, 1);
});

test("generic existing-object contracts support inspected source replacement and atomic move-plus-property changes", async () => {
  const oldSource = 'print("old")\n';
  const observation: StudioSnapshotObservation = {
    ...structuredClone(OBSERVATION),
    instances: [
      ...structuredClone(OBSERVATION.instances).map((instance) =>
        instance.stableId === "instance_generator"
          ? { ...instance, attributes: [{ name: "OldFlag", value: true }] }
          : instance,
      ),
      {
        stableId: "instance_existing_script",
        path: "ServerScriptService/ExistingController",
        className: "Script",
        properties: [],
        attributes: [{ name: "Legacy", value: true }],
        tags: [],
      },
    ],
    scripts: [
      {
        stableId: "instance_existing_script",
        path: "ServerScriptService/ExistingController",
        executionContext: "server",
        sourceHash: contentHash(oldSource),
        source: oldSource,
      },
    ],
  };
  const ownership = createStudioOwnershipMap({
    projectId: "studio_project_generic_edit",
    revisionHash: REVISION,
    observation,
  });
  const prompt =
    "Move and restyle Generator, then update the existing controller without losing its unrelated structure.";
  const session = createCreatorSession({
    prompt,
    projectId: ownership.projectId,
    revisionHash: REVISION,
    ownership,
    now: new Date("2026-08-31T00:00:00.000Z"),
  });
  const plan = createCreatorPlan(
    {
      sessionId: session.id,
      promptHash: session.promptHash,
      projectRevisionHash: REVISION,
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      creatorPrompt: prompt,
      inspectionPaths: [
        "ServerScriptService/ExistingController",
        "Workspace/Generator",
      ],
      steps: [
        {
          id: "modify_existing",
          statement:
            "Move and restyle the Part and replace the existing Script source.",
          changeIds: ["move_generator", "replace_controller"],
        },
      ],
      changes: [
        {
          id: "move_generator",
          kind: "move",
          fromPath: "Workspace/Generator",
          toPath: "Workspace/MovedGenerator",
          expectedClass: "Part",
        },
        {
          id: "replace_controller",
          kind: "write_source",
          path: "ServerScriptService/ExistingController",
          expectedClass: "Script",
        },
      ],
      charter: {
        clauses: [
          {
            id: "moved_exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "Workspace/MovedGenerator",
            expectedClass: "Part",
          },
          {
            id: "controller_exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "ServerScriptService/ExistingController",
            expectedClass: "Script",
          },
          { id: "syntax", kind: "local_check", check: "luau_syntax" },
          {
            id: "diagnostics",
            kind: "studio_check",
            check: "playtest_diagnostics",
            maximumErrors: 0,
            maximumWarnings: 5,
          },
        ],
      },
    },
    observation,
    ownership,
  );
  const approval = createCreatorApproval({
    sessionId: session.id,
    artifactKind: "plan",
    artifactId: plan.id,
    artifactHash: plan.hash,
    decision: "approved",
    decidedAt: "2026-08-31T00:01:00.000Z",
  });
  const host = new CreatorBuilderToolHost({
    session,
    ownership,
    observation,
    plan,
    planApproval: approval,
  });

  const source = await host.execute("studio.read_source", {
    path: "ServerScriptService/ExistingController",
  });
  assert.equal(source.ok, true);
  assert.equal((source.value as { source: string }).source, oldSource);
  assert.equal(
    (source.value as { sourceHash: string }).sourceHash,
    contentHash(oldSource),
  );
  assert.equal(
    (
      await host.execute("studio.read_source", {
        path: "ServerScriptService/NotApproved",
      })
    ).error?.code,
    "SOURCE_PATH_NOT_APPROVED",
  );

  assert.equal(
    (
      await host.execute("studio.stage", {
        change: {
          planChangeId: "move_generator",
          properties: {
            Material: "Neon",
            CFrame: {
              position: { x: 8, y: 4, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
            },
          },
          attributes: { MovedByForge: true },
          removedAttributes: ["OldFlag"],
        },
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await host.execute("studio.stage", {
        change: {
          planChangeId: "replace_controller",
          source: "return true\n",
          attributes: { Rewritten: true },
          removedAttributes: ["Legacy"],
        },
      })
    ).ok,
    true,
  );
  assert.equal((await host.execute("forge.verify", {})).ok, true);
  const changeSet = host.seal();
  const moved = changeSet.operations.find(
    (operation) => operation.kind === "move",
  );
  assert.equal(
    moved?.kind === "move" && moved.properties.Material?.type,
    "string",
  );
  const replacement = changeSet.operations.find(
    (operation) => operation.kind === "write_source",
  );
  assert.deepEqual(
    replacement?.kind === "write_source" && replacement.removedAttributes,
    ["Legacy"],
  );
  const presentation = createChangeReviewPresentation(
    changeSet,
    observation,
  ) as {
    operations: Array<Record<string, unknown>>;
    sourceDiffs: Array<{ unifiedDiff: string }>;
  };
  const presentedMove = presentation.operations.find(
    (operation) => operation.kind === "move",
  );
  assert.deepEqual(presentedMove?.attributes, { MovedByForge: true });
  assert.deepEqual(presentedMove?.removedAttributes, ["OldFlag"]);
  assert.match(
    presentation.sourceDiffs[0]!.unifiedDiff,
    /print\("old"\)[\s\S]*return true/,
  );

  const { kind: _kind, id: _id, hash: _hash, ...payload } = changeSet;
  assert.throws(
    () =>
      createCreatorChangeSet(
        {
          ...payload,
          operations: payload.operations.map((operation) =>
            operation.kind === "write_source"
              ? { ...operation, source: "   " }
              : operation,
          ),
        },
        observation,
        ownership,
        plan,
        host.contract,
      ),
    /Required script source/,
  );
});

test("creator builder enforces active write and UTF-8 source-byte budgets before sealing", async () => {
  const { ownership, session, plan, approval } = builderSetup();
  const writeBlocked = new CreatorBuilderToolHost({
    session,
    ownership,
    observation: OBSERVATION,
    plan,
    planApproval: approval,
    budgets: { ...INITIAL_EXPERIMENT_BUDGETS, maxWrites: 0 },
  });
  const blocked = await writeBlocked.execute("studio.stage", {
    change: { planChangeId: "create_beacon" },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.code, "TOOL_BUDGET_EXHAUSTED");

  const sourceBlocked = new CreatorBuilderToolHost({
    session,
    ownership,
    observation: OBSERVATION,
    plan,
    planApproval: approval,
    budgets: {
      ...INITIAL_EXPERIMENT_BUDGETS,
      maxBytesPerFile: 7,
      maxChangedSourceBytes: 7,
    },
  });
  const oversized = await sourceBlocked.execute("studio.stage", {
    change: { planChangeId: "create_script", source: "😀😀" },
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error?.code, "SOURCE_BUDGET_EXHAUSTED");
});

test("CreatorControlView exposes only current actions and rejects stale, unavailable, or replayed requests", () => {
  const view = createCreatorControlView({
    creatorSessionId: "creator_session_control",
    creatorSessionHash: contentHash("control-session"),
    status: "awaiting_change_approval",
    title: "Review Changes",
    detail: "Approve applies the exact hash.",
    artifact: {
      kind: "change_set",
      id: "creator_change_set_control",
      hash: contentHash("change-set"),
      presentation: { operations: 2 },
      presentationHash: contentHash(stableJson({ operations: 2 })),
    },
    primaryAction: {
      id: "approve_and_apply_changes",
      label: "Approve & Apply",
      intent: "primary",
    },
    secondaryAction: {
      id: "reject_changes",
      label: "Reject",
      intent: "secondary",
    },
  });
  const action = {
    creatorSessionId: view.creatorSessionId,
    viewId: view.id,
    viewHash: view.hash,
    actionId: "approve_and_apply_changes" as const,
  };
  assert.doesNotThrow(() => assertCreatorControlActionBinding(view, action));
  assert.throws(
    () =>
      assertCreatorControlActionBinding(view, {
        ...action,
        viewHash: contentHash("stale"),
      }),
    /stale/,
  );
  assert.throws(
    () =>
      assertCreatorControlActionBinding(view, {
        ...action,
        actionId: "start_checks",
      }),
    /not available/,
  );
  assert.throws(
    () => assertCreatorControlActionBinding(view, action, true),
    /already consumed/,
  );
});

test("CreatorReviewReport preserves free-form creator authority and enforces bounded non-whitespace evidence", () => {
  const input = {
    sessionId: "creator_session_review",
    changeSetId: "creator_change_set_review",
    changeSetHash: contentHash("review-change-set"),
    charterId: "verification_charter_review",
    charterHash: contentHash("review-charter"),
    decision: "accepted" as const,
    report:
      "I triggered Toggle Door twice in Play Solo and observed the anchored door open, then return to its starting position.",
    reviewedObservationHash: contentHash("reviewed-observation"),
    reviewedAt: "2026-09-01T00:00:00.000Z",
  };
  const report = createCreatorReviewReport(input);
  assert.doesNotThrow(() => assertCreatorReviewReport(report));
  assert.equal(report.authority, "creator");
  assert.equal(report.report, input.report);
  assert.throws(
    () => createCreatorReviewReport({ ...input, report: " \n\t " }),
    /Invalid CreatorReviewReport/,
  );
  assert.throws(
    () => createCreatorReviewReport({ ...input, report: "x".repeat(4097) }),
    /Invalid CreatorReviewReport/,
  );
});

test("creator control startup classifies interrupted planning and keeps review states resumable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "forge-creator-restart-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const ownership = createStudioOwnershipMap({
    projectId: "studio_project_restart",
    revisionHash: REVISION,
    observation: OBSERVATION,
  });
  const interrupted = createCreatorSession({
    prompt: PROMPT,
    projectId: ownership.projectId,
    revisionHash: REVISION,
    ownership,
    now: new Date("2026-09-01T00:00:00.000Z"),
  });
  await persistCreatorPrompt(interrupted, PROMPT, root);
  await persistCreatorBundle(
    {
      session: interrupted,
      ownership,
      observation: OBSERVATION,
      observationHistory: [{ revisionHash: REVISION, observation: OBSERVATION }],
      buildContracts: [],
      approvals: [],
      changeSets: [],
      verifications: [],
      agentRuns: [],
    },
    root,
  );
  const coordinator = new CreatorSessionCoordinator(
    dormantCoordinatorInputs(root),
  );
  context.after(() => coordinator.close());
  await coordinator.initialize();
  const interruptedState = await coordinator.dashboardState(interrupted.id);
  assert.equal(interruptedState.controlView?.status, "incomplete");
  assert.equal(interruptedState.sessions[0]?.failure?.code, "control_process_interrupted");
  assert.equal(
    interruptedState.stages.find((stage) => stage.id === "plan")?.status,
    "failed",
  );

  const resumableRoot = await mkdtemp(
    join(tmpdir(), "forge-creator-resumable-"),
  );
  context.after(() => rm(resumableRoot, { recursive: true, force: true }));
  const resumableOwnership = createStudioOwnershipMap({
    projectId: "studio_project_resumable",
    revisionHash: REVISION,
    observation: OBSERVATION,
  });
  const reviewSession = createCreatorSession({
    prompt: PROMPT,
    projectId: resumableOwnership.projectId,
    revisionHash: REVISION,
    ownership: resumableOwnership,
  });
  const plan = restartReviewPlan(reviewSession, resumableOwnership);
  const awaitingPlan = advanceSession(reviewSession, {
    status: "awaiting_plan_approval",
    plan,
  });
  await persistCreatorPrompt(awaitingPlan, PROMPT, resumableRoot);
  await persistCreatorBundle(
    {
      session: awaitingPlan,
      ownership: resumableOwnership,
      observation: OBSERVATION,
      observationHistory: [{ revisionHash: REVISION, observation: OBSERVATION }],
      plan,
      buildContracts: [],
      approvals: [],
      changeSets: [],
      verifications: [],
      agentRuns: [],
    },
    resumableRoot,
  );
  const resumedCoordinator = new CreatorSessionCoordinator(
    dormantCoordinatorInputs(resumableRoot),
  );
  context.after(() => resumedCoordinator.close());
  await resumedCoordinator.initialize();
  const resumedState = await resumedCoordinator.dashboardState(awaitingPlan.id);
  assert.equal(resumedState.controlView?.status, "awaiting_plan_approval");
  assert.equal(resumedState.controlView?.primaryAction?.id, "approve_plan");

  resumedCoordinator.close();
  const duplicateSession = createCreatorSession({
    prompt: PROMPT,
    projectId: resumableOwnership.projectId,
    revisionHash: REVISION,
    ownership: resumableOwnership,
  });
  const duplicatePlan = restartReviewPlan(
    duplicateSession,
    resumableOwnership,
  );
  const duplicateAwaitingPlan = advanceSession(duplicateSession, {
    status: "awaiting_plan_approval",
    plan: duplicatePlan,
  });
  await persistCreatorPrompt(duplicateAwaitingPlan, PROMPT, resumableRoot);
  await persistCreatorBundle(
    {
      session: duplicateAwaitingPlan,
      ownership: resumableOwnership,
      observation: OBSERVATION,
      observationHistory: [{ revisionHash: REVISION, observation: OBSERVATION }],
      plan: duplicatePlan,
      buildContracts: [],
      approvals: [],
      changeSets: [],
      verifications: [],
      agentRuns: [],
    },
    resumableRoot,
  );
  const duplicateCoordinator = new CreatorSessionCoordinator(
    dormantCoordinatorInputs(resumableRoot),
  );
  context.after(() => duplicateCoordinator.close());
  await assert.rejects(
    duplicateCoordinator.initialize(),
    /multiple nonterminal creator sessions/,
  );
});

test("native creator completion contract turns a premature end_turn into a structured agent failure", async () => {
  const { ownership, session, plan, approval } = builderSetup();
  const client: ModelClient = {
    descriptor: new CreatorRuntime(async () => {}).modelClientDescriptor,
    async complete(request: ModelTurnRequest): Promise<ModelTurnResult> {
      return {
        kind: "assistant",
        message: { role: "assistant", content: "Done.", toolCalls: [] },
        stopReason: "end_turn",
        usage: { inputTokens: 4, outputTokens: 1, costUsd: 0 },
        requestHash: contentHash(stableJson(request)),
        responseHash: contentHash("premature-end-turn"),
        responseFacts: {
          requestedModel: request.model,
          resolvedModel: request.model,
          servingProvider: "fake",
          responseId: "response-premature",
          latencyMs: 1,
          retryCount: 0,
          finishReason: "stop",
          continuationHash: null,
          continuationBytes: null,
        },
      };
    },
  };
  const result = await runCreatorBuilder({
    session,
    ownership,
    observation: OBSERVATION,
    prompt: PROMPT,
    plan,
    planApproval: approval,
    runtime: new ForgeNativeAgentRuntime(client),
  });
  assert.equal(result.runtimeResult.status, "failed");
  assert.equal(result.runtimeResult.failureKind, "model");
  assert.equal(result.runtimeResult.failureCode, "BUILDER_NO_OPERATIONS");
  assert.equal(result.finalization.status, "unsealed");
  assert.equal(
    result.finalization.status === "unsealed" &&
      result.finalization.failureStage,
    "runtime",
  );
});

test("LocalCreatorAgentWorker persists an unsealed planner attempt before returning incomplete", async (context) => {
  const ownership = createStudioOwnershipMap({
    projectId: "studio_project_planner_evidence",
    revisionHash: REVISION,
    observation: OBSERVATION,
  });
  const session = createCreatorSession({
    prompt: PROMPT,
    projectId: ownership.projectId,
    revisionHash: REVISION,
    ownership,
    now: new Date("2026-08-31T00:00:00.000Z"),
  });
  const directory = await mkdtemp(
    join(tmpdir(), "forge-creator-planner-evidence-"),
  );
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const result = await new LocalCreatorAgentWorker(
    new CreatorRuntime(async () => {}),
    directory,
  ).plan({
    session,
    ownership,
    observation: OBSERVATION,
    prompt: PROMPT,
    budgets: INITIAL_EXPERIMENT_BUDGETS,
  });
  assert.equal(result.status, "unsealed");
  assert.equal(
    result.status === "unsealed" && result.failure.code,
    "PLAN_NOT_PUBLISHED",
  );
  const run = JSON.parse(
    await readFile(join(directory, result.evidence.agentRun.locator), "utf8"),
  ) as AgentRun;
  assertAgentRun(run);
  assert.equal(run.status, "incomplete");
  assert.equal(run.classification, "agent_failure");
  assert.equal(run.creatorPhaseOutcome?.status, "unsealed");
  assert.equal(
    run.creatorPhaseOutcome?.status === "unsealed" &&
      run.creatorPhaseOutcome.failureCode,
    "PLAN_NOT_PUBLISHED",
  );
  assert.equal(
    (await stat(join(directory, "traces", `${result.evidence.traceId}.json`)))
      .mode & 0o777,
    0o600,
  );
});

test("LocalCreatorAgentWorker persists AgentRun and trace evidence for every builder terminal shape", async (context) => {
  const { ownership, session, plan, approval } = builderSetup();
  const beacon = {
    change: {
      planChangeId: "create_beacon",
      properties: { Anchored: true },
    },
  };
  const script = {
    change: { planChangeId: "create_script", source: "return nil\n" },
  };
  const invalid = { change: { planChangeId: "not_approved" } };
  const directory = await mkdtemp(
    join(tmpdir(), "forge-creator-terminal-evidence-"),
  );
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const cases: Array<{
    name: string;
    runtime: AgentRuntime;
    code?: string;
    toolCalls: number;
    sealed?: true;
  }> = [
    {
      name: "premature end turn",
      runtime: new CreatorRuntime(async () => {}),
      code: "BUILDER_NO_OPERATIONS",
      toolCalls: 0,
    },
    {
      name: "rejected stage",
      runtime: new CreatorRuntime(async (input) => {
        await input.tools.execute("studio.stage", invalid);
      }),
      code: "BUILDER_NO_OPERATIONS",
      toolCalls: 0,
    },
    {
      name: "partial coverage",
      runtime: new CreatorRuntime(async (input) => {
        await input.tools.execute("studio.stage", beacon);
        await input.tools.execute("forge.verify", {});
      }),
      code: "BUILDER_CHANGE_COVERAGE_INCOMPLETE",
      toolCalls: 0,
    },
    {
      name: "local gate not run",
      runtime: new CreatorRuntime(async (input) => {
        await input.tools.execute("studio.stage", beacon);
        await input.tools.execute("studio.stage", script);
      }),
      code: "BUILDER_LOCAL_GATE_NOT_ELIGIBLE",
      toolCalls: 0,
    },
    {
      name: "provider failure",
      runtime: {
        identity: FORGE_NATIVE_RUNTIME_IDENTITY,
        modelClientDescriptor: new CreatorRuntime(async () => {})
          .modelClientDescriptor,
        async run() {
          return {
            status: "failed",
            trialStarted: false,
            failureKind: "provider",
            failureCode: "PROVIDER_503",
            error: "provider unavailable",
            usage: { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
            timing: { startedAt: "2026-08-31T00:00:00.000Z", endedAt: "2026-08-31T00:00:00.000Z", durationMs: 0 },
            turns: [],
            toolCalls: [],
          };
        },
      },
      code: "PROVIDER_503",
      toolCalls: 0,
    },
    {
      name: "sealed",
      runtime: new CreatorRuntime(async (input) => {
        await input.tools.execute("studio.stage", beacon);
        await input.tools.execute("studio.stage", script);
        await input.tools.execute("forge.verify", {});
      }),
      toolCalls: 0,
      sealed: true,
    },
  ];
  for (const scenario of cases)
    await context.test(scenario.name, async () => {
      const worker = new LocalCreatorAgentWorker(scenario.runtime, directory);
      const result = await worker.build({
        session,
        ownership,
        observation: OBSERVATION,
        prompt: PROMPT,
        plan,
        planApproval: approval,
        budgets: INITIAL_EXPERIMENT_BUDGETS,
      });
      assert.equal(result.status, scenario.sealed ? "sealed" : "unsealed");
      assert.deepEqual(result.evidence.buildContract, {
        id: result.buildContract.id,
        hash: result.buildContract.hash,
      });
      assert.equal(
        result.evidence.outcome.status,
        scenario.sealed ? "sealed" : "unsealed",
      );
      if (!scenario.sealed) {
        assert.equal(
          result.status === "unsealed" && result.failure.code,
          scenario.code,
        );
        assert.equal(
          result.evidence.outcome.status === "unsealed" &&
            result.evidence.outcome.failureCode,
          scenario.code,
        );
      }
      const run = JSON.parse(
        await readFile(join(directory, result.evidence.agentRun.locator), "utf8"),
      ) as AgentRun;
      assertAgentRun(run);
      assert.equal(
        run.status,
        scenario.sealed ? "locally_eligible" : "incomplete",
      );
      assert.equal(
        run.classification,
        scenario.sealed
          ? "none"
          : scenario.name === "provider failure"
            ? "provider_failure"
            : "agent_failure",
      );
      assert.equal(run.toolCalls.length, scenario.toolCalls);
      assert.deepEqual(run.creatorPhaseOutcome, result.evidence.outcome);
      assert.deepEqual(run.creatorBuildContract, result.evidence.buildContract);
      assert.equal(
        (await stat(join(directory, result.evidence.agentRun.locator))).mode & 0o777,
        0o600,
      );
      assert.equal(
        (
          await stat(
            join(directory, "traces", `${result.evidence.traceId}.json`),
          )
        ).mode & 0o777,
        0o600,
      );
    });
});

test("creator bundle graph binds approved plan, build contract, sealed change set, AgentRun, and trace references", async (context) => {
  const setup = builderSetup();
  const awaitingPlan = advanceSession(setup.session, {
    status: "awaiting_plan_approval",
    plan: setup.plan,
  });
  const building = advanceSession(awaitingPlan, {
    status: "building",
    approval: setup.approval,
  });
  const directory = await mkdtemp(
    join(tmpdir(), "forge-creator-bundle-graph-"),
  );
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const worker = new LocalCreatorAgentWorker(
    new CreatorRuntime(async (input) => {
      await input.tools.execute("studio.stage", {
        change: {
          planChangeId: "create_beacon",
          properties: {
            Anchored: true,
            Material: "Neon",
          },
        },
      });
      await input.tools.execute("studio.stage", {
        change: { planChangeId: "create_script", source: "return nil\n" },
      });
      await input.tools.execute("forge.verify", {});
    }),
    directory,
  );
  const built = await worker.build({
    session: building,
    ownership: setup.ownership,
    observation: OBSERVATION,
    prompt: PROMPT,
    plan: setup.plan,
    planApproval: setup.approval,
    budgets: INITIAL_EXPERIMENT_BUDGETS,
  });
  assert.equal(built.status, "sealed");
  if (built.status !== "sealed") return;
  const reviewing = advanceSession(building, {
    status: "awaiting_change_approval",
    changeSet: built.changeSet,
  });
  const bundle = {
    session: reviewing,
    ownership: setup.ownership,
    observation: OBSERVATION,
    observationHistory: [{ revisionHash: REVISION, observation: OBSERVATION }],
    plan: setup.plan,
    buildContracts: [built.buildContract],
    approvals: [setup.approval],
    changeSets: [built.changeSet],
    verifications: [],
    agentRuns: [built.evidence],
  };
  assert.doesNotThrow(() => assertCreatorSessionBundle(bundle));
  assert.equal(
    contentHash(await readFile(join(directory, built.evidence.agentRun.locator), "utf8")),
    built.evidence.agentRun.artifactHash,
  );
  assert.equal(
    contentHash(await readFile(join(directory, built.evidence.trace.locator), "utf8")),
    built.evidence.trace.artifactHash,
  );
  const persisted = await persistCreatorBundle(bundle, directory);
  assert.equal(
    (await loadCreatorBundle(persisted.path)).agentRuns[0]?.traceBuildKey,
    built.evidence.traceBuildKey,
  );
  assert.throws(
    () =>
      assertCreatorSessionBundle({
        ...bundle,
        changeSets: [
          {
            ...built.changeSet,
            buildContractHash: contentHash("wrong-contract"),
          },
        ],
      }),
    /CreatorChangeSet identity|build contract/,
  );
  await writeFile(join(directory, built.evidence.agentRun.locator), "tampered\n", "utf8");
  await assert.rejects(
    () => loadCreatorBundle(persisted.path),
    /byte count|SHA-256 mismatch/,
  );
});

function restartReviewPlan(
  session: CreatorSession,
  ownership: StudioOwnershipMap,
) {
  return createCreatorPlan(
    {
      sessionId: session.id,
      promptHash: session.promptHash,
      projectRevisionHash: REVISION,
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      creatorPrompt: PROMPT,
      inspectionPaths: ["Workspace"],
      steps: [
        {
          id: "create_part_step",
          statement: "Create the approved Part.",
          changeIds: ["create_part"],
        },
      ],
      changes: [
        {
          id: "create_part",
          kind: "create",
          path: "Workspace/RestartPart",
          className: "Part",
          initialization: "initial_properties",
        },
      ],
      charter: {
        clauses: [
          {
            id: "part_exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "Workspace/RestartPart",
            expectedClass: "Part",
          },
          {
            id: "diagnostics",
            kind: "studio_check",
            check: "playtest_diagnostics",
            maximumErrors: 0,
            maximumWarnings: 0,
          },
        ],
      },
    },
    OBSERVATION,
    ownership,
  );
}

function builderSetup() {
  const ownership = createStudioOwnershipMap({
    projectId: "studio_project_builder_evidence",
    revisionHash: REVISION,
    observation: OBSERVATION,
  });
  const session = createCreatorSession({
    prompt: PROMPT,
    projectId: ownership.projectId,
    revisionHash: REVISION,
    ownership,
    now: new Date("2026-08-31T00:00:00.000Z"),
  });
  const plan = createCreatorPlan(
    {
      sessionId: session.id,
      promptHash: session.promptHash,
      projectRevisionHash: REVISION,
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      creatorPrompt: PROMPT,
      inspectionPaths: ["Workspace/Generator", "Workspace/PreservedTree"],
      steps: [
        {
          id: "build",
          statement: "Create both approved outputs",
          changeIds: ["create_beacon", "create_script"],
        },
      ],
      changes: [
        {
          id: "create_beacon",
          kind: "create",
          path: "Workspace/Generator/StatusBeacon",
          className: "Part",
          initialization: "initial_properties",
        },
        {
          id: "create_script",
          kind: "create",
          path: "ServerScriptService/StatusBeaconController",
          className: "Script",
          initialization: "inline_source_required",
        },
      ],
      charter: {
        clauses: [
          {
            id: "beacon_exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "Workspace/Generator/StatusBeacon",
            expectedClass: "Part",
          },
          {
            id: "script_exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "ServerScriptService/StatusBeaconController",
            expectedClass: "Script",
          },
          { id: "syntax", kind: "local_check", check: "luau_syntax" },
          {
            id: "diagnostics",
            kind: "studio_check",
            check: "playtest_diagnostics",
            maximumErrors: 0,
            maximumWarnings: 0,
          },
        ],
      },
    },
    OBSERVATION,
    ownership,
  );
  const approval = createCreatorApproval({
    sessionId: session.id,
    artifactKind: "plan",
    artifactId: plan.id,
    artifactHash: plan.hash,
    decision: "approved",
    decidedAt: "2026-08-31T00:01:00.000Z",
  });
  return { ownership, session, plan, approval };
}

function dormantCoordinatorInputs(
  directory: string,
): ConstructorParameters<typeof CreatorSessionCoordinator>[0] {
  const connection: StudioBridgeConnection = {
    async send() {
      throw new Error("Restart tests do not send Studio commands");
    },
    subscribeWithSession() {
      return () => {};
    },
    async close() {},
  };
  const worker: CreatorAgentWorker = {
    descriptor: {
      kind: "CreatorAgentWorkerDescriptor",
      name: "forge-local-creator-agent-worker",
      environment: "local_process",
      isolation: "none",
    },
    async plan() {
      throw new Error("Restart tests do not call a model");
    },
    async build() {
      throw new Error("Restart tests do not call a model");
    },
  };
  return { connection, worker, directory };
}
