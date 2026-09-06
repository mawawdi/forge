import { useLayoutEffect, useState } from "react";
import type { CreatorTurnRequest } from "../types";
import { Icon } from "./Icon";
import { ImageLightbox } from "./ImageLightbox";
import "./unconfirmed-messages.css";

export function UnconfirmedMessages({
  requests,
  rejectedKeys,
  canRestore,
  disabled,
  onRetry,
  onRestore,
}: {
  readonly requests: readonly CreatorTurnRequest[];
  readonly rejectedKeys: ReadonlySet<string>;
  readonly canRestore: (request: CreatorTurnRequest) => boolean;
  readonly disabled: boolean;
  readonly onRetry: (request: CreatorTurnRequest) => void;
  readonly onRestore: (request: CreatorTurnRequest) => void;
}): React.JSX.Element | null {
  const [preview, setPreview] = useState<
    | {
        readonly requestKey: string;
        readonly imageIndex: number;
        readonly opener: HTMLButtonElement;
      }
    | undefined
  >();
  const active = preview
    ? requests.find((request) => request.idempotencyKey === preview.requestKey)
        ?.visualObservations?.[preview.imageIndex]
    : undefined;
  useLayoutEffect(() => {
    if (preview && !active) setPreview(undefined);
  }, [active, preview]);
  if (!requests.length) return null;
  return (
    <section className="unconfirmed-messages" aria-label="Messages awaiting confirmation">
      <p>Your saved message and images are kept here until delivery is confirmed.</p>
      <ul>
        {requests.map((request, index) => (
          <li key={request.idempotencyKey}>
            <details>
              <summary>
                Review saved message{requests.length > 1 ? ` ${index + 1}` : ""}
                {request.visualObservations?.length
                  ? ` · ${request.visualObservations.length} ${request.visualObservations.length === 1 ? "image" : "images"}`
                  : ""}
              </summary>
              <div className="unconfirmed-messages__original">
                <p>{request.text}</p>
                {request.visualObservations?.length ? (
                  <ul className="unconfirmed-messages__images" aria-label="Saved images">
                    {request.visualObservations.map((observation, imageIndex) => (
                      <li key={imageIndex}>
                        <button
                          type="button"
                          className="unconfirmed-messages__preview"
                          aria-label={`Open saved image preview: ${observation.caption}`}
                          aria-haspopup="dialog"
                          onClick={(event) =>
                            setPreview({
                              requestKey: request.idempotencyKey,
                              imageIndex,
                              opener: event.currentTarget,
                            })
                          }
                        >
                          <img
                            src={`data:image/png;base64,${observation.image.base64}`}
                            alt={`Saved image ${imageIndex + 1}: ${observation.caption}`}
                            loading="lazy"
                          />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </details>
            {rejectedKeys.has(request.idempotencyKey) ? (
              <>
                <p className="unconfirmed-messages__recovery">
                  This message wasn't accepted.
                  {!canRestore(request)
                    ? " Send or clear your current draft to edit the saved message. Both are kept."
                    : " Restore it to edit and send again."}
                </p>
                <button
                  type="button"
                  disabled={disabled || !canRestore(request)}
                  onClick={() => onRestore(request)}
                >
                  Edit saved message{requests.length > 1 ? ` ${index + 1}` : ""}
                </button>
              </>
            ) : (
              <button type="button" disabled={disabled} onClick={() => onRetry(request)}>
                <Icon name="retry" size={16} />
                Retry saved message{requests.length > 1 ? ` ${index + 1}` : ""}
              </button>
            )}
          </li>
        ))}
      </ul>
      {active && preview ? (
        <ImageLightbox
          key={`${preview.requestKey}:${preview.imageIndex}`}
          src={`data:image/png;base64,${active.image.base64}`}
          alt={`Saved image ${preview.imageIndex + 1}: ${active.caption}`}
          opener={preview.opener}
          onClose={() => setPreview(undefined)}
        />
      ) : null}
    </section>
  );
}
