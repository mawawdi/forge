import { useEffect, useRef, useState } from "react";
import type { ComposerVisualAttachment } from "../visual-attachments";
import { Icon } from "./Icon";
import { ImageLightbox } from "./ImageLightbox";
import "./composer-visual-attachments.css";

interface Props {
  readonly attachments: readonly ComposerVisualAttachment[];
  readonly disabled: boolean;
  readonly error?: string | undefined;
  readonly onChange: (attachments: readonly ComposerVisualAttachment[]) => void;
}

export function ComposerVisualAttachments({
  attachments,
  disabled,
  error,
  onChange,
}: Props): React.JSX.Element | null {
  const [preview, setPreview] = useState<
    { readonly id: string; readonly opener: HTMLButtonElement } | undefined
  >();
  const list = useRef<HTMLUListElement>(null);
  const active = attachments.find((item) => item.id === preview?.id);
  useEffect(() => {
    if (preview && !active) setPreview(undefined);
  }, [active, preview]);
  if (!attachments.length && !error) return null;
  return (
    <div className="composer-visuals">
      {attachments.length ? (
        <ul
          ref={list}
          className="composer-visuals__list"
          aria-label="Attached images"
          onFocusCapture={(event) => {
            const target = event.target as HTMLElement;
            const box = target.getBoundingClientRect();
            const viewport = event.currentTarget.getBoundingClientRect();
            if (!box.width || !viewport.width) return;
            if (box.right > viewport.right - 4)
              event.currentTarget.scrollLeft += box.right - viewport.right + 4;
            else if (box.left < viewport.left + 4)
              event.currentTarget.scrollLeft += box.left - viewport.left - 4;
          }}
        >
          {attachments.map((item, index) => {
            return (
              <li key={item.id} className="composer-visuals__item">
                <button
                  type="button"
                  className="composer-visuals__preview"
                  aria-label={`Open image preview: ${item.name}`}
                  aria-haspopup="dialog"
                  onClick={(event) => setPreview({ id: item.id, opener: event.currentTarget })}
                >
                  <img
                    src={`data:image/png;base64,${item.observation.image.base64}`}
                    width={item.width}
                    height={item.height}
                    alt={`Preview of ${item.name}`}
                  />
                </button>
                <button
                  type="button"
                  className="composer-visuals__remove"
                  aria-label={`Remove ${item.name}`}
                  disabled={disabled}
                  onClick={() => {
                    onChange(attachments.filter((entry) => entry.id !== item.id));
                    if (preview?.id === item.id) setPreview(undefined);
                    const buttons = list.current?.querySelectorAll<HTMLButtonElement>(
                      ".composer-visuals__remove",
                    );
                    (
                      buttons?.[index + 1] ??
                      buttons?.[index - 1] ??
                      document.querySelector<HTMLButtonElement>(".composer-attach-control button")
                    )?.focus();
                  }}
                >
                  <Icon name="close" size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {active && preview ? (
        <ImageLightbox
          key={active.id}
          src={`data:image/png;base64,${active.observation.image.base64}`}
          alt={`Preview of ${active.name}`}
          opener={preview.opener}
          onClose={() => setPreview(undefined)}
        />
      ) : null}
      {error ? (
        <p className="composer-visuals__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
