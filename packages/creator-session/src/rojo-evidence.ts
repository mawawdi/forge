import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { RojoSourceOperation } from "../../project-authority/src/index.js";
import {
  studioProjectIndexMetadataView,
  type StudioProjectIndexCapture,
} from "../../studio-evidence/src/index.js";

export function rojoStudioNonSourceHash(
  view: ReturnType<typeof studioProjectIndexMetadataView>,
  operations: readonly RojoSourceOperation[] = [],
): string {
  const created = operations.filter(
    (operation): operation is Extract<RojoSourceOperation, { readonly kind: "create_source" }> =>
      operation.kind === "create_source",
  );
  const instances = [
    ...view.instances.map((instance) => ({
      path: instance.path,
      className: instance.className,
      properties: instance.properties,
      attributes: instance.attributes,
      tags: instance.tags,
    })),
    ...created.map((operation) => ({
      path: `${operation.parentStudioPath}/${operation.name}`,
      className: operation.className,
      properties: {},
      attributes: {},
      tags: [],
    })),
  ].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.className.localeCompare(right.className),
  );
  const scripts = [
    ...view.scripts.map((script) => ({
      path: script.path,
      className: script.className,
      executionContext: script.executionContext,
    })),
    ...created.map((operation) => ({
      path: `${operation.parentStudioPath}/${operation.name}`,
      className: operation.className,
      executionContext:
        operation.className === "Script"
          ? ("server" as const)
          : operation.className === "LocalScript"
            ? ("client" as const)
            : ("shared" as const),
    })),
  ].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.className.localeCompare(right.className),
  );
  return contentHash(stableJson({ instances, scripts }));
}

export function rojoSyncObservation(
  capture: StudioProjectIndexCapture,
  expectedEntries: readonly {
    readonly studioPath: string;
    readonly className: "Script" | "LocalScript" | "ModuleScript";
    readonly sourceHash: string;
  }[],
) {
  const view = studioProjectIndexMetadataView(capture);
  const scripts = new Map(
    view.scripts.map((script) => [`${script.path}\u0000${script.className}`, script] as const),
  );
  const sourceEntries = expectedEntries.flatMap((expected) => {
    const actual = scripts.get(`${expected.studioPath}\u0000${expected.className}`);
    return actual
      ? [
          {
            studioPath: expected.studioPath,
            className: expected.className,
            sourceHash: actual.sourceHash,
          },
        ]
      : [];
  });
  return {
    complete: true,
    studioRevisionHash: capture.revision.hash,
    nonSourceStateHash: rojoStudioNonSourceHash(view),
    sourceEntries,
  };
}
