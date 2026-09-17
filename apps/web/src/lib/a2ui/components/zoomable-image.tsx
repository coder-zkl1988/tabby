import { X, ZoomIn } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";

const BADGE =
  "absolute right-1 top-1 z-10 grid h-6 w-6 place-items-center rounded-md bg-black/45 text-white opacity-80 backdrop-blur-[1px] transition-opacity hover:opacity-100 focus-visible:opacity-100";

/**
 * An image that opens full-size on click, with a magnifier badge as the
 * affordance.
 *
 * A2UI renders images at thumbnail sizes — generated avatars, phone
 * screenshots — where the detail that matters (a 小红书号, a face) is not
 * legible until enlarged. Deliberately self-contained: no portal, no extra
 * dependency, so any a2ui component can use it.
 *
 * `overlay` mode renders only the badge, for thumbnails whose own click is
 * already spoken for (picking a candidate). Nested buttons are invalid HTML, so
 * the badge is a sibling of that control inside a `relative` box, not a child.
 */
export function ZoomableImage({
  src,
  alt,
  className,
  imgClassName,
  style,
  overlay = false,
  title,
}: {
  src: string;
  alt: string;
  /** Applied to the trigger, so callers keep control of the thumbnail box. */
  className?: string;
  imgClassName?: string;
  /** Applied to the thumbnail image, not the full-size preview. */
  style?: CSSProperties;
  /** Render only the magnifier badge; place inside a `relative` container. */
  overlay?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const label = alt ? `放大查看：${alt}` : "放大查看";

  return (
    <>
      {overlay ? (
        <button
          type="button"
          className={`${BADGE} ${className ?? ""}`}
          title={title ?? "放大查看"}
          aria-label={label}
          onClick={() => setOpen(true)}
        >
          <ZoomIn size={13} aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          className={`relative ${className ?? ""}`}
          title={title ?? "放大查看"}
          aria-label={label}
          onClick={() => setOpen(true)}
        >
          <img src={src} alt={alt} className={imgClassName} style={style} />
          <span className={BADGE} aria-hidden="true">
            <ZoomIn size={13} />
          </span>
        </button>
      )}
      {open ? (
        <div
          data-testid="image-lightbox"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
        >
          {/* The backdrop is a real button so dismissing it is keyboard- and
              screen-reader-reachable, instead of a click-only div. */}
          <button
            type="button"
            aria-label="点击背景关闭预览"
            className="absolute inset-0 cursor-zoom-out"
            onClick={() => setOpen(false)}
          />
          <img
            src={src}
            alt={alt}
            className="relative max-h-full max-w-full rounded-md object-contain"
          />
          <button
            type="button"
            aria-label="关闭预览"
            title="关闭预览"
            className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-md bg-black/50 text-white hover:bg-black/70"
            onClick={() => setOpen(false)}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );
}
