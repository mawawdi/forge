import { useEffect, useState } from "react";
import type { ArtifactReference } from "../types";

interface RawArtifactViewerProps {
  artifact: ArtifactReference;
  onClose: () => void;
}

export default function RawArtifactViewer({ artifact, onClose }: RawArtifactViewerProps): React.JSX.Element {
  const [content, setContent] = useState("Loading immutable evidence…");

  useEffect(() => {
    const controller = new AbortController();
    void loadArtifact(artifact.artifactHash, controller.signal, setContent);
    return () => controller.abort();
  }, [artifact.artifactHash]);

  return (
    <section className="raw-evidence" aria-labelledby="raw-evidence-title">
      <div className="raw-evidence__heading">
        <div>
          <p className="eyebrow">Raw evidence</p>
          <h3 id="raw-evidence-title">{artifact.locator}</h3>
        </div>
        <button type="button" className="quiet-button" onClick={onClose}>Close</button>
      </div>
      <code className="raw-evidence__hash">sha256:{artifact.artifactHash}</code>
      <pre tabIndex={0}>{content}</pre>
    </section>
  );
}

async function loadArtifact(hash: string, signal: AbortSignal, setContent: (value: string) => void): Promise<void> {
  try {
    const response = await fetch(`/api/artifacts/${encodeURIComponent(hash)}`, {
      credentials: "same-origin",
      signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(body || `Artifact request failed (${response.status}).`);
    try {
      setContent(JSON.stringify(JSON.parse(body) as unknown, null, 2));
    } catch {
      setContent(body);
    }
  } catch (error) {
    if (signal.aborted) return;
    setContent(error instanceof Error ? error.message : "The artifact could not be loaded.");
  }
}
