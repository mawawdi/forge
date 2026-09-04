import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CreatorProjectIdentity } from "../../creator-conversation/src/contracts.js";

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (name) => !/[\u0000-\u001f\u007f]/u.test(name),
    "Use a name without line breaks or control characters.",
  );
export const workspaceRenameSchema = z.strictObject({
  scope: z.enum(["project", "conversation"]),
  conversationId: z.string().min(1).max(256),
  name: nameSchema,
});
const labelsSchema = z.strictObject({
  projects: z.record(z.string(), nameSchema),
  conversations: z.record(z.string(), nameSchema),
});

export function workspaceProjectKey(project: CreatorProjectIdentity): string {
  return project.kind === "local_linked"
    ? `local:${project.forgeProjectId}`
    : `published:${project.universeId}:${project.placeId}`;
}

/** Cosmetic labels are separate from immutable conversation and Studio authority. */
export class WorkspaceLabels {
  private labels: z.infer<typeof labelsSchema> = { projects: {}, conversations: {} };
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}

  async load(): Promise<void> {
    const file = await open(
      join(this.directory, "workspace-labels.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!file) return;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
        throw new Error("Invalid workspace labels file.");
      this.labels = labelsSchema.parse(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
  }

  get(scope: "project" | "conversation", id: string): string | undefined {
    const labels = this.labels[scope === "project" ? "projects" : "conversations"];
    return Object.hasOwn(labels, id) ? labels[id] : undefined;
  }

  async set(scope: "project" | "conversation", id: string, name: string): Promise<void> {
    const operation = this.queue.then(async () => {
      const key = scope === "project" ? "projects" : "conversations";
      const next = { ...this.labels, [key]: { ...this.labels[key], [id]: nameSchema.parse(name) } };
      await mkdir(this.directory, { recursive: true });
      const temporary = join(this.directory, `.workspace-labels-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(next));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, join(this.directory, "workspace-labels.json"));
        this.labels = next;
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.queue = operation.catch(() => {});
    await operation;
  }
}
