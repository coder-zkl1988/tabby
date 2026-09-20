/**
 * @vitest-environment jsdom
 *
 * a2ui-pin-store.test.ts — pins are keyed by COMPONENT TYPE, not surfaceId:
 * the agent names every project's surface differently, so a surfaceId-keyed
 * pin would never fire a second time.
 */

import type { A2UIMessage } from "@/lib/a2ui";
import {
  isPinnedType,
  isSurfaceTypePinned,
  setTypePinned,
  surfaceComponentTypes,
  surfacePinKey,
} from "@/lib/a2ui/a2ui-pin-store";
import { resetPinnedTypesForTests } from "@/lib/a2ui/a2ui-pin-store";
import { beforeEach, describe, expect, it } from "vitest";

function createSurface(components: Array<{ id: string; type: string }>) {
  return {
    version: "v0.9",
    createSurface: { surfaceId: "s1", components },
  } as unknown as A2UIMessage;
}

function updateComponents(components: Array<{ id: string; type: string }>) {
  return {
    version: "v0.9",
    updateComponents: { surfaceId: "s1", components },
  } as unknown as A2UIMessage;
}

describe("a2ui pin store", () => {
  beforeEach(() => {
    localStorage.clear();
    resetPinnedTypesForTests();
  });

  it("reads component types from both createSurface and updateComponents", () => {
    const msgs = [
      createSurface([{ id: "a", type: "XhsOpsRunPlanner" }]),
      updateComponents([
        { id: "b", type: "Column" },
        { id: "c", type: "XhsOpsRunPlanner" },
      ]),
    ];
    expect(surfaceComponentTypes(msgs)).toEqual(["XhsOpsRunPlanner", "Column"]);
    expect(surfacePinKey(msgs)).toBe("XhsOpsRunPlanner");
  });

  it("keys pins by component type so a differently-named surface still matches", () => {
    // The agent names each project's surface differently; the type is what recurs.
    const first = [createSurface([{ id: "a", type: "XhsOpsRunPlanner" }])];
    const laterProject = [
      {
        version: "v0.9",
        createSurface: {
          surfaceId: "xhs-badminton-runplanner",
          components: [{ id: "z", type: "XhsOpsRunPlanner" }],
        },
      } as unknown as A2UIMessage,
    ];

    expect(isSurfaceTypePinned(laterProject)).toBe(false);
    setTypePinned(surfacePinKey(first), true);
    expect(isSurfaceTypePinned(laterProject)).toBe(true);
  });

  it("survives a reload by persisting to localStorage", () => {
    setTypePinned("XhsOpsDashboard", true);
    resetPinnedTypesForTests();
    expect(isPinnedType("XhsOpsDashboard")).toBe(true);
  });

  it("unpins and ignores surfaces without a component type", () => {
    setTypePinned("XhsOpsDashboard", true);
    setTypePinned("XhsOpsDashboard", false);
    expect(isPinnedType("XhsOpsDashboard")).toBe(false);

    expect(surfacePinKey([updateComponents([])])).toBeNull();
    expect(isPinnedType(null)).toBe(false);
    expect(() => setTypePinned(null, true)).not.toThrow();
  });
});
