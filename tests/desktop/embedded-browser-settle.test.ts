import type { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How an agent action is waited out before its evidence is read.
 *
 * The fixed 700ms that preceded this measured wrong both ways live: a click
 * into a slow site was read back half-loaded with the URL as its title, and a
 * click that did nothing still burned the full delay. The watcher waits for
 * what actually happens — a navigation starting, then finishing — and reports
 * it, including the dialogs the page raised on the way.
 */

const cdp = vi.hoisted(() => ({
  dialogListeners: new Map<object, (dialog: unknown) => void>(),
  errorListeners: new Map<object, (error: unknown) => void>(),
  resetCalls: 0,
}));

vi.mock("../../apps/desktop/main/services/embedded-browser-cdp", () => ({
  BrowserRefTable: class {
    reset(): void {
      cdp.resetCalls += 1;
    }
  },
  captureScreenshot: vi.fn(),
  captureSnapshot: vi.fn(),
  clickRef: vi.fn(),
  describeRef: vi.fn(),
  detachDebugger: vi.fn(),
  hoverRef: vi.fn(),
  pressKey: vi.fn(),
  scrollBy: vi.fn(),
  selectOption: vi.fn(),
  typeIntoRef: vi.fn(),
  trackPageEvents: vi.fn(
    async (
      contents: object,
      handlers: {
        onDialog: (dialog: unknown) => void;
        onPageError: (error: unknown) => void;
      },
    ) => {
      cdp.dialogListeners.set(contents, handlers.onDialog);
      cdp.errorListeners.set(contents, handlers.onPageError);
    },
  ),
}));

type CreatedView = {
  options: { webPreferences?: { disableDialogs?: boolean } };
  webContents: MockContents;
};

type MockContents = EventEmitter & {
  loading: boolean;
  isLoading: () => boolean;
};

const electron = vi.hoisted(() => ({ views: [] as unknown[] }));

vi.mock("electron", async () => {
  // Mock factories are hoisted above the imports, so the emitter has to be
  // pulled in here rather than from the top of the file.
  const { EventEmitter } = await import("node:events");

  class MockWebContents extends EventEmitter {
    readonly session = { on(): void {} };
    readonly navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    loading = false;
    private url = "";
    private title = "";

    setWindowOpenHandler(): void {}
    getURL(): string {
      return this.url;
    }
    getTitle(): string {
      return this.title;
    }
    isLoading(): boolean {
      return this.loading;
    }
    async loadURL(url: string): Promise<void> {
      this.url = url;
    }
    isDestroyed(): boolean {
      return false;
    }
    close(): void {}
    reload(): void {}
    stop(): void {}
  }

  class MockWebContentsView {
    readonly webContents = new MockWebContents();
    constructor(readonly options: unknown) {
      electron.views.push(this);
    }
    setBackgroundColor(): void {}
    setVisible(): void {}
    setBounds(): void {}
  }

  return {
    BrowserWindow: { fromWebContents: vi.fn() },
    WebContentsView: MockWebContentsView,
    shell: { showItemInFolder: vi.fn() },
  };
});

import {
  EmbeddedBrowserManager,
  agentTabId,
} from "../../apps/desktop/main/services/embedded-browser-manager";

const TIMING = { quietMs: 30, loadTimeoutMs: 80, renderMs: 5 };
const SESSION = "agent:bot:main";

function createOwner(id: number): BrowserWindow {
  return {
    id,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    once: vi.fn(),
  } as unknown as BrowserWindow;
}

function latestView(): CreatedView {
  const view = electron.views[electron.views.length - 1] as
    | CreatedView
    | undefined;
  if (!view) throw new Error("no view was created");
  return view;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A tab the watcher can act on, plus the contents it wraps. */
function agentTab(): {
  manager: EmbeddedBrowserManager;
  owner: BrowserWindow;
  tabId: string;
  contents: MockContents;
} {
  const manager = new EmbeddedBrowserManager();
  const owner = createOwner(1);
  const tabId = agentTabId(SESSION);
  manager.ensureAgentTab(owner, tabId);
  return { manager, owner, tabId, contents: latestView().webContents };
}

describe("embedded browser action settle", () => {
  beforeEach(() => {
    electron.views.length = 0;
    cdp.dialogListeners.clear();
    cdp.errorListeners.clear();
    cdp.resetCalls = 0;
  });

  it("answers quickly when the page stayed put", async () => {
    const { manager, owner, tabId } = agentTab();
    const watch = manager.watchAction(owner, tabId);

    const started = Date.now();
    const settle = await watch.settle(TIMING);

    expect(settle).toEqual({
      navigated: false,
      inPageNavigated: false,
      loading: false,
      dialogs: [],
      pageErrors: [],
    });
    // The quiet window plus paint time, not the load budget.
    expect(Date.now() - started).toBeLessThan(TIMING.loadTimeoutMs);
  });

  it("waits for a navigation the action started to finish loading", async () => {
    const { manager, owner, tabId, contents } = agentTab();
    const watch = manager.watchAction(owner, tabId);
    const pending = watch.settle(TIMING);

    // The click's navigation begins inside the quiet window and loads for
    // longer than it.
    await sleep(5);
    contents.loading = true;
    contents.emit("did-start-navigation", {}, "https://x/next", false, true);
    await sleep(TIMING.quietMs + 10);
    contents.loading = false;
    contents.emit("did-stop-loading");

    const settle = await pending;
    expect(settle.navigated).toBe(true);
    expect(settle.loading).toBe(false);
    // A new document invalidates the refs of the old one.
    expect(cdp.resetCalls).toBe(1);
  });

  it("gives up on a load that never finishes and says so", async () => {
    const { manager, owner, tabId, contents } = agentTab();
    const watch = manager.watchAction(owner, tabId);
    const pending = watch.settle(TIMING);
    contents.loading = true;
    contents.emit("did-start-navigation", {}, "https://x/slow", false, true);

    const started = Date.now();
    const settle = await pending;
    expect(settle.navigated).toBe(true);
    expect(settle.loading).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(
      TIMING.loadTimeoutMs - 5,
    );
  });

  it("ignores navigations that happen inside a subframe", async () => {
    // An ad iframe navigating on its own used to reset the refs of the page
    // the agent was working on and report a navigation that never happened.
    const { manager, owner, tabId, contents } = agentTab();
    const watch = manager.watchAction(owner, tabId);
    contents.emit("did-start-navigation", {}, "https://ads/x", false, false);

    const settle = await watch.settle(TIMING);
    expect(settle.navigated).toBe(false);
    expect(cdp.resetCalls).toBe(0);
  });

  it("reports a same-document navigation without dropping the refs", async () => {
    const { manager, owner, tabId, contents } = agentTab();
    const watch = manager.watchAction(owner, tabId);
    contents.emit("did-navigate-in-page", {}, "https://x/#/route", true);

    const settle = await watch.settle(TIMING);
    expect(settle.navigated).toBe(false);
    expect(settle.inPageNavigated).toBe(true);
    expect(cdp.resetCalls).toBe(0);
  });

  it("collects the dialogs raised during the action and forgets earlier ones", async () => {
    const { manager, owner, tabId, contents } = agentTab();
    const raise = cdp.dialogListeners.get(contents);
    if (!raise) throw new Error("agent tab did not start dialog tracking");

    raise({ type: "alert", message: "from before" });
    const watch = manager.watchAction(owner, tabId);
    raise({ type: "confirm", message: "Delete?" });

    const settle = await watch.settle(TIMING);
    expect(settle.dialogs).toEqual([{ type: "confirm", message: "Delete?" }]);
    // Read once: the next action starts clean.
    expect(
      (await manager.watchAction(owner, tabId).settle(TIMING)).dialogs,
    ).toEqual([]);
  });

  it("disables JavaScript dialogs on agent tabs only", async () => {
    const { manager, owner } = agentTab();
    expect(latestView().options.webPreferences?.disableDialogs).toBe(true);

    await manager.controlWindow(owner, { action: "state", tabId: "user-1" });
    expect(latestView().options.webPreferences?.disableDialogs).toBe(false);
    // A user's tab keeps real dialogs and needs no tracking.
    expect(cdp.dialogListeners.has(latestView().webContents)).toBe(false);
  });

  it("collects uncaught page errors raised during the action", async () => {
    // The case this exists for: Electron has no window.prompt(), so the page's
    // handler throws and dies with no dialog to report. Without this the agent
    // saw only an unchanged element.
    const { manager, owner, tabId, contents } = agentTab();
    const raise = cdp.errorListeners.get(contents);
    if (!raise) throw new Error("agent tab did not start error tracking");

    raise({ message: "ReferenceError: from before" });
    const watch = manager.watchAction(owner, tabId);
    raise({
      message: "Error: prompt() is not supported.",
      source: "app.js:12",
    });

    const settle = await watch.settle(TIMING);
    expect(settle.pageErrors).toEqual([
      { message: "Error: prompt() is not supported.", source: "app.js:12" },
    ]);
    expect(
      (await manager.watchAction(owner, tabId).settle(TIMING)).pageErrors,
    ).toEqual([]);
  });

  it("collapses a repeating error and stops after a handful", async () => {
    // A page throwing from a render loop can raise the same error dozens of
    // times inside one action window.
    const { manager, owner, tabId, contents } = agentTab();
    const raise = cdp.errorListeners.get(contents);
    if (!raise) throw new Error("agent tab did not start error tracking");
    const watch = manager.watchAction(owner, tabId);

    for (let i = 0; i < 40; i += 1) {
      raise({ message: "TypeError: x is not a function" });
      raise({ message: `Error: distinct ${i}` });
    }

    const settle = await watch.settle(TIMING);
    expect(settle.pageErrors).toHaveLength(5);
    expect(
      settle.pageErrors.filter(
        (error) => error.message === "TypeError: x is not a function",
      ),
    ).toHaveLength(1);
  });

  it("tracks page errors on agent tabs only", async () => {
    const { manager, owner } = agentTab();
    await manager.controlWindow(owner, { action: "state", tabId: "user-1" });
    expect(cdp.errorListeners.has(latestView().webContents)).toBe(false);
  });

  it("lets an agent page leave past a beforeunload handler without double-reporting it", async () => {
    const { manager, owner, tabId, contents } = agentTab();
    const raise = cdp.dialogListeners.get(contents);
    if (!raise) throw new Error("agent tab did not start dialog tracking");
    const watch = manager.watchAction(owner, tabId);
    // Chromium tells the CDP session first; Electron's own event follows.
    raise({ type: "beforeunload", message: "" });
    const event = { preventDefault: vi.fn() };
    contents.emit("will-prevent-unload", event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    const settle = await watch.settle(TIMING);
    expect(settle.dialogs).toEqual([{ type: "beforeunload", message: "" }]);
  });
});
