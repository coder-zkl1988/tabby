import { A2UIRenderer } from "@/lib/a2ui";
import type { A2UIMessage } from "@/lib/a2ui";
import {
  isPinnedType,
  setTypePinned,
  subscribePinnedTypes,
  surfacePinKey,
} from "@/lib/a2ui/a2ui-pin-store";
import { isSurfacePinned } from "@/lib/a2ui/a2ui-pinned-panel-store";
import { surfaceIds } from "@/lib/chat/chat-a2ui-surfaces";
import { PanelRight, Pin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Inline A2UI host with a pin control.
 *
 * Chat cards scroll away, and the XHS ops flow makes the user hunt back up the
 * transcript for the planner every time. Pinning moves the surface onto the
 * canvas workbench, which stays put.
 *
 * While pinned the inline copy collapses to a one-line pointer instead of
 * rendering a second A2UIRenderer: each renderer builds its OWN surface
 * manager and data model, so two live copies would drift apart on any form
 * input and both would post `onAction` back to the agent.
 */
export function InlineA2UIHost({
  messages,
  onA2UIAction,
  onPin,
}: {
  messages: A2UIMessage[];
  onA2UIAction?: (actionName: string, context: Record<string, unknown>) => void;
  onPin?: (messages: A2UIMessage[]) => void;
}) {
  const { t } = useTranslation();
  const pinKey = surfacePinKey(messages);
  const [pinned, setPinned] = useState(() => isPinnedType(pinKey));

  // Latest-value refs: `onPin` is defined inline by the transcript renderer and
  // `messages` is rebuilt every render, so depending on either would re-run the
  // auto-pin effect on every commit. Pinning calls into the canvas store, whose
  // setState re-renders this tree — that loop is what blew the React update
  // depth limit and took the desktop app down.
  const onPinRef = useRef(onPin);
  onPinRef.current = onPin;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  /** surfaceId already auto-pinned, so a re-render never pins it twice. */
  const autoPinnedRef = useRef<string | null>(null);

  useEffect(
    () => subscribePinnedTypes(() => setPinned(isPinnedType(pinKey))),
    [pinKey],
  );

  // Remembered pin: a later card of the same component type lands pinned and
  // goes straight to the workbench. Depends on `pinned` alone.
  useEffect(() => {
    if (!pinned) {
      // Unpinned again: forget which surface was auto-pinned so a later pin
      // is not swallowed by the idempotence guard below.
      autoPinnedRef.current = null;
      return;
    }
    const [surfaceId] = surfaceIds(messagesRef.current);
    if (!surfaceId || autoPinnedRef.current === surfaceId) return;
    autoPinnedRef.current = surfaceId;
    if (isSurfacePinned(surfaceId)) return;
    onPinRef.current?.(messagesRef.current);
  }, [pinned]);

  if (pinned) {
    return (
      <button
        type="button"
        data-a2ui-pinned-pointer={pinKey ?? ""}
        onClick={() => onPin?.(messages)}
        className="mt-1 inline-flex max-w-full items-center gap-2 rounded-2xl border border-border bg-surface-1 px-3.5 py-2.5 text-[13px] transition-colors hover:bg-surface-2"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-[var(--color-info-subtle)] text-[var(--color-info)]">
          <PanelRight className="size-[14px]" />
        </span>
        <span className="min-w-0 truncate font-medium text-text-primary">
          {t("sessions.chat.pinnedToWorkbench", {
            defaultValue: "Pinned to workbench",
          })}
        </span>
        <span className="shrink-0 text-[11px] font-medium text-[var(--color-info)]">
          {t("sessions.chat.showPinned", { defaultValue: "Show" })}
        </span>
      </button>
    );
  }

  return (
    <div className="group/a2ui relative mt-1 w-full min-w-[20rem] max-w-full">
      {onPin && (
        <button
          type="button"
          data-a2ui-pin-trigger={pinKey ?? ""}
          title={t("sessions.chat.pinToWorkbench", {
            defaultValue: "Pin to workbench",
          })}
          aria-label={t("sessions.chat.pinToWorkbench", {
            defaultValue: "Pin to workbench",
          })}
          onClick={() => {
            // A surface with a component type flips the remembered pin and the
            // effect above does the pinning, so the two paths never both fire.
            // Without one (nothing stable to remember), pin this card only.
            if (pinKey) setTypePinned(pinKey, true);
            else onPin(messages);
          }}
          className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-lg border border-border bg-surface-1 text-text-muted opacity-0 shadow-sm transition-opacity hover:text-text-primary focus-visible:opacity-100 group-hover/a2ui:opacity-100"
        >
          <Pin className="size-[14px]" />
        </button>
      )}
      {/* a2ui-inline-host: when the surface is a single self-framed card
          (CardShell, TeamRunCard, …) a2ui.css drops this padding so the card
          hugs the bubble instead of drawing a second border inside it —
          worth ~32px of usable width. Mixed surfaces keep it. */}
      <div className="a2ui-inline-host w-full rounded-[20px] border border-border bg-surface-1 px-4 py-4 shadow-[0_10px_24px_rgba(15,23,42,0.04)]">
        <A2UIRenderer messages={messages} onAction={onA2UIAction} />
      </div>
    </div>
  );
}
