import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityExplorer } from "./CapabilityExplorer";
import type { CapabilityExplorerSnapshot, PairedStudioState } from "../types";

const catalog: CapabilityExplorerSnapshot = {
  phase: "ready",
  summary: {
    kind: "StudioCatalogSummary",
    catalog: {
      hash: "a".repeat(64),
      source: {
        repository: "https://github.com/Roblox/creator-docs.git",
        commit: "0123456789abcdef",
        engineReferencePath: "content/en-us/reference/engine",
        sourceTreeHash: "b".repeat(64),
      },
      counts: { classes: 638 },
    },
    coverage: {
      hash: "c".repeat(64),
      catalogHash: "a".repeat(64),
      policyHash: "d".repeat(64),
      manifestHash: "e".repeat(64),
      summary: {
        total: 9_685,
        byDisposition: {
          authorable: 209,
          observable_only: 16,
          creator_reviewed: 0,
          source_only: 7_986,
          unsupported: 1_474,
        },
        byReason: {},
        authorableClasses: 33,
        authorableProperties: 183,
      },
      catalogBinding: "matched",
      manifestBinding: "matched",
    },
    manifest: {
      hash: "e".repeat(64),
      connectorBuildHash: "f".repeat(64),
      classCount: 9,
      writablePropertyCount: 14,
      roots: ["Workspace"],
      operationKinds: ["create", "update"],
    },
  },
  page: {
    kind: "StudioCapabilityExplorerPage",
    catalogHash: "a".repeat(64),
    coverageHash: "c".repeat(64),
    selection: { className: "Part" },
    page: { cursor: 0, limit: 40, total: 1 },
    entries: [
      {
        catalogEntryId: "class:Part/property:Anchored",
        entryKind: "class_property",
        owner: "Part",
        name: "Anchored",
        disposition: "authorable",
        reason: "proof_closed",
        authoringGroup: "parts",
        codec: "boolean",
        inheritedBy: ["MeshPart"],
        proofObligations: [
          "canonicalize",
          "validate",
          "preflight",
          "write",
          "read",
          "project",
          "compare",
        ],
        deprecated: false,
        tags: [],
        sourceFile: "classes/BasePart.yaml",
        sourceFileHash: "1".repeat(64),
        valueType: "boolean",
        security: { read: "None", write: "None" },
        serialization: { canLoad: true, canSave: true },
        threadSafety: "ReadSafe",
        capabilities: ["Physics"],
      },
    ],
  },
};

const pairedStudio: PairedStudioState = {
  status: "paired",
  manifestHash: "e".repeat(64),
  connectorBuildHash: "f".repeat(64),
  attestationStatus: "verified",
  attestation: {
    detail: "Every required reflection row was observed and matched by the backend verifier.",
    totalFacts: 183,
    observedFacts: 183,
    unavailableFacts: 0,
    readErrorFacts: 0,
    mismatchedFacts: 0,
    missingFacts: 0,
    findingsTruncated: false,
    findings: [],
  },
  message: "Studio is paired and attested.",
};

describe("CapabilityExplorer", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the catalog pin, attestation boundary, and authoring proof route", () => {
    render(
      <CapabilityExplorer
        catalog={catalog}
        pairedStudio={pairedStudio}
        onExplore={() => undefined}
      />,
    );

    expect(screen.getByText("9,685 cataloged API entries")).toBeVisible();
    expect(screen.getByText("Curated manifest attested")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Part.Anchored" })).toBeVisible();
    expect(screen.getByText("canonicalize")).toBeVisible();
    expect(screen.getByText("MeshPart")).toBeVisible();
    expect(screen.getByText("Anchored: boolean")).toBeVisible();
    expect(screen.getByText(/read None · write None/)).toBeVisible();
    expect(screen.getByText(/classes\/BasePart\.yaml/)).toBeVisible();
    expect(screen.getByText(/Source API is usable in Luau source/i)).toBeVisible();
    expect(screen.getByText("183/183")).toBeVisible();
    expect(screen.getByText("1,474")).toBeVisible();
    expect(screen.getByText("Source API")).toBeVisible();
    expect(screen.getByText("Observe")).toBeVisible();
    expect(screen.getByText("Restricted")).toBeVisible();
  });

  it("renders backend verifier findings verbatim and opens the retained raw artifact", async () => {
    const rejectedStudio: PairedStudioState = {
      ...pairedStudio,
      attestationStatus: "rejected",
      attestationArtifact: {
        locator: "studio-evidence/attestation-envelope.json",
        artifactHash: "9".repeat(64),
        bytes: 8_192,
      },
      attestation: {
        detail: "One reflected row has a type mismatch; no dashboard rule made this decision.",
        totalFacts: 183,
        observedFacts: 182,
        unavailableFacts: 0,
        readErrorFacts: 0,
        mismatchedFacts: 1,
        missingFacts: 0,
        findingsTruncated: false,
        findings: [
          {
            key: "reflection:project:Beam.Attachment0",
            code: "reflection_type_mismatch",
            expected: {
              catalogType: { category: "class", name: "Attachment" },
              reflection: {
                engineType: "RefType",
                scriptType: "Instance",
                instanceType: "Attachment",
              },
            },
            received: { engineType: "RefType", instanceType: "Attachment" },
          },
        ],
      },
      message: "Studio paired, but its capability attestation was rejected.",
    };

    render(
      <CapabilityExplorer
        catalog={catalog}
        pairedStudio={rejectedStudio}
        onExplore={() => undefined}
      />,
    );

    expect(screen.getByText("Connector attestation rejected")).toBeVisible();
    expect(screen.getByText("reflection_type_mismatch")).toBeVisible();
    expect(screen.getByText("reflection:project:Beam.Attachment0")).toBeVisible();
    expect(screen.getByText("catalogType.category")).toBeVisible();
    expect(screen.getByText("engineType")).toBeVisible();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ envelope: "exact raw evidence" }), {
            status: 200,
          }),
        ),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect raw attestation" }));
    expect(
      await screen.findByRole("heading", {
        name: "studio-evidence/attestation-envelope.json",
      }),
    ).toBeVisible();
    expect(await screen.findByText(/exact raw evidence/)).toBeVisible();
    expect(screen.getByText(/no dashboard rule made this decision/i)).toBeVisible();
  });

  it("withholds proof routes when coverage is not bound to the catalog and manifest", () => {
    const unboundCatalog: CapabilityExplorerSnapshot = {
      ...catalog,
      summary: {
        ...catalog.summary!,
        coverage: {
          ...catalog.summary!.coverage,
          catalogBinding: "mismatched",
        },
      },
    };

    render(
      <CapabilityExplorer
        catalog={unboundCatalog}
        pairedStudio={pairedStudio}
        onExplore={() => undefined}
      />,
    );

    expect(screen.getByText("Unbound")).toBeVisible();
    expect(screen.getByText("Coverage report is not bound")).toBeVisible();
    expect(screen.queryByText("Proof route")).not.toBeInTheDocument();
    expect(screen.queryByText("Curated manifest attested")).not.toBeInTheDocument();
  });

  it("withholds proof routes when coverage is not bound to the curated manifest", () => {
    const unboundCatalog: CapabilityExplorerSnapshot = {
      ...catalog,
      summary: {
        ...catalog.summary!,
        coverage: {
          ...catalog.summary!.coverage,
          manifestBinding: "mismatched",
        },
      },
    };

    render(
      <CapabilityExplorer
        catalog={unboundCatalog}
        pairedStudio={pairedStudio}
        onExplore={() => undefined}
      />,
    );

    expect(screen.getByText("Coverage report is not bound")).toBeVisible();
    expect(screen.queryByText("Proof route")).not.toBeInTheDocument();
  });

  it("does not mark a verified pair healthy without both connector identities", () => {
    const incompletePair: PairedStudioState = {
      status: "paired",
      attestationStatus: "verified",
      message: "Studio did not report its identity.",
    };

    render(
      <CapabilityExplorer
        catalog={catalog}
        pairedStudio={incompletePair}
        onExplore={() => undefined}
      />,
    );

    expect(screen.getByText("Connector identity incomplete")).toBeVisible();
    expect(screen.queryByText("Curated manifest attested")).not.toBeInTheDocument();
  });

  it("keeps incomplete evidence distinct from a verifier rejection", () => {
    const incompletePair: PairedStudioState = {
      ...pairedStudio,
      attestationStatus: "incomplete",
      attestation: {
        detail: "Capability attestation incomplete: reflection_unavailable.",
        totalFacts: 183,
        observedFacts: 182,
        unavailableFacts: 1,
        readErrorFacts: 0,
        mismatchedFacts: 0,
        missingFacts: 0,
        findingsTruncated: false,
        findings: [
          {
            key: "reflection:project:Trail.Attachment1",
            code: "reflection_unavailable",
            expected: {
              catalogType: { category: "class", name: "Attachment" },
              reflection: {
                engineType: "RefType",
                scriptType: "Instance",
                instanceType: "Attachment",
              },
            },
            received: {
              status: "unavailable",
              code: "reflection_property_unavailable",
            },
          },
        ],
      },
    };

    render(
      <CapabilityExplorer
        catalog={catalog}
        pairedStudio={incompletePair}
        onExplore={() => undefined}
      />,
    );

    expect(screen.getByText("Connector attestation incomplete")).toBeVisible();
    expect(screen.getByText("reflection_unavailable")).toBeVisible();
    expect(screen.queryByText("Connector attestation rejected")).not.toBeInTheDocument();
  });

  it("submits a bounded read-only search through the shared store callback", () => {
    const onExplore = vi.fn();
    render(<CapabilityExplorer catalog={catalog} pairedStudio={undefined} onExplore={onExplore} />);

    fireEvent.change(screen.getByLabelText("Class"), {
      target: { value: "ProximityPrompt" },
    });
    fireEvent.change(screen.getByLabelText("Find a capability"), {
      target: { value: "ActionText" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search coverage" }));

    expect(onExplore).toHaveBeenCalledWith({
      className: "ProximityPrompt",
      query: "ActionText",
    });
  });
});
