import { BrowserWindow, Menu, WebContentsView, shell } from "electron";
import type {
  DesktopBrowserControl,
  DesktopBrowserControlResult,
  DesktopBrowserHistoryItem,
  DesktopBrowserViewportMode,
} from "../../shared/host";
import {
  type BrowserDialog,
  type BrowserPageError,
  BrowserRefTable,
  captureScreenshot,
  captureSnapshot,
  clickRef,
  describeRef,
  detachDebugger,
  hoverRef,
  pressKey,
  scrollBy,
  selectOption,
  trackPageEvents,
  typeIntoRef,
} from "./embedded-browser-cdp";

type ManagedTab = {
  owner: BrowserWindow;
  view: WebContentsView;
  navigationId: number;
  pendingUrl: string | null;
  pendingLoad: Promise<void> | null;
  refs: BrowserRefTable;
  /** Main-frame cross-document navigations so far; refs reset with each. */
  navigationEpoch: number;
  /** Main-frame same-document navigations (pushState, hash) so far. */
  inPageEpoch: number;
  /** Dialogs raised since the last settle read them. Agent tabs only. */
  dialogs: BrowserDialog[];
  /** Uncaught page errors since the last settle read them. Agent tabs only. */
  pageErrors: BrowserPageError[];
};

/**
 * Most page errors carried out of one action.
 *
 * A page that throws from a timer or a render loop can raise the same error
 * dozens of times inside one action window. The agent needs to know something
 * broke, not to read it forty times, so identical messages collapse and the
 * list stops here.
 */
const MAX_PAGE_ERRORS_PER_ACTION = 5;

/** How an agent action is waited out before its evidence is read. */
export type ActionSettleTiming = {
  /** How long a navigation gets to *start* after the action. */
  quietMs: number;
  /** How long a started load gets to finish before evidence is read anyway. */
  loadTimeoutMs: number;
  /** Paint time after the page settles, for frameworks that render async. */
  renderMs: number;
};

export type ActionSettle = {
  /** The main frame moved to a new document since the watch began. */
  navigated: boolean;
  /** The main frame changed URL without leaving the document. */
  inPageNavigated: boolean;
  /** A load was still in flight when the wait budget ran out. */
  loading: boolean;
  /** Dialogs the page raised in the meantime, in order. */
  dialogs: BrowserDialog[];
  /** Uncaught exceptions the page threw in the meantime, deduplicated. */
  pageErrors: BrowserPageError[];
};

export type ActionWatch = {
  settle: (timing: ActionSettleTiming) => Promise<ActionSettle>;
};

/** Resolves true when any of the events fires, false when the time runs out. */
function waitForAnyEvent(
  contents: Electron.WebContents,
  events: string[],
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    // Electron types each event name as its own overload; the listener takes
    // no arguments, so one nominal name satisfies the checker for all of them.
    const listeners = new Map<"did-stop-loading", () => void>();
    const finish = (fired: boolean): void => {
      clearTimeout(timer);
      for (const [event, listener] of listeners) {
        contents.removeListener(event, listener);
      }
      resolve(fired);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    for (const event of events) {
      const listener = (): void => finish(true);
      listeners.set(event as "did-stop-loading", listener);
      contents.on(event as "did-stop-loading", listener);
    }
  });
}

type ManagedDownload = {
  id: string;
  ownerId: number;
  filename: string;
  path: string;
  url: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  completedAt?: number;
};

const DEFAULT_SNAPSHOT_NODES = 400;

const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function normalizeBrowserZoomFactor(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0.25, value));
}

function chooseBrowserViewportMode(
  owner: BrowserWindow,
  currentMode: DesktopBrowserViewportMode,
  anchor: { x: number; y: number },
): Promise<DesktopBrowserControlResult> {
  return new Promise((resolve) => {
    let selectedMode = currentMode;
    const options: Array<{
      mode: DesktopBrowserViewportMode;
      label: string;
      sublabel?: string;
    }> = [
      { mode: "responsive", label: "响应式" },
      { mode: "mobile", label: "手机", sublabel: "375 × 812" },
      { mode: "tablet", label: "平板", sublabel: "768 × 1024" },
    ];
    const menu = Menu.buildFromTemplate(
      options.map((option) => ({
        type: "radio" as const,
        label: option.label,
        sublabel: option.sublabel,
        checked: option.mode === currentMode,
        click: () => {
          selectedMode = option.mode;
        },
      })),
    );
    const content = owner.getContentBounds();
    menu.popup({
      window: owner,
      x: Math.max(0, Math.min(Math.round(anchor.x), content.width)),
      y: Math.max(0, Math.min(Math.round(anchor.y), content.height)),
      positioningItem: Math.max(
        0,
        options.findIndex((option) => option.mode === currentMode),
      ),
      callback: () => resolve({ kind: "viewport", mode: selectedMode }),
    });
  });
}

function chooseBrowserHistoryArtifact(
  owner: BrowserWindow,
  items: DesktopBrowserHistoryItem[],
  anchor: { x: number; y: number },
): Promise<DesktopBrowserControlResult> {
  if (items.length === 0) {
    return Promise.resolve({ kind: "history", artifactId: null });
  }

  return new Promise((resolve) => {
    let selectedArtifactId: string | null = null;
    const menu = Menu.buildFromTemplate(
      items.map((item) => ({
        type: "radio" as const,
        label: item.label,
        sublabel: item.sublabel,
        checked: item.selected,
        click: () => {
          selectedArtifactId = item.id;
        },
      })),
    );
    const content = owner.getContentBounds();
    menu.popup({
      window: owner,
      x: Math.max(0, Math.min(Math.round(anchor.x), content.width)),
      y: Math.max(0, Math.min(Math.round(anchor.y), content.height)),
      positioningItem: Math.max(
        0,
        items.findIndex((item) => item.selected),
      ),
      callback: () =>
        resolve({ kind: "history", artifactId: selectedArtifactId }),
    });
  });
}

/**
 * Prefix of the tab an agent drives. The id must be derivable rather than
 * generated so the panel can adopt it after a remount: the renderer's tab ids
 * live in React state, which a collapsed panel throws away, while this tab
 * outlives it in the main process.
 *
 * It is derived from the session key rather than fixed, so one conversation's
 * page cannot surface in another. A single `"agent"` id made the agent's view
 * a process-wide singleton: every session that opened the panel adopted the
 * same tab, and the page outlived even the deletion of the conversation that
 * opened it.
 */
const AGENT_TAB_PREFIX = "agent-";

/**
 * How many agent tabs stay resident. Each is a full Chromium renderer, so
 * per-session isolation without a ceiling would grow the process count with
 * every conversation that ever touched the browser. Evicting the least
 * recently used one keeps recent sessions resumable at a bounded cost; an
 * evicted session simply opens a fresh page next time.
 */
const MAX_AGENT_TABS = 3;

/**
 * Stable, filesystem-safe id for a session's agent tab.
 *
 * FNV-1a over the session key: short, collision-resistant enough for the
 * handful of live sessions involved, and — unlike the raw key — guaranteed to
 * match TAB_ID_PATTERN.
 */
export function agentTabId(sessionKey: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionKey.length; i += 1) {
    hash ^= sessionKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${AGENT_TAB_PREFIX}${hash.toString(16).padStart(8, "0")}`;
}

export function isAgentTabId(tabId: string): boolean {
  return tabId.startsWith(AGENT_TAB_PREFIX);
}

function isSafeBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isAbortedNavigation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ERR_ABORTED");
}

function resolveOwnerWindow(sender: Electron.WebContents): BrowserWindow {
  let ownerContents = sender;
  while (ownerContents.hostWebContents) {
    ownerContents = ownerContents.hostWebContents;
  }
  const owner = BrowserWindow.fromWebContents(ownerContents);
  if (!owner || owner.isDestroyed()) {
    throw new Error("Could not resolve the browser host window.");
  }
  return owner;
}

function clampBounds(
  owner: BrowserWindow,
  bounds: { x: number; y: number; width: number; height: number },
): Electron.Rectangle {
  const content = owner.getContentBounds();
  const x = Math.max(0, Math.round(bounds.x));
  const y = Math.max(0, Math.round(bounds.y));
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(bounds.width), content.width - x)),
    height: Math.max(
      1,
      Math.min(Math.round(bounds.height), content.height - y),
    ),
  };
}

/**
 * A layout viewport for a tab the panel has not placed yet.
 *
 * Only ever applied while the view is hidden: a page still has to lay out at a
 * plausible size for a snapshot to describe what the user will eventually see.
 * The main process must not put the view *on screen* itself — with no address
 * bar, tabs or header it reads as a raw page pasted over the app, with no way
 * to navigate or dismiss it. Showing the view is the panel's job.
 */
function offscreenLayoutBounds(owner: BrowserWindow): Electron.Rectangle {
  const content = owner.getContentBounds();
  const width = Math.max(1, Math.round(content.width * 0.45));
  return {
    x: Math.max(0, content.width - width),
    y: 0,
    width,
    height: Math.max(1, content.height),
  };
}

const elementPickerScript = `new Promise((resolve) => {
  const marker = "data-nexu-element-picker";
  document.querySelector("[" + marker + "]")?.remove();
  const overlay = document.createElement("div");
  overlay.setAttribute(marker, "");
  Object.assign(overlay.style, {
    position: "fixed", pointerEvents: "none", zIndex: "2147483647",
    border: "2px solid #2563eb", background: "rgba(37,99,235,.12)", display: "none"
  });
  document.documentElement.append(overlay);
  const previousCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = "crosshair";
  const selectorFor = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      const classes = Array.from(current.classList).slice(0, 2);
      if (classes.length) part += classes.map((name) => "." + CSS.escape(name)).join("");
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const cleanup = () => {
    overlay.remove();
    document.documentElement.style.cursor = previousCursor;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
  const onMove = (event) => {
    const element = event.target;
    if (!(element instanceof Element) || element === overlay) return;
    const rect = element.getBoundingClientRect();
    Object.assign(overlay.style, { display: "block", left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
  };
  const onClick = (event) => {
    const element = event.target;
    if (!(element instanceof Element)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const result = {
      url: location.href,
      selector: selectorFor(element),
      tagName: element.tagName.toLowerCase(),
      text: (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 1200),
      ariaLabel: (element.getAttribute("aria-label") || "").slice(0, 300)
    };
    cleanup();
    resolve(result);
  };
  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    cleanup();
    resolve(null);
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
})`;

export class EmbeddedBrowserManager {
  private readonly tabs = new Map<string, ManagedTab>();
  private readonly downloads = new Map<string, ManagedDownload>();
  private readonly trackedSessions = new WeakSet<Electron.Session>();
  private readonly revokedAgentSharing = new Set<number>();
  /**
   * Windows whose panel is currently hosting the agent tab.
   *
   * Synthesized clicks are only reliable in a view the panel has placed:
   * measured, the first click into a view the manager positioned itself is
   * swallowed, while every click into a panel-hosted view lands. So mutating
   * commands wait for this rather than acting into a view that will silently
   * ignore them.
   */
  private readonly panelHosted = new Set<string>();
  private readonly panelWaiters = new Map<string, Set<() => void>>();
  /**
   * Agent tab keys in least-recently-used order (most recent last). Drives
   * MAX_AGENT_TABS eviction.
   */
  private readonly agentTabUse: string[] = [];

  isAgentTabPanelHosted(owner: BrowserWindow, tabId: string): boolean {
    return this.panelHosted.has(this.key(owner, tabId));
  }

  isAgentSharingAllowed(owner: BrowserWindow): boolean {
    return !this.revokedAgentSharing.has(owner.id);
  }

  /** Resolves true once the panel places that agent tab, false on timeout. */
  waitForAgentTabPanel(
    owner: BrowserWindow,
    tabId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.isAgentTabPanelHosted(owner, tabId)) return Promise.resolve(true);
    const waiterKey = this.key(owner, tabId);
    return new Promise((resolve) => {
      const waiters = this.panelWaiters.get(waiterKey) ?? new Set();
      const settle = (): void => {
        clearTimeout(timer);
        waiters.delete(settle);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiters.delete(settle);
        resolve(false);
      }, timeoutMs);
      waiters.add(settle);
      this.panelWaiters.set(waiterKey, waiters);
    });
  }

  /**
   * Records which agent tab the panel is currently hosting.
   *
   * Only one tab can be placed at a time, so hosting one clears the rest:
   * a stale "hosted" for another session's tab would let a command act into a
   * view that is not on screen, where synthesized clicks are swallowed.
   */
  private markPanelHosted(
    owner: BrowserWindow,
    hostedTabId: string | null,
  ): void {
    const prefix = `${owner.id}:`;
    for (const hosted of [...this.panelHosted]) {
      if (hosted.startsWith(prefix)) this.panelHosted.delete(hosted);
    }
    if (hostedTabId === null) return;
    const key = this.key(owner, hostedTabId);
    this.panelHosted.add(key);
    const waiters = this.panelWaiters.get(key);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter();
  }

  private key(owner: BrowserWindow, tabId: string): string {
    if (!TAB_ID_PATTERN.test(tabId)) throw new Error("Invalid browser tab id.");
    return `${owner.id}:${tabId}`;
  }

  /** Destroys one tab and forgets every piece of bookkeeping that named it. */
  private destroyTab(key: string): void {
    const tab = this.tabs.get(key);
    if (tab) {
      detachDebugger(tab.view.webContents);
      tab.owner.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      this.tabs.delete(key);
    }
    this.panelHosted.delete(key);
    this.panelWaiters.delete(key);
    const index = this.agentTabUse.indexOf(key);
    if (index !== -1) this.agentTabUse.splice(index, 1);
  }

  /**
   * Marks an agent tab as most recently used and evicts past MAX_AGENT_TABS.
   *
   * The hosted tab is never evicted: it is the one currently on screen, and
   * tearing it out from under a running command would strand the agent.
   */
  private touchAgentTab(key: string): void {
    const index = this.agentTabUse.indexOf(key);
    if (index !== -1) this.agentTabUse.splice(index, 1);
    this.agentTabUse.push(key);
    while (this.agentTabUse.length > MAX_AGENT_TABS) {
      const victim = this.agentTabUse.find(
        (candidate) => !this.panelHosted.has(candidate),
      );
      if (victim === undefined) break;
      this.destroyTab(victim);
    }
  }

  /**
   * Drops a session's agent tab — used when its conversation is deleted, so a
   * removed session leaves no page behind.
   */
  disposeAgentTabForSession(owner: BrowserWindow, sessionKey: string): void {
    this.destroyTab(this.key(owner, agentTabId(sessionKey)));
  }

  private ensureTab(owner: BrowserWindow, tabId: string): ManagedTab {
    const key = this.key(owner, tabId);
    const existing = this.tabs.get(key);
    if (existing) {
      if (isAgentTabId(tabId)) this.touchAgentTab(key);
      return existing;
    }

    const agentTab = isAgentTabId(tabId);
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: "persist:nexu-browser",
        // An agent's page must not be able to park the run on a modal. With
        // dialogs disabled Chromium closes each one at once — alerts
        // acknowledged, confirms and prompts cancelled — and the CDP session
        // still hears about it, so the dismissal reaches the agent as
        // evidence (see trackDialogs). The user's own tabs keep real dialogs.
        disableDialogs: agentTab,
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);
    owner.contentView.addChildView(view);
    // Give the tab a real layout viewport before anything shows it, so a
    // snapshot taken straight after `navigate` measures the page at the size
    // it will actually be seen at.
    view.setBounds(offscreenLayoutBounds(owner));
    const tab: ManagedTab = {
      owner,
      view,
      navigationId: 0,
      pendingUrl: null,
      pendingLoad: null,
      refs: new BrowserRefTable(),
      navigationEpoch: 0,
      inPageEpoch: 0,
      dialogs: [],
      pageErrors: [],
    };
    this.tabs.set(key, tab);
    if (agentTab) this.touchAgentTab(key);
    this.ensureDownloadTracking(owner, view.webContents.session);

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeBrowserUrl(url))
        setImmediate(() => void this.loadTab(tab, url));
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      if (!isSafeBrowserUrl(url)) event.preventDefault();
    });
    // Refs point at DOM nodes of the page that produced them. Surviving a
    // navigation would let a click land on whatever now occupies that id.
    // Only the main frame counts: an ad iframe navigating on its own used to
    // wipe the refs of the page the agent was working on.
    view.webContents.on(
      "did-start-navigation",
      (_event, _url, isInPlace, isMainFrame) => {
        if (isInPlace || !isMainFrame) return;
        tab.refs.reset();
        tab.navigationEpoch += 1;
      },
    );
    view.webContents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) tab.inPageEpoch += 1;
    });
    if (agentTab) {
      // A `beforeunload` handler would otherwise cancel the navigation
      // silently — Electron shows no dialog for it — and the agent would see a
      // click that "did nothing". Let the page unload; the CDP session reports
      // the dialog (Chromium raises it as type "beforeunload" before Electron
      // gets here, measured live), so recording it again would double it.
      view.webContents.on("will-prevent-unload", (event) => {
        event.preventDefault();
      });
      void trackPageEvents(view.webContents, {
        onDialog: (dialog) => tab.dialogs.push(dialog),
        onPageError: (error) => {
          if (tab.pageErrors.length >= MAX_PAGE_ERRORS_PER_ACTION) return;
          if (tab.pageErrors.some((seen) => seen.message === error.message))
            return;
          tab.pageErrors.push(error);
        },
      }).catch(() => {
        // Reporting is best-effort; actions still work without it.
      });
    }
    owner.once("closed", () => this.disposeOwner(owner));
    return tab;
  }

  private ensureDownloadTracking(
    owner: BrowserWindow,
    browserSession: Electron.Session,
  ): void {
    if (this.trackedSessions.has(browserSession)) return;
    this.trackedSessions.add(browserSession);
    browserSession.on("will-download", (_event, item, webContents) => {
      const downloadOwner = [...this.tabs.values()].find(
        (tab) => tab.view.webContents === webContents,
      )?.owner;
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const download: ManagedDownload = {
        id,
        ownerId: downloadOwner?.id ?? owner.id,
        filename: item.getFilename(),
        path: item.getSavePath(),
        url: item.getURL(),
        state: "progressing",
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        startedAt: Date.now(),
      };
      this.downloads.set(id, download);
      item.on("updated", (_updatedEvent, state) => {
        download.filename = item.getFilename();
        download.path = item.getSavePath();
        download.receivedBytes = item.getReceivedBytes();
        download.totalBytes = item.getTotalBytes();
        download.state = state;
      });
      item.once("done", (_doneEvent, state) => {
        download.filename = item.getFilename();
        download.path = item.getSavePath();
        download.receivedBytes = item.getReceivedBytes();
        download.totalBytes = item.getTotalBytes();
        download.state = state;
        download.completedAt = Date.now();
        const retained = [...this.downloads.values()]
          .sort((left, right) => right.startedAt - left.startedAt)
          .slice(50);
        for (const stale of retained) this.downloads.delete(stale.id);
      });
    });
  }

  private loadTab(tab: ManagedTab, url: string): Promise<void> {
    if (tab.pendingUrl === url && tab.pendingLoad) return tab.pendingLoad;
    if (tab.view.webContents.getURL() === url) return Promise.resolve();

    const navigationId = ++tab.navigationId;
    tab.pendingUrl = url;
    const pendingLoad = tab.view.webContents
      .loadURL(url)
      .catch((error: unknown) => {
        const superseded = navigationId !== tab.navigationId;
        if (superseded && isAbortedNavigation(error)) return;
        throw error;
      })
      .finally(() => {
        if (navigationId !== tab.navigationId) return;
        tab.pendingUrl = null;
        tab.pendingLoad = null;
      });
    tab.pendingLoad = pendingLoad;
    return pendingLoad;
  }

  private disposeOwner(owner: BrowserWindow): void {
    for (const [key, tab] of [...this.tabs]) {
      if (tab.owner !== owner) continue;
      this.destroyTab(key);
    }
    this.revokedAgentSharing.delete(owner.id);
  }

  control(
    sender: Electron.WebContents,
    input: DesktopBrowserControl,
  ): Promise<DesktopBrowserControlResult> {
    return this.controlWindow(resolveOwnerWindow(sender), input);
  }

  /** Creates that session's agent tab if needed, without putting it on screen. */
  ensureAgentTab(owner: BrowserWindow, tabId: string): void {
    this.ensureTab(owner, tabId);
  }

  /**
   * Takes every browser view of a window off screen, keeping the pages alive.
   *
   * Visibility is otherwise driven entirely from the renderer, through React
   * effects that run `hide` when the panel unmounts. A renderer that goes away
   * without running them — a reload, a dev-server full refresh, a crashed
   * render process — leaves the last shown view composited over the app with
   * no address bar, no tabs and no close button: exactly the undismissable
   * page the panel exists to prevent. Measured live after a Vite reload.
   *
   * Hiding rather than disposing keeps the contract the panel already relies
   * on: pages, login state and the agent's element refs survive, and the panel
   * puts the view back on screen itself once it mounts again.
   */
  hideViewsForWindow(owner: BrowserWindow): void {
    for (const tab of this.tabs.values()) {
      if (tab.owner !== owner) continue;
      if (tab.view.webContents.isDestroyed()) continue;
      tab.view.setVisible(false);
    }
    this.markPanelHosted(owner, null);
  }

  /**
   * Begins watching a tab across an agent action.
   *
   * Call before the action, then `settle` after it: the watch remembers where
   * the page stood, gives a navigation the action may have started time to
   * begin and then to finish, and reports what changed. A fixed delay in its
   * place measured wrong in both directions — a click into a slow site was
   * read back half-loaded with the URL as its title, while a click that did
   * nothing still waited the full budget.
   */
  watchAction(owner: BrowserWindow, tabId: string): ActionWatch {
    const tab = this.ensureTab(owner, tabId);
    const navigationBefore = tab.navigationEpoch;
    const inPageBefore = tab.inPageEpoch;
    // Dialogs and errors from before the action are not this action's
    // evidence — page-load failures would otherwise be blamed on the first
    // click that followed them.
    tab.dialogs.length = 0;
    tab.pageErrors.length = 0;
    return {
      settle: async (timing) => {
        const contents = tab.view.webContents;
        const moved = (): boolean =>
          tab.navigationEpoch !== navigationBefore ||
          tab.inPageEpoch !== inPageBefore;
        if (!moved() && !contents.isLoading()) {
          await waitForAnyEvent(
            contents,
            ["did-start-navigation", "did-navigate-in-page"],
            timing.quietMs,
          );
        }
        if (contents.isLoading()) {
          await waitForAnyEvent(
            contents,
            ["did-stop-loading"],
            timing.loadTimeoutMs,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, timing.renderMs));
        return {
          navigated: tab.navigationEpoch !== navigationBefore,
          inPageNavigated: tab.inPageEpoch !== inPageBefore,
          loading: contents.isLoading(),
          dialogs: tab.dialogs.splice(0),
          pageErrors: tab.pageErrors.splice(0),
        };
      },
    };
  }

  async controlWindow(
    owner: BrowserWindow,
    input: DesktopBrowserControl,
  ): Promise<DesktopBrowserControlResult> {
    if (input.action === "center-state") {
      return {
        kind: "center-state",
        agentSharingEnabled: this.isAgentSharingAllowed(owner),
        tabs: [...this.tabs.entries()]
          .filter(([, tab]) => tab.owner === owner)
          .map(([key, tab]) => ({
            id: key.slice(key.indexOf(":") + 1),
            title: tab.view.webContents.getTitle() || "New tab",
            url: tab.view.webContents.getURL(),
            loading: tab.view.webContents.isLoading(),
            agentControlled: isAgentTabId(key.slice(key.indexOf(":") + 1)),
          })),
        downloads: [...this.downloads.values()]
          .filter((download) => download.ownerId === owner.id)
          .sort((left, right) => right.startedAt - left.startedAt)
          .map(({ ownerId: _ownerId, path: _path, ...download }) => download),
      };
    }
    if (input.action === "clear-downloads") {
      for (const [id, download] of this.downloads) {
        if (download.ownerId === owner.id && download.state !== "progressing") {
          this.downloads.delete(id);
        }
      }
      return { kind: "ok" };
    }
    if (input.action === "show-download") {
      const download = this.downloads.get(input.downloadId);
      if (
        download?.ownerId === owner.id &&
        download.state === "completed" &&
        download.path
      ) {
        shell.showItemInFolder(download.path);
      }
      return { kind: "ok" };
    }
    if (input.action === "revoke-agent") {
      this.revokedAgentSharing.add(owner.id);
      // Revoking is a withdrawal of consent for agent browsing as a whole, so
      // it must take down every session's agent tab — leaving another
      // conversation's page alive would keep exactly what the user revoked.
      const prefix = `${owner.id}:`;
      for (const [key, tab] of [...this.tabs]) {
        if (tab.owner !== owner) continue;
        if (!isAgentTabId(key.slice(prefix.length))) continue;
        this.destroyTab(key);
      }
      this.markPanelHosted(owner, null);
      return { kind: "ok" };
    }
    if (input.action === "forget-session") {
      this.disposeAgentTabForSession(owner, input.sessionKey);
      return { kind: "ok" };
    }
    if (input.action === "resume-agent") {
      this.revokedAgentSharing.delete(owner.id);
      return { kind: "ok" };
    }
    if (input.action === "hide" || input.action === "dispose") {
      // Same path as the main process's own teardown hook, so the panel's
      // hide and the renderer-gone fallback cannot drift apart.
      this.hideViewsForWindow(owner);
      if (input.action === "dispose") this.disposeOwner(owner);
      return { kind: "ok" };
    }
    if (!("tabId" in input)) throw new Error("Browser tab id is required.");
    if (isAgentTabId(input.tabId) && !this.isAgentSharingAllowed(owner)) {
      throw new Error(
        "Browser sharing was revoked by the user. Resume agent control before using this tab.",
      );
    }

    const key = this.key(owner, input.tabId);
    if (input.action === "close-tab") {
      this.destroyTab(key);
      return { kind: "ok" };
    }

    const tab = this.ensureTab(owner, input.tabId);
    if (input.action === "choose-history") {
      return chooseBrowserHistoryArtifact(owner, input.items, input.anchor);
    }
    if (input.action === "choose-viewport") {
      return chooseBrowserViewportMode(owner, input.currentMode, input.anchor);
    }
    if (input.action === "show") {
      if (!isSafeBrowserUrl(input.url)) throw new Error("Invalid browser URL.");
      for (const candidate of this.tabs.values()) {
        if (candidate.owner === owner)
          candidate.view.setVisible(candidate === tab);
      }
      tab.view.webContents.setZoomFactor(
        normalizeBrowserZoomFactor(input.zoomFactor),
      );
      tab.view.setBounds(clampBounds(owner, input.bounds));
      this.markPanelHosted(
        owner,
        isAgentTabId(input.tabId) ? input.tabId : null,
      );
      await this.loadTab(tab, input.url);
      return { kind: "ok" };
    }
    if (input.action === "navigate") {
      if (!isSafeBrowserUrl(input.url)) throw new Error("Invalid browser URL.");
      await this.loadTab(tab, input.url);
      return { kind: "ok" };
    }
    if (input.action === "command") {
      const history = tab.view.webContents.navigationHistory;
      if (input.command === "back" && history.canGoBack()) history.goBack();
      if (input.command === "forward" && history.canGoForward())
        history.goForward();
      if (input.command === "reload") tab.view.webContents.reload();
      if (input.command === "stop") tab.view.webContents.stop();
      return { kind: "ok" };
    }
    if (input.action === "state") {
      const history = tab.view.webContents.navigationHistory;
      return {
        kind: "state",
        url: tab.view.webContents.getURL(),
        title: tab.view.webContents.getTitle() || "New tab",
        loading: tab.view.webContents.isLoading(),
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward(),
      };
    }
    if (input.action === "select-element") {
      const selection = (await tab.view.webContents.executeJavaScript(
        elementPickerScript,
        true,
      )) as Extract<
        DesktopBrowserControlResult,
        { kind: "selection" }
      >["selection"];
      return { kind: "selection", selection };
    }

    if (input.action === "snapshot") {
      const snapshot = await captureSnapshot(tab.view.webContents, tab.refs, {
        maxNodes: Math.min(
          Math.max(input.maxNodes ?? DEFAULT_SNAPSHOT_NODES, 1),
          1000,
        ),
        visibleOnly: input.visibleOnly === true,
      });
      return { kind: "snapshot", ...snapshot };
    }
    if (input.action === "describe-ref") {
      return {
        kind: "element",
        element: await describeRef(tab.view.webContents, tab.refs, input.ref),
      };
    }
    if (input.action === "click-ref") {
      await clickRef(tab.view.webContents, tab.refs, input.ref);
      return { kind: "ok" };
    }
    if (input.action === "hover-ref") {
      await hoverRef(tab.view.webContents, tab.refs, input.ref);
      return { kind: "ok" };
    }
    if (input.action === "type-ref") {
      await typeIntoRef(tab.view.webContents, tab.refs, input.ref, input.text, {
        submit: input.submit ?? false,
        append: input.append ?? false,
      });
      return { kind: "ok" };
    }
    if (input.action === "press-key") {
      await pressKey(tab.view.webContents, tab.refs, input.key, input.ref);
      return { kind: "ok" };
    }
    if (input.action === "select-ref") {
      await selectOption(
        tab.view.webContents,
        tab.refs,
        input.ref,
        input.option,
      );
      return { kind: "ok" };
    }
    if (input.action === "scroll") {
      const position = await scrollBy(tab.view.webContents, input.deltaY);
      return { kind: "scroll", ...position };
    }
    if (input.action === "screenshot") {
      const screenshot = await captureScreenshot(tab.view.webContents);
      return { kind: "screenshot", ...screenshot };
    }

    const image = await tab.view.webContents.capturePage();
    return { kind: "capture", dataUrl: image.toDataURL() };
  }
}

export const embeddedBrowserManager = new EmbeddedBrowserManager();
