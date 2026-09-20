import { useSyncExternalStore } from "react";
import type { A2UIMessage } from "./a2ui-types";

/**
 * Pinned A2UI surfaces shown in their own right sidebar panel.
 *
 * Deliberately NOT the canvas workbench: a pinned card should simply stay on
 * screen, and reaching it on the canvas means panning and zooming to find the
 * node. This panel just stacks the pinned surfaces, like the embedded browser
 * panel it sits beside.
 *
 * Scoped per session. A pinned card comes from one conversation's transcript,
 * so showing it while another conversation is open would put a stale artifact
 * on screen — the same reason the browser panel refuses to outlive its
 * session. Switching away hides the panel; switching back restores exactly
 * what that session had pinned.
 *
 * Payloads hold live `onAction` closures, so this store is runtime-only and
 * never persisted (which component TYPES auto-pin IS persisted — see
 * a2ui-pin-store).
 */

export interface PinnedSurface {
  surfaceId: string;
  title: string;
  messages: A2UIMessage[];
  onAction: (actionName: string, context: Record<string, unknown>) => void;
  /**
   * Component type this surface was remembered under (a2ui-pin-store key).
   * Carried here so unpinning can clear the remembered type too — otherwise
   * the chat card stays collapsed to a pointer and never comes back inline.
   */
  pinKey: string | null;
}

export interface PinnedPanelState {
  /** Open AND belonging to the session currently on screen. */
  isOpen: boolean;
  /** Surfaces pinned in the active session (empty for every other session). */
  surfaces: PinnedSurface[];
}

interface SessionPins {
  surfaces: PinnedSurface[];
  /** False after the user collapses the panel; pins survive for a re-open. */
  isOpen: boolean;
}

const EMPTY_STATE: PinnedPanelState = { isOpen: false, surfaces: [] };

const bySession = new Map<string, SessionPins>();
let activeSessionId: string | null = null;
/** Derived snapshot for the active session; useSyncExternalStore needs a stable identity. */
let snapshot: PinnedPanelState = EMPTY_STATE;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function recompute(): void {
  const pins = activeSessionId ? bySession.get(activeSessionId) : undefined;
  const isOpen = Boolean(pins?.isOpen && pins.surfaces.length > 0);
  const surfaces = pins?.surfaces ?? [];
  if (snapshot.isOpen === isOpen && snapshot.surfaces === surfaces) return;
  snapshot = isOpen || surfaces.length > 0 ? { isOpen, surfaces } : EMPTY_STATE;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPinnedPanelState(): PinnedPanelState {
  return snapshot;
}

/**
 * Point the panel at a session (null when no conversation is on screen).
 *
 * Called on every session route change: the panel then shows that session's
 * pins, or hides when it has none.
 */
export function setActivePinnedSession(sessionId: string | null): void {
  if (activeSessionId === sessionId) return;
  activeSessionId = sessionId;
  recompute();
}

export function getActivePinnedSession(): string | null {
  return activeSessionId;
}

/**
 * Pin a surface into a session (or refresh one already pinned there).
 *
 * Refreshing in place is what makes this safe to call from a render effect:
 * re-pinning an unchanged surface leaves the array identity alone, so
 * subscribers do not re-render in a loop.
 */
export function pinSurface(sessionId: string, surface: PinnedSurface): void {
  const pins = bySession.get(sessionId) ?? { surfaces: [], isOpen: false };
  const existing = pins.surfaces.find(
    (item) => item.surfaceId === surface.surfaceId,
  );
  if (existing) {
    const unchanged =
      existing.title === surface.title &&
      existing.messages === surface.messages &&
      existing.onAction === surface.onAction &&
      existing.pinKey === surface.pinKey;
    if (unchanged && pins.isOpen) return;
    bySession.set(sessionId, {
      isOpen: true,
      surfaces: unchanged
        ? pins.surfaces
        : pins.surfaces.map((item) =>
            item.surfaceId === surface.surfaceId ? surface : item,
          ),
    });
  } else {
    bySession.set(sessionId, {
      isOpen: true,
      surfaces: [...pins.surfaces, surface],
    });
  }
  recompute();
}

/** Remove one surface from a session; its panel closes when the last one goes. */
export function unpinSurface(sessionId: string, surfaceId: string): void {
  const pins = bySession.get(sessionId);
  if (!pins) return;
  const surfaces = pins.surfaces.filter((item) => item.surfaceId !== surfaceId);
  if (surfaces.length === pins.surfaces.length) return;
  bySession.set(sessionId, {
    surfaces,
    isOpen: surfaces.length > 0 && pins.isOpen,
  });
  recompute();
}

/** Collapse the active session's panel; its pins stay for the next open. */
export function closePinnedPanel(): void {
  if (!activeSessionId) return;
  const pins = bySession.get(activeSessionId);
  if (!pins?.isOpen) return;
  bySession.set(activeSessionId, { ...pins, isOpen: false });
  recompute();
}

export function openPinnedPanel(): void {
  if (!activeSessionId) return;
  const pins = bySession.get(activeSessionId);
  if (!pins || pins.isOpen || pins.surfaces.length === 0) return;
  bySession.set(activeSessionId, { ...pins, isOpen: true });
  recompute();
}

/** True when the active session already has this surface pinned. */
export function isSurfacePinned(surfaceId: string): boolean {
  return snapshot.surfaces.some((item) => item.surfaceId === surfaceId);
}

/** Pins belonging to a session, whether or not it is the active one. */
export function sessionHasPins(sessionId: string): boolean {
  return (bySession.get(sessionId)?.surfaces.length ?? 0) > 0;
}

/** Drop a session's pins entirely (conversation deleted). */
export function forgetPinnedSession(sessionId: string): void {
  if (!bySession.delete(sessionId)) return;
  recompute();
}

export function usePinnedPanel(): PinnedPanelState {
  return useSyncExternalStore(
    subscribe,
    getPinnedPanelState,
    getPinnedPanelState,
  );
}

export function resetPinnedPanelForTests(): void {
  bySession.clear();
  activeSessionId = null;
  snapshot = EMPTY_STATE;
  emit();
}
