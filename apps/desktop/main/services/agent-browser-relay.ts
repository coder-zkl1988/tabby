import type {
  AgentBrowserCommand,
  AgentBrowserOutcome,
  AgentBrowserSnapshot,
} from "@nexu/shared";
import type { BrowserWindow } from "electron";
import {
  type CommandEnvelope,
  type PageState,
  buildObservation,
  drainFrames,
  parseCommandFrame,
  parseRunEndedFrame,
} from "./agent-browser-protocol";
import { agentTabId, embeddedBrowserManager } from "./embedded-browser-manager";

/**
 * Runs the agent's browser commands against the embedded browser.
 *
 *   nexu-browser plugin --POST /act--> controller --SSE--> here --> WebContentsView
 *                       <--------- POST /result <---------
 *
 * This lives in the main process, not the renderer, because the browser view
 * does. An earlier version made the panel component the executor so that a
 * closed panel could not act; in practice that meant collapsing the sidebar
 * destroyed the page mid-task, and a conversation held anywhere but the
 * workspace route — webchat, for one — had no executor at all. Visibility is
 * now carried by `open` raising the panel rather than by the executor's
 * lifetime.
 */

export type AgentBrowserRelayTiming = {
  /**
   * How long a navigation gets to *start* after an action before the page is
   * treated as having stayed put. Clicks that navigate begin the load well
   * inside this; clicks that only re-render answer after it.
   */
  quietMs: number;
  /**
   * How long a load that did start gets to finish before evidence is read
   * regardless. Must stay well inside the controller's 30s ceiling together
   * with the panel wait.
   */
  loadTimeoutMs: number;
  /** Paint time after the page settles, for frameworks that render async. */
  renderMs: number;
  /** Long enough for the panel to mount and place the view, short enough to
   * fail well inside the controller's own 30s ceiling. */
  panelWaitMs: number;
  reconnectDelayMs: number;
  /**
   * How long to wait for any frame before assuming the stream is dead.
   *
   * The controller pings every 15s. A restarted controller does not
   * necessarily break the socket — measured, the connection stayed open and
   * silent, so the relay sat reading from a stream that would never produce
   * anything and the agent's browser was simply gone until the desktop was
   * restarted. Silence, not socket errors, is what triggers the reconnect.
   */
  streamIdleTimeoutMs: number;
  /** The controller answers immediately when healthy; slower is stuck. */
  connectTimeoutMs: number;
};

const DEFAULT_TIMING: AgentBrowserRelayTiming = {
  quietMs: 300,
  loadTimeoutMs: 8_000,
  renderMs: 250,
  panelWaitMs: 4_000,
  reconnectDelayMs: 2_000,
  streamIdleTimeoutMs: 45_000,
  connectTimeoutMs: 8_000,
};

const NO_WINDOW =
  "the desktop window is not available right now — ask the user to bring Nexu to the front and try again";

const NO_PANEL =
  "the browser panel did not open, so there is nowhere the user could watch this happen — ask them to open a conversation in Nexu and try again. Reading the page still works.";

function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/u.test(trimmed)) return null;
  const hasScheme = /^https?:\/\//iu.test(trimmed);
  if (!hasScheme && /^[a-z][a-z\d+.-]*:/iu.test(trimmed)) return null;
  try {
    const url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export type AgentBrowserRelayOptions = {
  controllerBaseUrl: string;
  getWindow: () => BrowserWindow | null;
  /**
   * Raises the browser panel so the user sees the page the agent opened.
   * Carries the session that drove it and the tab id derived from it, so the
   * panel only adopts a page belonging to the conversation it is showing.
   */
  onOpen: (url: string, sessionKey: string, tabId: string) => void;
  /** The run that drove the browser ended; the panel's agent pin can go. */
  onRunEnded?: (sessionKey: string) => void;
  /**
   * Connection lifecycle, not just failures.
   *
   * A relay that has quietly stopped reconnecting is indistinguishable from
   * "the agent has no browser" from the transcript alone; the connect/end/fail
   * trail is what makes the difference readable.
   */
  onLog?: (message: string) => void;
  /** Test override; production uses the defaults. */
  timing?: Partial<AgentBrowserRelayTiming>;
};

export class AgentBrowserRelay {
  private abort: AbortController | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly timing: AgentBrowserRelayTiming;

  constructor(private readonly options: AgentBrowserRelayOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.abort?.abort();
    this.abort = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.timing.reconnectDelayMs);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const abort = new AbortController();
    this.abort = abort;
    // A connect that never answers has to time out too: the same replaced
    // controller can leave `fetch` itself hanging on a pooled connection.
    const connectTimer = setTimeout(
      () => abort.abort(),
      this.timing.connectTimeoutMs,
    );
    try {
      const response = await fetch(
        `${this.options.controllerBaseUrl}/api/v1/browser/agent/stream`,
        { headers: { accept: "text/event-stream" }, signal: abort.signal },
      );
      clearTimeout(connectTimer);
      if (!response.ok || !response.body) {
        throw new Error(`stream responded ${response.status}`);
      }
      this.options.onLog?.(`connected to ${this.options.controllerBaseUrl}`);
      await this.readStream(response.body);
      this.options.onLog?.("stream ended");
    } catch (error: unknown) {
      this.options.onLog?.(
        `stream failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(connectTimer);
      abort.abort();
    }
    this.scheduleReconnect();
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // The watchdog cancels the reader after silence. Cancelling closes the
    // stream, which resolves a pending `read()` as done even when the
    // underlying socket is wedged — measured: a replaced controller left the
    // socket open and silent, `reader.read()` never settled, and aborting the
    // fetch did not reach it. One resettable timer, not a `Promise.race`
    // against a deadline: the losing deadline promise of a race still rejects
    // later, and every such rejection is an unhandled one.
    let idleTimer: NodeJS.Timeout | null = null;
    const armWatchdog = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        this.options.onLog?.("stream idle, cancelling");
        void reader.cancel().catch(() => undefined);
      }, this.timing.streamIdleTimeoutMs);
    };
    try {
      armWatchdog();
      while (!this.stopped) {
        const chunk = await reader.read();
        if (chunk.done) return;
        armWatchdog();
        buffer += decoder.decode(chunk.value, { stream: true });
        const { frames, rest } = drainFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          const envelope = parseCommandFrame(frame);
          if (envelope) {
            void this.runAndReport(envelope);
            continue;
          }
          const runEnded = parseRunEndedFrame(frame);
          if (runEnded) this.options.onRunEnded?.(runEnded.sessionKey);
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      // The read may still be pending; cancelling releases the socket so the
      // reconnect does not stack a second stream on top of it.
      void reader.cancel().catch(() => undefined);
    }
  }

  private async runAndReport(envelope: CommandEnvelope): Promise<void> {
    let outcome: AgentBrowserOutcome;
    try {
      outcome = await this.run(envelope.command, envelope.sessionKey);
    } catch (error: unknown) {
      outcome = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      await fetch(
        `${this.options.controllerBaseUrl}/api/v1/browser/agent/result`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId: envelope.requestId, outcome }),
        },
      );
    } catch (error: unknown) {
      // The controller has its own timeout; a lost result surfaces there.
      this.options.onLog?.(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async run(
    command: AgentBrowserCommand,
    sessionKey: string,
  ): Promise<AgentBrowserOutcome> {
    // The agent's view is scoped to the session that drives it, so one
    // conversation's page never surfaces in another.
    const tabId = agentTabId(sessionKey);
    const owner = this.options.getWindow();
    if (!owner || owner.isDestroyed()) return { ok: false, error: NO_WINDOW };
    const sharingAllowed =
      typeof embeddedBrowserManager.isAgentSharingAllowed === "function"
        ? embeddedBrowserManager.isAgentSharingAllowed(owner)
        : true;
    if (!sharingAllowed) {
      return {
        ok: false,
        error:
          "browser sharing was revoked by the user — ask them to resume agent control in the Browser panel",
      };
    }

    /**
     * Gets the panel to host the view before acting on it.
     *
     * Clicks are only reliable in a panel-placed view: measured, a click into a
     * view the main process positioned itself is swallowed while the same click
     * into a panel-hosted view lands, and no amount of visibility, bounds,
     * focus or settling changed that.
     *
     * Failing here rather than placing the view as a fallback is deliberate.
     * The main process can only show a bare `WebContentsView` — no address bar,
     * no tabs, no header — which lands as a raw page pasted over the app that
     * the user can neither navigate nor dismiss, all to perform a click that
     * would have been swallowed anyway.
     */
    const ensureHosted = async (url: string): Promise<boolean> => {
      if (embeddedBrowserManager.isAgentTabPanelHosted(owner, tabId))
        return true;
      this.options.onOpen(url, sessionKey, tabId);
      return embeddedBrowserManager.waitForAgentTabPanel(
        owner,
        tabId,
        this.timing.panelWaitMs,
      );
    };

    // Where the page stands, without walking its tree: the URL and title are
    // all the evidence builder needs on each side of an action.
    const state = async (): Promise<PageState> => {
      const result = await embeddedBrowserManager.controlWindow(owner, {
        action: "state",
        tabId,
      });
      if (result?.kind !== "state") throw new Error("could not read the page");
      return { url: result.url, title: result.title };
    };

    const snapshot = async (options?: {
      maxNodes?: number;
      visibleOnly?: boolean;
    }): Promise<AgentBrowserSnapshot> => {
      const result = await embeddedBrowserManager.controlWindow(owner, {
        action: "snapshot",
        tabId,
        ...(options?.maxNodes !== undefined
          ? { maxNodes: options.maxNodes }
          : {}),
        ...(options?.visibleOnly !== undefined
          ? { visibleOnly: options.visibleOnly }
          : {}),
      });
      if (result?.kind !== "snapshot")
        throw new Error("could not read the page");
      const { kind: _kind, ...rest } = result;
      return rest;
    };

    if (command.action === "open") {
      const url = normalizeUrl(command.url);
      if (!url) return { ok: false, error: "invalid web address" };
      embeddedBrowserManager.ensureAgentTab(owner, tabId);
      await embeddedBrowserManager.controlWindow(owner, {
        action: "navigate",
        tabId,
        url,
      });
      if (!(await ensureHosted(url))) {
        return { ok: false, error: NO_PANEL };
      }
      return { ok: true, snapshot: await snapshot() };
    }
    if (command.action === "snapshot") {
      return {
        ok: true,
        snapshot: await snapshot({
          maxNodes: command.maxNodes,
          visibleOnly: command.visibleOnly,
        }),
      };
    }
    if (command.action === "screenshot") {
      // A hidden view captures nothing useful; the user has to be looking at
      // the same pixels the model gets.
      if (!(await ensureHosted((await state()).url))) {
        return { ok: false, error: NO_PANEL };
      }
      const result = await embeddedBrowserManager.controlWindow(owner, {
        action: "screenshot",
        tabId,
      });
      if (result?.kind !== "screenshot")
        throw new Error("could not capture the page");
      const { kind: _kind, ...image } = result;
      return { ok: true, screenshot: { ...(await state()), ...image } };
    }
    if (command.action === "scroll") {
      const before = await state();
      if (!(await ensureHosted(before.url))) {
        return { ok: false, error: NO_PANEL };
      }
      const result = await embeddedBrowserManager.controlWindow(owner, {
        action: "scroll",
        tabId,
        deltaY: command.deltaY,
      });
      if (result?.kind !== "scroll") throw new Error("could not scroll");
      return {
        ok: true,
        observation: buildObservation({
          before,
          after: await state(),
          settle: {
            navigated: false,
            inPageNavigated: false,
            loading: false,
            dialogs: [],
            pageErrors: [],
          },
          element: null,
          scroll: { y: result.y, maxY: result.maxY },
        }),
      };
    }

    const before = await state();
    if (!(await ensureHosted(before.url))) {
      return { ok: false, error: NO_PANEL };
    }
    // Watch from before the action: a navigation it starts must be caught
    // from its first event, or the read-back describes the page as it was.
    const watch = embeddedBrowserManager.watchAction(owner, tabId);
    switch (command.action) {
      case "click":
        await embeddedBrowserManager.controlWindow(owner, {
          action: "click-ref",
          tabId,
          ref: command.ref,
        });
        break;
      case "hover":
        await embeddedBrowserManager.controlWindow(owner, {
          action: "hover-ref",
          tabId,
          ref: command.ref,
        });
        break;
      case "type":
        await embeddedBrowserManager.controlWindow(owner, {
          action: "type-ref",
          tabId,
          ref: command.ref,
          text: command.text,
          submit: command.submit,
          append: command.append,
        });
        break;
      case "press":
        await embeddedBrowserManager.controlWindow(owner, {
          action: "press-key",
          tabId,
          key: command.key,
          ...(command.ref ? { ref: command.ref } : {}),
        });
        break;
      case "select":
        await embeddedBrowserManager.controlWindow(owner, {
          action: "select-ref",
          tabId,
          ref: command.ref,
          option: command.option,
        });
        break;
      case "navigate":
        await embeddedBrowserManager.controlWindow(owner, {
          action: "command",
          tabId,
          command: command.to,
        });
        break;
    }
    const settle = await watch.settle({
      quietMs: this.timing.quietMs,
      loadTimeoutMs: this.timing.loadTimeoutMs,
      renderMs: this.timing.renderMs,
    });
    const after = await state();

    // Read the acted-on element back and report it. This is the completion
    // evidence: a click that did nothing shows an unchanged element, and a
    // click that navigated shows a new URL and no element.
    const ref =
      "ref" in command && typeof command.ref === "string" ? command.ref : null;
    let element = null;
    if (ref && !settle.navigated) {
      const result = await embeddedBrowserManager.controlWindow(owner, {
        action: "describe-ref",
        tabId,
        ref,
      });
      element = result?.kind === "element" ? result.element : null;
    }
    return {
      ok: true,
      observation: buildObservation({ before, after, settle, element }),
    };
  }
}
