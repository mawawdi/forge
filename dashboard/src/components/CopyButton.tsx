import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export function CopyButton({
  text,
  label = "Copy message",
}: {
  readonly text: string;
  readonly label?: string;
}): React.JSX.Element {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="copy-button"
      aria-label={label}
      title={label}
      onClick={async () => {
        clearTimeout(timer.current);
        try {
          await navigator.clipboard.writeText(text);
          setStatus("copied");
        } catch {
          setStatus("error");
        }
        timer.current = setTimeout(() => setStatus("idle"), 2500);
      }}
    >
      <Icon name={status === "copied" ? "check" : "copy"} size={15} />
      <span className="sr-only" aria-live="polite">
        {status === "copied" ? "Copied" : status === "error" ? "Couldn't copy" : "Copy"}
      </span>
    </button>
  );
}
