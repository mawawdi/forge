import { useEffect, useRef, useState } from "react";
import { VISUAL_OBSERVATION_INPUT_SCHEMA } from "../../../packages/visual-evidence/src/contracts.js";
import type { CreatorConversationAttachment } from "../types";
import {
  readVisualAttachment,
  VISUAL_ATTACHMENT_LIMITS,
  type ComposerVisualAttachment,
} from "../visual-attachments";
import { ImageLightbox } from "./ImageLightbox";
import "./conversation-visual-attachment.css";

const MAXIMUM_UPLOAD_JSON_BYTES = Math.ceil(VISUAL_ATTACHMENT_LIMITS.fileBytes / 3) * 4 + 16_384;

export function ConversationVisualAttachment({
  attachment,
  conversationId,
}: {
  readonly attachment: CreatorConversationAttachment;
  readonly conversationId: string;
}): React.JSX.Element {
  const container = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState<ComposerVisualAttachment | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [previewOpener, setPreviewOpener] = useState<HTMLButtonElement | undefined>();
  const [attempt, setAttempt] = useState(0);
  const hash = attachment.binding.artifact.artifactHash;
  const bytes = attachment.binding.artifact.bytes;
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setImage(undefined);
    setError(undefined);
    setPreviewOpener(undefined);
    void loadVisualUpload(hash, bytes, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setImage(value);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "This image could not be loaded.");
      });
    return () => controller.abort();
  }, [visible, hash, bytes, conversationId, attempt]);
  const observation = image?.observation;
  return (
    <figure className="conversation-visual" ref={container}>
      {image && observation ? (
        <>
          <button
            type="button"
            className="conversation-visual__preview"
            aria-label={`Open image preview: ${observation.caption}`}
            aria-haspopup="dialog"
            onClick={(event) => setPreviewOpener(event.currentTarget)}
          >
            <img
              src={`data:image/png;base64,${observation.image.base64}`}
              alt={observation.caption}
              width={image.width}
              height={image.height}
              loading="lazy"
            />
          </button>
          {previewOpener ? (
            <ImageLightbox
              src={`data:image/png;base64,${observation.image.base64}`}
              alt={observation.caption}
              opener={previewOpener}
              onClose={() => setPreviewOpener(undefined)}
            />
          ) : null}
        </>
      ) : error ? (
        <div className="conversation-visual__placeholder">
          <p role="status">{error}</p>
          <button type="button" onClick={() => setAttempt(attempt + 1)}>
            Retry image
          </button>
        </div>
      ) : (
        <div className="conversation-visual__placeholder">
          <span>{visible ? "Loading attached image…" : "Attached image"}</span>
        </div>
      )}
    </figure>
  );
}

async function loadVisualUpload(
  hash: string,
  expectedBytes: number,
  signal: AbortSignal,
): Promise<ComposerVisualAttachment> {
  if (
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > MAXIMUM_UPLOAD_JSON_BYTES
  )
    throw new Error("This attachment exceeds the image preview limits.");
  const response = await fetch(`/api/artifacts/${hash}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok)
    throw new Error(
      `This image could not be loaded (${response.status}). Retry when the connection is ready.`,
    );
  if (!response.body) throw new Error("This image response was empty. Retry loading it.");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAXIMUM_UPLOAD_JSON_BYTES) {
        await reader.cancel();
        throw new Error("This attachment exceeds the image preview limits.");
      }
      parts.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } catch {
    throw new Error("This attachment is not a readable creator image upload.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("kind" in value) ||
    value.kind !== "CreatorVisualUpload" ||
    !("source" in value) ||
    value.source !== "creator_upload" ||
    !("evidenceScope" in value) ||
    value.evidenceScope !== "creator_reported_visual" ||
    !("observation" in value) ||
    Object.keys(value).some(
      (key) => !["kind", "source", "evidenceScope", "observation"].includes(key),
    )
  )
    throw new Error("This attachment is not a creator image upload.");
  const parsed = VISUAL_OBSERVATION_INPUT_SCHEMA.safeParse(value.observation);
  if (!parsed.success) throw new Error("This attachment is not a readable creator PNG.");
  const observation = parsed.data;
  let binary: string;
  try {
    binary = atob(observation.image.base64);
  } catch {
    throw new Error("This attachment is not a readable creator PNG.");
  }
  const preview = await readVisualAttachment(
    new File([Uint8Array.from(binary, (char) => char.charCodeAt(0))], "Attached image.png", {
      type: "image/png",
    }),
  );
  return { ...preview, observation };
}
