import { z } from "zod";
import { stableJson } from "../../contracts/src/index.js";
import { boundedAttemptValue, readAttemptValue } from "./component-repair.js";

/** Diagnostic locations come from the exact current schema, never parsed error prose. */
export function creatorComponentIssueDetails(
  schema: z.ZodType,
  input: unknown,
  selectedPath: readonly (string | number)[] = ["component"],
) {
  const parsed = schema.safeParse(input);
  const collected: Array<{
    path: Array<string | number>;
    code: string;
    message: string;
    current: ReturnType<typeof boundedAttemptValue> | { status: "missing" };
    operations: Array<"replace" | "remove" | "add">;
  }> = [];
  const selector = (path: readonly PropertyKey[]) =>
    (path.length === 1 && ["kind", "type", "role", "context", "check"].includes(String(path[0]))) ||
    (path.length === 2 &&
      ((path[0] === "definition" && ["id", "abi", "hash"].includes(String(path[1]))) ||
        (path[0] === "content" && path[1] === "kind") ||
        (path[0] === "placement" && ["kind", "className"].includes(String(path[1])))));
  const add = (issue: z.core.$ZodIssue, path: readonly PropertyKey[], remove = false) => {
    if (path.some((key) => typeof key !== "string" && typeof key !== "number")) return;
    const location = path as Array<string | number>;
    const current = readAttemptValue(input, location);
    const parent = readAttemptValue(input, location.slice(0, -1));
    const guarded =
      location[0] !== "component" ||
      location.length < 2 ||
      location.length > 32 ||
      location.some((key) =>
        typeof key === "string"
          ? key.length === 0 ||
            key.length > 128 ||
            ["__proto__", "prototype", "constructor"].includes(key)
          : !Number.isInteger(key) || key < 0 || key > 65535,
      ) ||
      ["id", "kind", "definition"].includes(String(location[1]));
    collected.push({
      path: location,
      code: issue.code,
      message: issue.message,
      current: current.present ? boundedAttemptValue(current.value) : { status: "missing" },
      operations: guarded
        ? []
        : current.present
          ? [remove ? "remove" : "replace"]
          : parent.present &&
              parent.value !== null &&
              typeof parent.value === "object" &&
              !Array.isArray(parent.value)
            ? ["add"]
            : [],
    });
  };
  const visit = (issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[]) => {
    for (const issue of issues) {
      const path = [...prefix, ...issue.path];
      if (issue.code === "invalid_union") {
        // A branch is excluded only by a supplied literal/enum discriminator that
        // contradicts it, matching public validation's existing branch selection.
        const candidates = issue.errors.filter(
          (branch) =>
            !branch.some((nested) => {
              if (nested.code !== "invalid_value" || !selector(nested.path)) return false;
              const value = readAttemptValue(input, [...path, ...nested.path]);
              return (
                value.present && !nested.values.some((allowed) => Object.is(allowed, value.value))
              );
            }),
        );
        for (const branch of candidates.length ? candidates : issue.errors) visit(branch, path);
      } else if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) add(issue, [...path, key], true);
      } else add(issue, path);
    }
  };
  if (!parsed.success) visit(parsed.error.issues, []);
  const related = collected.filter((issue) =>
    selectedPath
      .slice(0, Math.min(selectedPath.length, issue.path.length))
      .every((key, index) => key === issue.path[index]),
  );
  const unique = [...new Map(related.map((issue) => [stableJson(issue), issue])).values()];
  let bytes = 0;
  const items = [];
  for (const issue of unique) {
    const next = Buffer.byteLength(stableJson(issue), "utf8");
    if (items.length === 32 || bytes + next > 8 * 1024) break;
    items.push(issue);
    bytes += next;
  }
  return { items, total: unique.length, omittedCount: unique.length - items.length };
}
