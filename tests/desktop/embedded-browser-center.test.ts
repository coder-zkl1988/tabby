import { EventEmitter as NodeEventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const createEmitter = () => {
    const listeners = new Map<string, Set<Listener>>();
    return {
      on(event: string, listener: Listener): void {
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
      },
      emit(event: string, ...args: unknown[]): void {
        for (const listener of [...(listeners.get(event) ?? [])]) {
          listener(...args);
        }
      },
      removeAllListeners(): void {
        listeners.clear();
      },
    };
  };
  return {
    browserSession: createEmitter(),
    createEmitter,
    showItemInFolder: vi.fn(),
  };
});

vi.mock("electron", () => {
  class MockWebContents {
    private readonly events = electronMocks.createEmitter();
    readonly session = electronMocks.browserSession;
    readonly navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    private url = "";
    private title = "";

    on(event: string, listener: (...args: unknown[]) => void): this {
      this.events.on(event, listener);
      return this;
    }
    setWindowOpenHandler(): void {}
    setZoomFactor(): void {}
    getURL(): string {
      return this.url;
    }
    getTitle(): string {
      return this.title;
    }
    isLoading(): boolean {
      return false;
    }
    async loadURL(url: string): Promise<void> {
      this.url = url;
      this.title = new URL(url).hostname;
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
    visible = false;
    setBackgroundColor(): void {}
    setVisible(value: boolean): void {
      this.visible = value;
    }
    setBounds(): void {}
  }

  return {
    BrowserWindow: {
      fromWebContents: vi.fn(),
    },
    WebContentsView: MockWebContentsView,
    shell: { showItemInFolder: electronMocks.showItemInFolder },
  };
});

vi.mock("../../apps/desktop/main/services/embedded-browser-cdp", () => ({
  BrowserRefTable: class {
    reset(): void {}
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
  trackPageEvents: vi.fn(async () => undefined),
  typeIntoRef: vi.fn(),
}));

import {
  EmbeddedBrowserManager,
  agentTabId,
} from "../../apps/desktop/main/services/embedded-browser-manager";

type DownloadState = "progressing" | "completed" | "cancelled" | "interrupted";

class MockDownloadItem extends NodeEventEmitter {
  state: DownloadState = "progressing";
  receivedBytes = 0;

  getFilename(): string {
    return "report.pdf";
  }
  getSavePath(): string {
    return "/tmp/report.pdf";
  }
  getURL(): string {
    return "https://example.test/report.pdf";
  }
  getReceivedBytes(): number {
    return this.receivedBytes;
  }
  getTotalBytes(): number {
    return 100;
  }
}

function createOwner(id: number): BrowserWindow {
  const events = new NodeEventEmitter();
  const views: Array<{ visible: boolean }> = [];
  return {
    id,
    contentView: {
      addChildView: vi.fn((view: { visible: boolean }) => views.push(view)),
      removeChildView: vi.fn(),
    },
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    once: events.once.bind(events),
    // Test-only handle on the native views this window is compositing.
    __views: views,
  } as unknown as BrowserWindow;
}

function visibleViewCount(owner: BrowserWindow): number {
  const views = (owner as unknown as { __views: Array<{ visible: boolean }> })
    .__views;
  return views.filter((view) => view.visible).length;
}

describe("embedded browser control center", () => {
  beforeEach(() => {
    electronMocks.browserSession.removeAllListeners();
    electronMocks.showItemInFolder.mockReset();
  });

  it("reports the agent tab and blocks recreating it after sharing is revoked", async () => {
    const manager = new EmbeddedBrowserManager();
    const owner = createOwner(7);
    const AGENT_TAB_ID = agentTabId("agent:bot:main");
    manager.ensureAgentTab(owner, AGENT_TAB_ID);

    await expect(
      manager.controlWindow(owner, {
        action: "navigate",
        tabId: AGENT_TAB_ID,
        url: "https://example.test/",
      }),
    ).resolves.toEqual({ kind: "ok" });
    await expect(
      manager.controlWindow(owner, { action: "center-state" }),
    ).resolves.toMatchObject({
      kind: "center-state",
      agentSharingEnabled: true,
      tabs: [
        {
          id: AGENT_TAB_ID,
          url: "https://example.test/",
          agentControlled: true,
        },
      ],
    });

    await manager.controlWindow(owner, { action: "revoke-agent" });

    await expect(
      manager.controlWindow(owner, {
        action: "navigate",
        tabId: AGENT_TAB_ID,
        url: "https://example.test/recreated",
      }),
    ).rejects.toThrow("revoked by the user");
    await expect(
      manager.controlWindow(owner, { action: "center-state" }),
    ).resolves.toMatchObject({
      agentSharingEnabled: false,
      tabs: [],
    });
  });

  it("takes a window's views off screen without destroying the pages", async () => {
    // The panel hides its view from a React cleanup, which a renderer that
    // reloads or crashes never runs. Measured live after a Vite reload: the
    // last shown page stayed composited over the app with no address bar, no
    // tabs and no close button. This is the main process's own way out, so it
    // must not need the renderer — and must not throw the page away either.
    const manager = new EmbeddedBrowserManager();
    const owner = createOwner(21);
    const other = createOwner(22);
    const tabId = agentTabId("agent:bot:main");
    const otherTabId = agentTabId("agent:other:main");
    manager.ensureAgentTab(owner, tabId);
    manager.ensureAgentTab(other, otherTabId);

    await manager.controlWindow(owner, {
      action: "show",
      tabId,
      url: "https://example.test/",
      bounds: { x: 0, y: 0, width: 400, height: 400 },
    });
    await manager.controlWindow(other, {
      action: "show",
      tabId: otherTabId,
      url: "https://example.test/other",
      bounds: { x: 0, y: 0, width: 400, height: 400 },
    });
    expect(visibleViewCount(owner)).toBe(1);
    expect(manager.isAgentTabPanelHosted(owner, tabId)).toBe(true);

    manager.hideViewsForWindow(owner);

    expect(visibleViewCount(owner)).toBe(0);
    // Mutating clicks refuse to act on a view the panel is not hosting.
    expect(manager.isAgentTabPanelHosted(owner, tabId)).toBe(false);
    // The page survives, so the panel resumes rather than restarts.
    await expect(
      manager.controlWindow(owner, { action: "center-state" }),
    ).resolves.toMatchObject({
      tabs: [{ id: tabId, url: "https://example.test/" }],
    });
    // One window's renderer going away must not blank another window's panel.
    expect(visibleViewCount(other)).toBe(1);
    expect(manager.isAgentTabPanelHosted(other, otherTabId)).toBe(true);
  });

  it("tracks download progress, reveals completed files, and clears history", async () => {
    const manager = new EmbeddedBrowserManager();
    const owner = createOwner(11);
    manager.ensureAgentTab(owner, agentTabId("agent:bot:main"));
    const item = new MockDownloadItem();
    electronMocks.browserSession.emit("will-download", {}, item, undefined);
    item.receivedBytes = 40;
    item.emit("updated", {}, "progressing");

    const progressing = await manager.controlWindow(owner, {
      action: "center-state",
    });
    expect(progressing).toMatchObject({
      kind: "center-state",
      downloads: [
        {
          filename: "report.pdf",
          state: "progressing",
          receivedBytes: 40,
          totalBytes: 100,
        },
      ],
    });
    if (progressing.kind !== "center-state") {
      throw new Error("Expected browser center state");
    }
    const downloadId = progressing.downloads[0]?.id;
    if (!downloadId) throw new Error("Expected tracked download");

    item.receivedBytes = 100;
    item.state = "completed";
    item.emit("done", {}, "completed");
    await manager.controlWindow(owner, {
      action: "show-download",
      downloadId,
    });
    expect(electronMocks.showItemInFolder).toHaveBeenCalledWith(
      "/tmp/report.pdf",
    );

    await manager.controlWindow(owner, { action: "clear-downloads" });
    await expect(
      manager.controlWindow(owner, { action: "center-state" }),
    ).resolves.toMatchObject({ downloads: [] });
  });
});
