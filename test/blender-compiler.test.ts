import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import {
  ImmutableBinaryArtifactStore,
  assertBinaryArtifactReference,
} from "../packages/artifact-store/src/index.js";
import {
  BLENDER_COMPILER_ABI,
  BLENDER_INSTALLATION_QUALIFICATION_ABI,
  compileBlenderScene,
  currentBlenderWorkerIdentity,
  inspectBlenderInstallation,
  inspectGlb,
} from "../packages/blender-compiler/src/index.js";
import {
  BLENDER_COMPILER_PROFILE,
  BLENDER_MACOS_ARM64_DMG_SHA256,
  BLENDER_VERSION,
  blenderSceneSpecHandle,
  planSceneRepair,
  solveBlenderScene,
} from "../packages/visual-world/src/index.js";
import { visualWorldIntent } from "./helpers/visual-world-fixture.js";

const temporaryPrefix = resolve(import.meta.dirname, "../.blender-compiler-test-");
const execFileAsync = promisify(execFile);

test("synthetic GLB inspection measures transformed vertices and exact hierarchy", () => {
  const bytes = syntheticGlb();
  const report = inspectGlb(bytes, { expectedNodeNames: ["FixtureMesh"] });
  assert.equal(report.triangleCount, 1);
  assert.equal(report.nodeCount, 2);
  const mesh = report.nodes.find((node) => node.name === "FixtureMesh");
  assert.equal(mesh?.parentName, "FixtureRoot");
  assert.deepEqual(mesh?.bounds, { minimum: [10, 2, 0], maximum: [12, 5, 0] });
  assert.deepEqual(mesh?.worldMatrix.slice(12, 15), [10, 2, 0]);

  const external = syntheticGlb({ bufferUri: "https://untrusted.invalid/world.bin" });
  assert.throws(() => inspectGlb(external), /external buffer URI/i);
  const orphan = syntheticGlb({ orphanNode: true });
  assert.throws(() => inspectGlb(orphan), /outside the declared scene/i);
  const executableExtension = syntheticGlb({ extension: "KHR_draco_mesh_compression" });
  assert.throws(() => inspectGlb(executableExtension), /unsupported GLB extensions/i);

  const invalidIndex = mutateGlbJson(bytes, (json) => {
    const accessors = json.accessors as unknown[];
    accessors.push({
      bufferView: 0,
      byteOffset: 14,
      componentType: 5121,
      count: 3,
      type: "SCALAR",
    });
    const meshes = json.meshes as Array<{ primitives: Array<Record<string, unknown>> }>;
    meshes[0]!.primitives[0]!.indices = accessors.length - 1;
  });
  assert.throws(() => inspectGlb(invalidIndex), /index exceeds POSITION/i);

  const fakeTexture = mutateGlbJson(bytes, (json) => {
    json.images = [{ bufferView: 0, mimeType: "image/png" }];
    json.textures = [{ source: 0 }];
  });
  assert.throws(() => inspectGlb(fakeTexture), /PNG image is malformed/i);

  const singular = mutateGlbJson(bytes, (json) => {
    const nodes = json.nodes as Array<Record<string, unknown>>;
    delete nodes[1]!.translation;
    nodes[1]!.matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  });
  assert.throws(() => inspectGlb(singular), /singular/i);

  const nonfiniteNormal = mutateGlbBinary(bytes, 36, (binary) =>
    binary.writeFloatLE(Number.NaN, 36),
  );
  assert.throws(() => inspectGlb(nonfiniteNormal), /NORMAL contains nonfinite/i);

  const unboundExtension = mutateGlbJson(bytes, (json) => {
    const materials = json.materials as Array<Record<string, unknown>>;
    materials[0] = { extensions: { KHR_materials_unlit: {} } };
  });
  assert.throws(() => inspectGlb(unboundExtension), /undeclared.*extension/i);
});

test("binary artifacts are immutable, hash-verified regular files", async () => {
  const root = await mkdtemp(temporaryPrefix);
  try {
    const store = new ImmutableBinaryArtifactStore(root, { maxBytes: 1024 });
    const bytes = syntheticGlb();
    const reference = await store.write(bytes, "model/gltf-binary");
    assertBinaryArtifactReference(reference);
    assert.deepEqual(await store.read(reference), bytes);
    assert.deepEqual(await store.write(bytes, "model/gltf-binary"), reference);
    await writeFile(resolve(root, reference.locator), Buffer.from("tampered"));
    await assert.rejects(store.read(reference), /byte count|SHA-256/i);
    await assert.rejects(store.write(new Uint8Array(), "model/gltf-binary"), /byte limit/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the fixed compiler reports this machine's absent Blender as incomplete", async () => {
  const result = await inspectBlenderInstallation({
    kind: "BlenderInstallationQualification",
    qualificationAbi: BLENDER_INSTALLATION_QUALIFICATION_ABI,
    abi: BLENDER_COMPILER_ABI,
    profile: BLENDER_COMPILER_PROFILE,
    platform: "darwin-arm64",
    blenderVersion: BLENDER_VERSION,
    distributionPath: "/missing/blender-5.2.1-macos-arm64.dmg",
    distributionBytes: 1,
    distributionImageVerified: true,
    executablePath: "/Applications/Blender-Forge-5.2.1.app/Contents/MacOS/Blender",
    executableSha256: "1".repeat(64),
    distributionSha256: BLENDER_MACOS_ARM64_DMG_SHA256,
    applicationPath: "/Applications/Blender-Forge-5.2.1.app",
    applicationInventorySha256: "6".repeat(64),
    applicationFileCount: 1,
    applicationBytes: 1,
    executableArchitecture: "arm64",
    bundleIdentifier: "org.blenderfoundation.blender",
    teamIdentifier: "68UA947AUU",
    designatedRequirementSha256: "7".repeat(64),
    codeSignatureValidated: true,
    bundledPythonRelativePath: "Contents/Resources/5.2/python/bin/python3.13",
    bundledPythonSha256: "8".repeat(64),
    bundledLibraryCount: 1,
    bundledLibraryInventorySha256: "9".repeat(64),
    seatbeltPolicySha256: "a".repeat(64),
    workerSha256: "2".repeat(64),
    inspectorSha256: "5".repeat(64),
    operationSetSha256: "3".repeat(64),
    exportProfileSha256: "4".repeat(64),
    qualifiedAt: "2026-09-07T00:00:00.000Z",
  });
  assert.deepEqual(result.status, "incomplete");
  assert.equal(result.code, "missing_blender");

  const worker = await readFile(resolve(process.cwd(), "workers/blender/worker.py"), "utf8");
  assert.match(worker, /BlenderSceneSpec/);
  assert.doesNotMatch(worker, /\beval\s*\(|\bexec\s*\(/);
  assert.doesNotMatch(worker, /subprocess|os\.system|urllib|requests/);
});

test("the built distribution publishes the exact fixed Blender worker", async () => {
  const workerPath = resolve(process.cwd(), "workers/blender/worker.py");
  const inspectorPath = resolve(process.cwd(), "workers/blender/inspect_blend.py");
  const source = await readFile(workerPath);
  const published = await readFile(resolve(process.cwd(), "dist/workers/blender/worker.py"));
  assert.deepEqual(published, source);
  await execFileAsync("python3", [
    "-c",
    "import pathlib,sys; [compile(pathlib.Path(p).read_bytes(), p, 'exec') for p in sys.argv[1:]]",
    workerPath,
    inspectorPath,
  ]);
  const workerText = source.toString("utf8");
  assert.match(workerText, /geometryAnalysis/);
  assert.match(workerText, /scene\.render\.engine = "CYCLES"/);
  assert.match(workerText, /scene\.render\.threads = 4/);
  assert.doesNotMatch(workerText, /atmosphere\["intensity"\]/);
});

test("repair compilation reuses frozen partition and review artifacts without worker output", async () => {
  const root = await mkdtemp(temporaryPrefix);
  try {
    const executable = resolve(root, "fixture-blender.mjs");
    const glb = compilerFixtureGlb();
    const png = solidPng(1280, 720).toString("base64");
    await writeFile(
      executable,
      `#!${process.execPath}\n` +
        `import fs from "node:fs"; import path from "node:path";\n` +
        `const args=process.argv.slice(2); if(args.includes("--version")){console.log("Blender 5.2.1 LTS fixture");process.exit(0)} const arg=(name)=>args[args.indexOf(name)+1]; if(args.includes("--blend-inspection")){const spec=JSON.parse(fs.readFileSync(arg("--binding-spec"),"utf8"));const objects=spec.objects.map(x=>({stableId:x.id,name:"Forge_"+x.id+"_df8a9eb308",partitionId:x.partitionId,meshVertices:3,meshPolygons:1}));fs.writeFileSync(arg("--report"),JSON.stringify({kind:"ForgeBlendInspection",abi:"forge-blend-inspection@2",sceneId:spec.sceneId,revision:spec.revision,objects})+"\\n",{flag:"wx"});process.exit(0)}\n` +
        `const spec=JSON.parse(fs.readFileSync(arg("--spec"),"utf8")); const directive=JSON.parse(fs.readFileSync(arg("--directive"),"utf8")); const outputRoot=arg("--outputs");\n` +
        `const report=(kind)=>kind==="geometry_report"?{kind:"ForgeGeometryReport",sceneId:spec.sceneId,revision:spec.revision,objects:spec.objects.map(x=>({stableId:x.id,exportName:"Forge_"+x.id+"_df8a9eb308",triangles:1,blenderBounds:{minimum:[-2,-4,-2],maximum:[2,4,2]}}))}:kind==="material_report"?{kind:"ForgeMaterialReport",sceneId:spec.sceneId,revision:spec.revision,materials:spec.materials.map(x=>({id:x.id,textureIds:x.textureIds,alphaMode:x.alphaMode}))}:kind==="budget_report"?{kind:"ForgeBudgetReport",sceneId:spec.sceneId,revision:spec.revision,objects:spec.objects.length,expandedInstances:0,triangles:1,limits:spec.budgets}:{kind:"ForgeNativeSceneSemantics",sceneId:spec.sceneId,revision:spec.revision,coordinateProfile:{scene:"roblox-y-up-studs",blenderMapping:"x,-z,y"},partitions:spec.partitions,collisionProxies:spec.collisionProxies,gameplayAnchors:spec.gameplayAnchors,interactiveProps:spec.interactiveProps,effects:spec.effects,sockets:spec.sockets,routes:spec.routes};\n` +
        `for(const output of spec.expectedOutputs){if(output.kind==="manifest")continue;if(output.kind==="glb"&&directive.reusedPartitionIds.includes(output.partitionId))continue;if(output.kind==="review_render"&&directive.reusedViewIds.includes(output.viewId))continue;const destination=path.join(outputRoot,output.relativePath);fs.mkdirSync(path.dirname(destination),{recursive:true});const bytes=output.kind==="glb"?Buffer.from(${JSON.stringify(Buffer.from(glb).toString("base64"))},"base64"):output.kind==="review_render"?Buffer.from(${JSON.stringify(png)},"base64"):output.kind==="blend"?Buffer.from("BLENDER17-01v050fixture"):Buffer.from(JSON.stringify(report(output.kind))+"\\n");fs.writeFileSync(destination,bytes,{flag:"wx"})}\n`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const executableBytes = await readFile(executable);
    const executableSha256 = createHash("sha256").update(executableBytes).digest("hex");
    const identity = await currentBlenderWorkerIdentity();
    const installation = {
      kind: "BlenderInstallationQualification" as const,
      qualificationAbi:
        BLENDER_INSTALLATION_QUALIFICATION_ABI as "forge-blender-installation-qualification@2",
      abi: BLENDER_COMPILER_ABI as "forge-blender-compiler@2",
      profile: BLENDER_COMPILER_PROFILE as "forge-blender-macos-arm64@2",
      platform: "darwin-arm64" as const,
      blenderVersion: BLENDER_VERSION as "5.2.1",
      distributionPath: executable,
      distributionBytes: executableBytes.byteLength,
      distributionImageVerified: true as const,
      executablePath: executable,
      executableSha256,
      distributionSha256:
        BLENDER_MACOS_ARM64_DMG_SHA256 as "6409e21de80994db5f4c4a34486b6fd43cea21085b912f7491c53e923acb65a3",
      applicationPath: root,
      applicationInventorySha256: "6".repeat(64),
      applicationFileCount: 1,
      applicationBytes: executableBytes.byteLength,
      executableArchitecture: "arm64" as const,
      bundleIdentifier: "org.blenderfoundation.blender" as const,
      teamIdentifier: "68UA947AUU" as const,
      designatedRequirementSha256: "7".repeat(64),
      codeSignatureValidated: true as const,
      bundledPythonRelativePath: "Contents/Resources/5.2/python/bin/python3.13" as const,
      bundledPythonSha256: "8".repeat(64),
      bundledLibraryCount: 1,
      bundledLibraryInventorySha256: "9".repeat(64),
      seatbeltPolicySha256: "a".repeat(64),
      ...identity,
      qualifiedAt: "2026-09-07T00:00:00.000Z",
    };
    const installationVerifier = async () => ({
      status: "eligible" as const,
      installationHash: "a".repeat(64),
    });
    const isolatedRunner = async (program: string, args: readonly string[], cwd: string) => {
      const result = await execFileAsync(program, [...args], { cwd, maxBuffer: 2 * 1024 * 1024 });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    };
    const parentIntent = visualWorldIntent();
    parentIntent.instances = [];
    parentIntent.collections[0]!.instanceIds = [];
    parentIntent.objects[0]!.partitionId = "static-chunk";
    parentIntent.partitions.find((entry) => entry.id === "static-chunk")!.objectIds = [
      "fixture-object",
    ];
    parentIntent.partitions.find((entry) => entry.id === "interactive-partition")!.objectIds = [];
    parentIntent.interactiveProps = [];
    parentIntent.expectedOutputs = parentIntent.expectedOutputs.filter(
      (entry) => entry.id !== "interactive-glb",
    );
    parentIntent.compiler = {
      profile: BLENDER_COMPILER_PROFILE,
      blenderVersion: BLENDER_VERSION,
      blenderBinarySha256: executableSha256,
      ...identity,
    };
    parentIntent.reviewViews.push({
      ...structuredClone(parentIntent.reviewViews[0]!),
      id: "secondary-view",
      name: "Secondary View",
    });
    parentIntent.expectedOutputs.splice(-1, 0, {
      id: "secondary-render",
      kind: "review_render",
      viewId: "secondary-view",
      relativePath: "renders/secondary-view.png",
    });
    const parent = solveBlenderScene(parentIntent);
    assert.equal(parent.status, "eligible", JSON.stringify(parent));
    if (parent.status !== "eligible") return;
    const binaryStore = new ImmutableBinaryArtifactStore(resolve(root, "artifacts"));
    const first = await compileBlenderScene({
      spec: parent.spec,
      installation,
      binaryStore,
      allowedSourceRoots: [],
      sources: [],
      installationVerifier,
      isolatedRunner: (program, args, _timeout, _logs, cwd) => isolatedRunner(program, args, cwd),
    });
    assert.equal(first.status, "eligible", JSON.stringify(first));
    if (first.status !== "eligible") return;
    const replay = await compileBlenderScene({
      spec: parent.spec,
      installation,
      binaryStore,
      allowedSourceRoots: [],
      sources: [],
      installationVerifier,
      isolatedRunner: (program, args, _timeout, _logs, cwd) => isolatedRunner(program, args, cwd),
    });
    assert.equal(replay.status, "incomplete");
    assert.match(replay.detail, /already dispatched/i);

    const nextIntent = structuredClone(parentIntent);
    nextIntent.revision = 2;
    const parentHandle = blenderSceneSpecHandle(parent.spec);
    nextIntent.parent = { revision: parentHandle.revision, hash: parentHandle.hash };
    nextIntent.reviewViews[0]!.fieldOfViewDegrees = 55;
    const repair = planSceneRepair(parent.spec, {
      kind: "SceneRepairProposal",
      id: "fixture-view-repair",
      parent: parentHandle,
      observationHashes: ["d".repeat(64)],
      changedIds: ["opening-view"],
      affectedInterfaceIds: [],
      intendedResult: "Change only the opening review frame.",
      nextIntent,
    });
    assert.equal(repair.status, "eligible", JSON.stringify(repair));
    if (repair.status !== "eligible") return;
    const second = await compileBlenderScene({
      spec: repair.solve.spec,
      installation,
      binaryStore,
      allowedSourceRoots: [],
      sources: [],
      repair: { plan: repair.plan, parentBundle: first.bundle },
      installationVerifier,
      isolatedRunner: (program, args, _timeout, _logs, cwd) => isolatedRunner(program, args, cwd),
    });
    assert.equal(second.status, "eligible", JSON.stringify(second));
    if (second.status !== "eligible") return;
    const outputHash = (bundle: typeof first.bundle, id: string): string =>
      bundle.manifest.outputs.find((entry) => entry.id === id)!.artifactHash;
    assert.equal(outputHash(second.bundle, "static-glb"), outputHash(first.bundle, "static-glb"));
    assert.equal(
      outputHash(second.bundle, "secondary-render"),
      outputHash(first.bundle, "secondary-render"),
    );
    assert.ok(second.bundle.repairDelta);
    assert.equal(second.bundle.manifest.repairDeltaHash, second.bundle.repairDelta.delta.hash);
    assert.deepEqual(
      second.bundle.repairDelta.delta.reusedArtifacts.map((entry) => entry.outputId),
      ["secondary-render", "static-glb"],
    );
    assert.deepEqual(second.bundle.repairDelta.delta.changedViewIds, ["opening-view"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function syntheticGlb(
  options: {
    bufferUri?: string;
    orphanNode?: boolean;
    extension?: string;
  } = {},
): Uint8Array {
  const binary = Buffer.alloc(96);
  const positions = [0, 0, 0, 2, 0, 0, 0, 3, 0];
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  [0, 0, 1, 0, 0, 1, 0, 0, 1].forEach((value, index) => binary.writeFloatLE(value, 36 + index * 4));
  [0, 0, 1, 0, 0, 1].forEach((value, index) => binary.writeFloatLE(value, 72 + index * 4));
  const nodes: unknown[] = [
    { name: "FixtureRoot", translation: [10, 0, 0], children: [1] },
    { name: "FixtureMesh", translation: [0, 2, 0], mesh: 0 },
  ];
  if (options.orphanNode) nodes.push({ name: "Orphan" });
  const json = {
    asset: { version: "2.0", generator: "Forge synthetic test fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes: [
      {
        name: "FixtureMesh",
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0, mode: 4 },
        ],
      },
    ],
    buffers: [
      {
        byteLength: binary.byteLength,
        ...(options.bufferUri ? { uri: options.bufferUri } : {}),
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, byteOffset: 0, componentType: 5126, count: 3, type: "VEC2" },
    ],
    materials: [{}],
    ...(options.extension ? { extensionsUsed: [options.extension] } : {}),
  };
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const paddedJson = Buffer.concat([
    jsonBytes,
    Buffer.alloc((4 - (jsonBytes.byteLength % 4)) % 4, 0x20),
  ]);
  const total = 12 + 8 + paddedJson.byteLength + 8 + binary.byteLength;
  const glb = Buffer.alloc(total);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(total, 8);
  glb.writeUInt32LE(paddedJson.byteLength, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(glb, 20);
  const binaryHeader = 20 + paddedJson.byteLength;
  glb.writeUInt32LE(binary.byteLength, binaryHeader);
  glb.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(glb, binaryHeader + 8);
  return glb;
}

function compilerFixtureGlb(): Uint8Array {
  const binary = Buffer.alloc(36);
  [-2, -4, -2, 2, -4, -2, -2, 4, 2].forEach((value, index) =>
    binary.writeFloatLE(value, index * 4),
  );
  const json = {
    asset: { version: "2.0", generator: "Forge synthetic compiler fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        name: "Forge_fixture-object_df8a9eb308",
        translation: [0, 4, 8],
        mesh: 0,
      },
    ],
    meshes: [
      {
        name: "Forge_fixture-object_df8a9eb308",
        primitives: [{ attributes: { POSITION: 0 }, mode: 4 }],
      },
    ],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.byteLength }],
    accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" }],
  };
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const paddedJson = Buffer.concat([
    jsonBytes,
    Buffer.alloc((4 - (jsonBytes.byteLength % 4)) % 4, 0x20),
  ]);
  const total = 12 + 8 + paddedJson.byteLength + 8 + binary.byteLength;
  const glb = Buffer.alloc(total);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(total, 8);
  glb.writeUInt32LE(paddedJson.byteLength, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(glb, 20);
  const binaryHeader = 20 + paddedJson.byteLength;
  glb.writeUInt32LE(binary.byteLength, binaryHeader);
  glb.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(glb, binaryHeader + 8);
  return glb;
}

function mutateGlbJson(
  source: Uint8Array,
  mutate: (json: Record<string, unknown>) => void,
): Uint8Array {
  const input = Buffer.from(source);
  const jsonLength = input.readUInt32LE(12);
  const json = JSON.parse(
    input
      .subarray(20, 20 + jsonLength)
      .toString("utf8")
      .trim(),
  ) as Record<string, unknown>;
  mutate(json);
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const paddedJson = Buffer.concat([
    jsonBytes,
    Buffer.alloc((4 - (jsonBytes.byteLength % 4)) % 4, 0x20),
  ]);
  const oldBinaryHeader = 20 + jsonLength;
  const binaryLength = input.readUInt32LE(oldBinaryHeader);
  const binary = input.subarray(oldBinaryHeader + 8, oldBinaryHeader + 8 + binaryLength);
  const total = 12 + 8 + paddedJson.byteLength + 8 + binary.byteLength;
  const output = Buffer.alloc(total);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(total, 8);
  output.writeUInt32LE(paddedJson.byteLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(output, 20);
  const binaryHeader = 20 + paddedJson.byteLength;
  output.writeUInt32LE(binary.byteLength, binaryHeader);
  output.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(output, binaryHeader + 8);
  return output;
}

function mutateGlbBinary(
  source: Uint8Array,
  minimumBytes: number,
  mutate: (binary: Buffer) => void,
): Uint8Array {
  const output = Buffer.from(source);
  const jsonLength = output.readUInt32LE(12);
  const binaryHeader = 20 + jsonLength;
  const binaryLength = output.readUInt32LE(binaryHeader);
  assert.ok(binaryLength >= minimumBytes);
  const binary = output.subarray(binaryHeader + 8, binaryHeader + 8 + binaryLength);
  mutate(binary);
  return output;
}

function solidPng(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) raw[row * (width * 4 + 1)] = 0;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name, "ascii");
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  type.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([type, data])), result.length - 4);
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
