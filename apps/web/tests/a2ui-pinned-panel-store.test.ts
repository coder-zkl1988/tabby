/**
 * a2ui-pinned-panel-store.test.ts — the pinned sidebar panel's store.
 *
 * Two invariants:
 *  - Pinning is reachable from a render effect, so re-pinning an unchanged
 *    surface must not change the snapshot identity: that feedback loop is what
 *    previously blew React's update depth and killed the desktop renderer.
 *  - Pins are scoped per conversation, so switching sessions hides the panel
 *    and switching back restores exactly what that session had pinned.
 */

import type { A2UIMessage } from "@/lib/a2ui";
import {
  closePinnedPanel,
  forgetPinnedSession,
  getPinnedPanelState,
  isSurfacePinned,
  openPinnedPanel,
  pinSurface,
  resetPinnedPanelForTests,
  sessionHasPins,
  setActivePinnedSession,
  unpinSurface,
} from "@/lib/a2ui/a2ui-pinned-panel-store";
import { beforeEach, describe, expect, it } from "vitest";

const messages = [
  {
    version: "v0.9",
    createSurface: { surfaceId: "s1", components: [] },
  } as unknown as A2UIMessage,
];
const onAction = () => undefined;

function surface(
  surfaceId: string,
  title = surfaceId,
  pinKey: string | null = "XhsOpsRunPlanner",
) {
  return { surfaceId, title, messages, onAction, pinKey };
}

describe("pinned panel store", () => {
  beforeEach(() => {
    resetPinnedPanelForTests();
    setActivePinnedSession("session-a");
  });

  it("pins, opens the panel, and reports membership", () => {
    expect(getPinnedPanelState().isOpen).toBe(false);
    pinSurface("session-a", surface("planner"));
    expect(getPinnedPanelState().isOpen).toBe(true);
    expect(getPinnedPanelState().surfaces).toHaveLength(1);
    expect(isSurfacePinned("planner")).toBe(true);
    expect(isSurfacePinned("dashboard")).toBe(false);
  });

  it("re-pinning an unchanged surface keeps the same snapshot object", () => {
    // useSyncExternalStore re-renders on snapshot identity, so an unchanged
    // re-pin returning the SAME object is what stops the effect→render→effect
    // loop. Identity is the assertion that matters here.
    pinSurface("session-a", surface("planner"));
    const before = getPinnedPanelState();
    pinSurface("session-a", surface("planner"));
    expect(getPinnedPanelState()).toBe(before);
  });

  it("refreshes a pinned surface in place when its payload changes", () => {
    pinSurface("session-a", surface("planner", "old title"));
    pinSurface("session-a", surface("planner", "new title"));
    const { surfaces } = getPinnedPanelState();
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.title).toBe("new title");
  });

  it("stacks multiple surfaces in pin order", () => {
    pinSurface("session-a", surface("planner"));
    pinSurface("session-a", surface("dashboard"));
    expect(
      getPinnedPanelState().surfaces.map((item) => item.surfaceId),
    ).toEqual(["planner", "dashboard"]);
  });

  it("closes the panel when the last surface is unpinned", () => {
    pinSurface("session-a", surface("planner"));
    pinSurface("session-a", surface("dashboard"));
    unpinSurface("session-a", "planner");
    expect(getPinnedPanelState().isOpen).toBe(true);
    unpinSurface("session-a", "dashboard");
    expect(getPinnedPanelState().isOpen).toBe(false);
    expect(getPinnedPanelState().surfaces).toHaveLength(0);
  });

  it("keeps surfaces when collapsed, and reopens only with content", () => {
    pinSurface("session-a", surface("planner"));
    closePinnedPanel();
    expect(getPinnedPanelState().isOpen).toBe(false);

    openPinnedPanel();
    expect(getPinnedPanelState().isOpen).toBe(true);

    resetPinnedPanelForTests();
    setActivePinnedSession("session-a");
    openPinnedPanel();
    expect(getPinnedPanelState().isOpen).toBe(false);
  });

  it("hides another session's pins and restores them on the way back", () => {
    pinSurface("session-a", surface("planner"));
    expect(getPinnedPanelState().surfaces).toHaveLength(1);

    // Switching conversations must not leave A's card covering B.
    setActivePinnedSession("session-b");
    expect(getPinnedPanelState().isOpen).toBe(false);
    expect(getPinnedPanelState().surfaces).toHaveLength(0);
    expect(isSurfacePinned("planner")).toBe(false);

    // B pins its own card; A's is untouched.
    pinSurface("session-b", surface("dashboard"));
    expect(
      getPinnedPanelState().surfaces.map((item) => item.surfaceId),
    ).toEqual(["dashboard"]);

    setActivePinnedSession("session-a");
    expect(
      getPinnedPanelState().surfaces.map((item) => item.surfaceId),
    ).toEqual(["planner"]);
    expect(getPinnedPanelState().isOpen).toBe(true);
  });

  it("hides the panel outside any conversation", () => {
    pinSurface("session-a", surface("planner"));
    setActivePinnedSession(null);
    expect(getPinnedPanelState().isOpen).toBe(false);
    expect(getPinnedPanelState().surfaces).toHaveLength(0);
    expect(sessionHasPins("session-a")).toBe(true);
  });

  it("drops a deleted conversation's pins", () => {
    pinSurface("session-a", surface("planner"));
    forgetPinnedSession("session-a");
    expect(sessionHasPins("session-a")).toBe(false);
    expect(getPinnedPanelState().surfaces).toHaveLength(0);
  });
});
