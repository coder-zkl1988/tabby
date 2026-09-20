import { A2UIRenderer } from "@/lib/a2ui";
import { setTypePinned } from "@/lib/a2ui/a2ui-pin-store";
import {
  type PinnedSurface,
  unpinSurface,
} from "@/lib/a2ui/a2ui-pinned-panel-store";
import { PinOff } from "lucide-react";

/**
 * Right-sidebar panel holding the surfaces the user pinned from chat.
 *
 * Plain vertical stack on purpose: the point of pinning is that the card stays
 * where you can see it, so it must not require panning or zooming the way a
 * canvas node does.
 */
export function PinnedA2UIPanel({
  sessionId,
  surfaces,
  onUnpin,
}: {
  /** Session these pins belong to — unpinning is scoped to it. */
  sessionId: string;
  surfaces: PinnedSurface[];
  onUnpin?: (surfaceId: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
      {surfaces.map((surface) => (
        <section
          key={surface.surfaceId}
          data-pinned-surface={surface.surfaceId}
          className="a2ui-inline-host rounded-[16px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] shadow-[0_6px_18px_rgba(15,23,42,0.04)]"
        >
          <header className="flex items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
            <span className="min-w-0 truncate text-[12px] font-medium text-[var(--color-text-secondary)]">
              {surface.title}
            </span>
            <button
              type="button"
              data-pinned-unpin={surface.surfaceId}
              title="取消固定"
              aria-label="取消固定"
              onClick={() => {
                // Clear the remembered type as well, otherwise the chat card
                // stays collapsed to a pointer: unpinning means "put it back
                // in the transcript", not just "take it out of the panel".
                setTypePinned(surface.pinKey, false);
                unpinSurface(sessionId, surface.surfaceId);
                onUnpin?.(surface.surfaceId);
              }}
              className="shrink-0 rounded-md p-1 text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]"
            >
              <PinOff size={13} />
            </button>
          </header>
          <div className="px-3 py-3">
            <A2UIRenderer
              messages={surface.messages}
              onAction={surface.onAction}
            />
          </div>
        </section>
      ))}
    </div>
  );
}
