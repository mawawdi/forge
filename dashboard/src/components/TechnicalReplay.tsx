import { useState } from "react";
import { postTechnicalJson } from "./technical-api";
import type { CreatorConversationAttachment, CreatorConversationEvent } from "../types";

interface TechnicalReplayProps {
  readonly event: CreatorConversationEvent | undefined;
  readonly attachments: readonly CreatorConversationAttachment[];
}

/** Provider-free replay is inspection only; it never replaces creator authority. */
export function TechnicalReplay({
  event,
  attachments,
}: TechnicalReplayProps): React.JSX.Element | null {
  const verificationId = replayId(event, attachments, "verification");
  const mutationId = replayId(event, attachments, "mutation");
  const [result, setResult] = useState<string | undefined>();
  const [pending, setPending] = useState<"verification" | "mutation" | undefined>();

  if (!verificationId && !mutationId) return null;

  async function replay(kind: "verification" | "mutation", id: string): Promise<void> {
    setPending(kind);
    setResult(undefined);
    try {
      const response = await postTechnicalJson(
        kind === "verification"
          ? `/api/verifications/${encodeURIComponent(id)}/replay`
          : `/api/mutations/${encodeURIComponent(id)}/replay`,
      );
      setResult(JSON.stringify(response, null, 2));
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Forge could not replay this evidence.");
    } finally {
      setPending(undefined);
    }
  }

  return (
    <section className="detail-section" aria-labelledby="replay-title">
      <h3 id="replay-title">Replay evidence</h3>
      <p>
        These provider-free checks compare retained evidence only. They do not run Studio, call a
        model, or change this project.
      </p>
      <div className="technical-actions">
        {verificationId ? (
          <button
            type="button"
            disabled={pending !== undefined}
            onClick={() => void replay("verification", verificationId)}
          >
            {pending === "verification" ? "Replaying…" : "Replay verification"}
          </button>
        ) : null}
        {mutationId ? (
          <button
            type="button"
            disabled={pending !== undefined}
            onClick={() => void replay("mutation", mutationId)}
          >
            {pending === "mutation" ? "Replaying…" : "Replay mutation"}
          </button>
        ) : null}
      </div>
      {result ? (
        <pre className="technical-response" tabIndex={0} aria-live="polite">
          {result}
        </pre>
      ) : null}
    </section>
  );
}

function replayId(
  event: CreatorConversationEvent | undefined,
  attachments: readonly CreatorConversationAttachment[],
  role: "verification" | "mutation",
): string | undefined {
  if (role === "verification" && event?.eventType === "verification")
    return event.data.verification.id;
  if (role === "mutation" && event?.eventType === "mutation") return event.data.attemptId;
  return attachments.find((attachment) => attachment.role === role)?.binding.id;
}
