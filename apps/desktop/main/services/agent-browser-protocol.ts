import type {
  AgentBrowserCommand,
  AgentBrowserDialog,
  AgentBrowserObservation,
  AgentBrowserPageError,
  AgentBrowserSnapshotNode,
} from "@nexu/shared";

/**
 * Wire and evidence helpers for agent browser control, kept free of Electron
 * imports so they can be tested without a running app.
 */

export type CommandEnvelope = {
  requestId: string;
  sessionKey: string;
  command: AgentBrowserCommand;
};

/** Parses one SSE frame, returning an envelope only for `command` events. */
export function parseCommandFrame(frame: string): CommandEnvelope | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (event !== "command" || data.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(data.join("\n"));
    if (!parsed || typeof parsed !== "object") return null;
    const { requestId, sessionKey, command } = parsed as CommandEnvelope;
    if (typeof requestId !== "string" || typeof sessionKey !== "string") {
      return null;
    }
    if (!command || typeof command !== "object") return null;
    return { requestId, sessionKey, command };
  } catch {
    return null;
  }
}

/** Parses one SSE frame, returning a session key only for `run-ended` events. */
export function parseRunEndedFrame(
  frame: string,
): { sessionKey: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (event !== "run-ended" || data.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(data.join("\n"));
    if (!parsed || typeof parsed !== "object") return null;
    const { sessionKey } = parsed as { sessionKey?: unknown };
    return typeof sessionKey === "string" ? { sessionKey } : null;
  } catch {
    return null;
  }
}

/**
 * Splits a stream buffer into complete SSE frames, returning the unconsumed
 * remainder so the next chunk can finish a partial frame.
 */
export function drainFrames(buffer: string): {
  frames: string[];
  rest: string;
} {
  const frames: string[] = [];
  let rest = buffer;
  let boundary = rest.indexOf("\n\n");
  while (boundary !== -1) {
    frames.push(rest.slice(0, boundary));
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf("\n\n");
  }
  return { frames, rest };
}

export type PageState = { url: string; title: string };

/** What the tab watcher saw between the action and the evidence read. */
export type ActionSettleReport = {
  navigated: boolean;
  inPageNavigated: boolean;
  loading: boolean;
  dialogs: AgentBrowserDialog[];
  pageErrors: AgentBrowserPageError[];
};

export type ObservationInput = {
  before: PageState;
  after: PageState;
  settle: ActionSettleReport;
  /** The acted-on element as read back after the action; null when gone. */
  element: AgentBrowserSnapshotNode | null;
  scroll?: { y: number; maxY: number };
};

/**
 * Builds the evidence returned for a mutating command.
 *
 * `navigated` means the main frame moved to a new document, which is what
 * resets the ref table — so the element is reported only when the page stayed
 * put. Handing it back after a navigation would answer "here is what you
 * acted on" with whatever now occupies that id on the new page.
 *
 * `changedInPlace` covers the other way a page moves on: a pushState route,
 * an in-page search, a title swap. The document and its refs survive, but the
 * content the agent last read did not. Comparing the URL alone reported these
 * as "nothing happened".
 *
 * A URL that changed with no navigation event behind it is a navigation the
 * watcher missed (it started after the settle window closed); it is reported
 * as one, because the cheap mistake is an unneeded snapshot and the expensive
 * one is acting on a ref from a page that no longer exists.
 */
export function buildObservation(
  input: ObservationInput,
): AgentBrowserObservation {
  const { before, after, settle } = input;
  const urlChanged = before.url !== after.url;
  const navigated = settle.navigated || (urlChanged && !settle.inPageNavigated);
  const changedInPlace =
    !navigated &&
    (settle.inPageNavigated || urlChanged || before.title !== after.title);
  const element = navigated ? null : input.element;
  return {
    url: after.url,
    title: after.title,
    ...(element ? { element } : {}),
    navigated,
    ...(changedInPlace ? { changedInPlace } : {}),
    ...(settle.loading ? { loading: true } : {}),
    ...(settle.dialogs.length > 0 ? { dialogs: settle.dialogs } : {}),
    ...(settle.pageErrors.length > 0 ? { pageErrors: settle.pageErrors } : {}),
    ...(input.scroll ? { scroll: input.scroll } : {}),
  };
}
