import { useSyncExternalStore } from "react";

export interface BrowserPanelState {
  isOpen: boolean;
  sessionKey: string | null;
  navigationRequest: BrowserNavigationRequest | null;
  /**
   * The agent opened this panel and is working in it.
   *
   * The workbench normally belongs to the conversation view and closes when you
   * navigate away. An agent's page does not: closing it mid-task would take the
   * work off screen and, because the panel is what places the browser view,
   * stop the agent's clicks from landing at all. Only an explicit close ends it.
   */
  openedByAgent: boolean;
}

export interface BrowserNavigationRequest {
  id: number;
  url: string;
  requestedAt: number;
}

const CLOSED_STATE: BrowserPanelState = {
  isOpen: false,
  sessionKey: null,
  navigationRequest: null,
  openedByAgent: false,
};

let state = CLOSED_STATE;
let nextNavigationRequestId = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBrowserPanelState(): BrowserPanelState {
  return state;
}

export function openBrowserPanel(sessionKey: string, byAgent = false): void {
  state = {
    isOpen: true,
    sessionKey,
    navigationRequest:
      state.sessionKey === sessionKey ? state.navigationRequest : null,
    openedByAgent: byAgent,
  };
  emit();
}

/**
 * Opens a user-requested URL without taking ownership away from an agent that
 * is already working in the browser panel.
 *
 * Switching tabs also takes the agent's page out of the placed browser view,
 * so no pinned panel can be retargeted safely. Callers can use the false return
 * value to fall back to the system browser.
 */
export function openUrlInBrowserPanel(
  sessionKey: string,
  url: string,
): boolean {
  if (state.openedByAgent) return false;

  nextNavigationRequestId += 1;
  state = {
    isOpen: true,
    sessionKey,
    navigationRequest: {
      id: nextNavigationRequestId,
      url,
      requestedAt: Date.now(),
    },
    openedByAgent:
      state.sessionKey === sessionKey ? state.openedByAgent : false,
  };
  emit();
  return true;
}

export function closeBrowserPanel(): void {
  if (!state.isOpen && state.sessionKey === null) return;
  state = CLOSED_STATE;
  emit();
}

/** Closes only a panel the user opened; an agent's panel survives routing. */
export function closeBrowserPanelForRouting(): boolean {
  if (state.openedByAgent) return false;
  closeBrowserPanel();
  return true;
}

/**
 * Show the panel only while its own conversation is on screen.
 *
 * The browser belongs to the session that opened it — above all to an agent
 * working in it — so another conversation must not display that page. Hiding
 * is safe even mid-task: collapsing the panel only hides the view, it is never
 * disposed, so the page, its login state and the agent's element refs survive
 * and the run keeps going off screen (see embedded-browser.tsx). Returning to
 * that session re-mounts the panel and resumes where it left off.
 *
 * `sessionKey` is the conversation now on screen, or null when none is.
 */
export function syncBrowserPanelToSession(sessionKey: string | null): void {
  const belongsHere =
    state.sessionKey !== null && state.sessionKey === sessionKey;
  if (state.isOpen === belongsHere) return;
  // Keep sessionKey/openedByAgent: they are what lets the panel come back when
  // its own session is opened again.
  state = { ...state, isOpen: belongsHere };
  emit();
}

/**
 * The agent's run is over: keep the panel open — the user may be reading the
 * result — but drop the pin, so it goes back to closing on navigation like
 * any other workbench. The pin exists to protect an agent mid-task; without a
 * release it outlives its purpose and glues the panel across routes forever.
 */
export function releaseAgentBrowserPanelPin(): void {
  if (!state.openedByAgent) return;
  state = { ...state, openedByAgent: false };
  emit();
}

export function closeBrowserPanelForSessionNavigation(
  previousPath: string | null,
  nextPath: string,
): boolean {
  if (previousPath === null || previousPath === nextPath) return false;
  return closeBrowserPanelForRouting();
}

export function useBrowserPanel(): BrowserPanelState {
  return useSyncExternalStore(
    subscribe,
    getBrowserPanelState,
    getBrowserPanelState,
  );
}

export function resetBrowserPanelForTests(): void {
  state = CLOSED_STATE;
  nextNavigationRequestId = 0;
  emit();
}
