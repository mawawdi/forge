import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import "./image-lightbox.css";

interface Props {
  readonly src: string;
  readonly alt: string;
  readonly opener: HTMLButtonElement;
  readonly onClose: () => void;
}

/** A read-only image preview. Native dialog owns modality and keyboard containment. */
export function ImageLightbox({ src, alt, opener, onClose }: Props): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef<() => void>(() => {});
  const finishClose = useRef<() => void>(() => {});
  const animateEntrance = useRef<() => void>(() => {});
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const modal = dialog.current!;
    const picture = image.current!;
    const backdrop = scrim.current!;
    const previousOverflow = document.body.style.overflow;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const animations = new Set<Animation>();
    let disposed = false;
    let closing = false;
    let entered = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    const animate = (element: HTMLElement, frames: Keyframe[], duration: number) => {
      if (reducedMotion || typeof element.animate !== "function") return undefined;
      const animation = element.animate(frames, {
        duration,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "both",
      });
      animations.add(animation);
      return animation;
    };
    const cancelAnimations = () => {
      for (const animation of animations) animation.cancel();
      animations.clear();
    };
    const originTransform = () => {
      const target = picture.getBoundingClientRect();
      const origin = opener.getBoundingClientRect();
      if (!opener.isConnected || !origin.width || !target.width || !target.height)
        return "scale(0.96)";
      const x = origin.left + origin.width / 2 - (target.left + target.width / 2);
      const y = origin.top + origin.height / 2 - (target.top + target.height / 2);
      const scale = Math.min(origin.width / target.width, origin.height / target.height);
      return `translate(${x}px, ${y}px) scale(${scale})`;
    };
    const finish = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(deadline);
      cancelAnimations();
      if (modal.open) modal.close();
      document.body.style.overflow = previousOverflow;
      if (opener.isConnected) opener.focus({ preventScroll: true });
      onCloseRef.current();
    };
    finishClose.current = finish;

    animateEntrance.current = () => {
      if (disposed || closing || entered || !picture.complete || !picture.naturalWidth) return;
      entered = true;
      animate(
        picture,
        [
          { transform: originTransform(), opacity: 0.35 },
          { transform: "none", opacity: 1 },
        ],
        260,
      );
    };
    close.current = () => {
      if (disposed || closing) return;
      closing = true;
      const currentImage = getComputedStyle(picture);
      const currentTransform = currentImage.transform;
      const currentOpacity = currentImage.opacity;
      const currentBackdropOpacity = getComputedStyle(backdrop).opacity;
      cancelAnimations();
      const exit = animate(
        picture,
        [
          { transform: currentTransform, opacity: currentOpacity },
          { transform: originTransform(), opacity: 0 },
        ],
        160,
      );
      animate(backdrop, [{ opacity: currentBackdropOpacity }, { opacity: 0 }], 160);
      if (!exit) {
        finish();
        return;
      }
      // Cleanup cannot depend on an animation event firing (background tabs, cancellation).
      deadline = setTimeout(finish, 200);
      void exit.finished.then(finish, () => {});
    };

    modal.showModal();
    document.body.style.overflow = "hidden";
    closeButton.current?.focus({ preventScroll: true });
    animate(backdrop, [{ opacity: 0 }, { opacity: 1 }], 200);
    animateEntrance.current();

    return () => {
      const wasDisposed = disposed;
      disposed = true;
      clearTimeout(deadline);
      cancelAnimations();
      animateEntrance.current = () => {};
      close.current = () => {};
      finishClose.current = () => {};
      if (modal.open) modal.close();
      if (!wasDisposed) {
        document.body.style.overflow = previousOverflow;
        if (opener.isConnected) opener.focus({ preventScroll: true });
      }
    };
  }, [opener, src]);

  return createPortal(
    <dialog
      ref={dialog}
      className="image-lightbox"
      aria-label="Image preview"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // A repeated native close request can bypass a cancelled dialog cancel
        // event. Keep both key presses in this exit's single lifecycle so focus
        // cannot return before its close callback has released the preview.
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }}
      onCancel={(event) => {
        event.preventDefault();
        close.current();
      }}
      onClose={() => {
        if (!dialog.current?.open) finishClose.current();
      }}
    >
      <div ref={scrim} className="image-lightbox__scrim" aria-hidden="true" />
      <div
        className="image-lightbox__stage"
        onClick={(event) => {
          if (event.target === event.currentTarget) close.current();
        }}
      >
        <img
          ref={image}
          className="image-lightbox__image"
          src={src}
          alt={alt}
          onLoad={() => animateEntrance.current()}
          draggable={false}
        />
      </div>
      <button
        ref={closeButton}
        className="image-lightbox__close"
        type="button"
        aria-label="Close image preview"
        onClick={() => close.current()}
      >
        <Icon name="close" size={22} />
      </button>
    </dialog>,
    document.body,
  );
}
