import { useState, type FormEvent } from "react";
import { dashboardStore } from "../api-store";

interface PromptComposerProps {
  disabled: boolean;
}

export function PromptComposer({ disabled }: PromptComposerProps): React.JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError("Describe the Studio change you want to make.");
      return;
    }
    setError(undefined);
    try {
      await dashboardStore.submit({ action: "start", prompt: trimmed });
      setPrompt("");
    } catch {
      // The store publishes the bounded technical failure in the page-level
      // notice. Repeating an unbounded connector stack here makes the request
      // controls unreadable and adds no recovery information.
      setError("Request did not start. See the control-plane error above.");
    }
  }

  return (
    <form className="prompt-composer" onSubmit={submit}>
      <label htmlFor="creator-prompt">New request</label>
      <textarea
        id="creator-prompt"
        name="prompt"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Describe a bounded Studio change…"
        disabled={disabled}
        maxLength={16000}
      />
      <div className="prompt-composer__footer">
        <span className="field-message" aria-live="polite">
          {error ?? "Studio stays read-only until you approve a visible plan."}
        </span>
        <button type="submit" disabled={disabled}>
          Start request
        </button>
      </div>
    </form>
  );
}
