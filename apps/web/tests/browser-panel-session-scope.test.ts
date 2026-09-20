/**
 * browser-panel-session-scope.test.ts — the browser panel belongs to the
 * session that opened it.
 *
 * The browser exists for the agent, so another conversation must never display
 * its page. Hiding is safe mid-task: collapsing the panel only hides the view
 * and never disposes it (embedded-browser.tsx), so the run continues off
 * screen and resumes when its own session comes back.
 */

import {
  closeBrowserPanelForRouting,
  getBrowserPanelState,
  openBrowserPanel,
  resetBrowserPanelForTests,
  syncBrowserPanelToSession,
} from "@/lib/browser/browser-panel-store";
import { beforeEach, describe, expect, it } from "vitest";

describe("browser panel session scope", () => {
  beforeEach(resetBrowserPanelForTests);

  it("hides on another session and restores on the way back", () => {
    openBrowserPanel("agent:a:main");
    expect(getBrowserPanelState().isOpen).toBe(true);

    syncBrowserPanelToSession("agent:b:main");
    expect(getBrowserPanelState().isOpen).toBe(false);
    // The binding survives so the panel can come back.
    expect(getBrowserPanelState().sessionKey).toBe("agent:a:main");

    syncBrowserPanelToSession("agent:a:main");
    expect(getBrowserPanelState().isOpen).toBe(true);
  });

  it("keeps an agent's panel bound while hidden, so the run is not cut off", () => {
    openBrowserPanel("agent:a:main", true);

    syncBrowserPanelToSession("agent:b:main");
    expect(getBrowserPanelState().isOpen).toBe(false);
    // openedByAgent must survive: it is what protects the panel from being
    // closed outright, which WOULD dispose the view and cut the agent off.
    expect(getBrowserPanelState().openedByAgent).toBe(true);

    syncBrowserPanelToSession("agent:a:main");
    expect(getBrowserPanelState().isOpen).toBe(true);
    expect(getBrowserPanelState().openedByAgent).toBe(true);
  });

  it("hides outside any conversation without unbinding", () => {
    openBrowserPanel("agent:a:main");
    syncBrowserPanelToSession(null);
    expect(getBrowserPanelState().isOpen).toBe(false);
    expect(getBrowserPanelState().sessionKey).toBe("agent:a:main");
  });

  it("is a no-op when the panel was never opened", () => {
    const before = getBrowserPanelState();
    syncBrowserPanelToSession("agent:a:main");
    expect(getBrowserPanelState()).toBe(before);
  });

  it("still lets an explicit route close discard a user-opened panel", () => {
    openBrowserPanel("agent:a:main");
    expect(closeBrowserPanelForRouting()).toBe(true);
    expect(getBrowserPanelState().sessionKey).toBeNull();

    // An agent's panel is still protected from that path.
    openBrowserPanel("agent:a:main", true);
    expect(closeBrowserPanelForRouting()).toBe(false);
    expect(getBrowserPanelState().isOpen).toBe(true);
  });
});
