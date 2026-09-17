/**
 * canvas-group-ops.test.ts
 *
 * Group-from-selection (reference v0.18): ⌘G wraps the selection in a group
 * container, ⌘⇧G releases it. Covers the pure gating/geometry in canvas-groups
 * and the store actions in canvas-group-ops, including the ordering trap —
 * removing an old group clears its members' groupId, so it must happen BEFORE
 * the new membership is written.
 *
 * Plain Node env — assertions run against canvas-store state directly.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  groupSelectedNodes,
  ungroupSelectedNodes,
} from "../src/lib/canvas/canvas-group-ops";
import {
  GROUP_WRAP_PADDING,
  GROUP_WRAP_TOP_PADDING,
  canGroupSelection,
  canUngroupSelection,
  groupSelectionMembers,
  groupWrapRect,
} from "../src/lib/canvas/canvas-groups";
import {
  __flushCanvasHistoryForTests,
  __resetCanvasForTests,
  addNode,
  connectNodes,
  getCanvasState,
  selectNodes,
  undo,
} from "../src/lib/canvas/canvas-store";

// localStorage polyfill — canvas-store reads it at module load.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => {
  __resetCanvasForTests();
});

/** Two text nodes at known positions, both selected. */
function twoSelected() {
  const a = addNode({
    type: "text",
    title: "A",
    position: { x: 100, y: 100 },
    size: { width: 200, height: 100 },
  });
  const b = addNode({
    type: "text",
    title: "B",
    position: { x: 400, y: 300 },
    size: { width: 200, height: 100 },
  });
  selectNodes([a.id, b.id]);
  return { a, b };
}

describe("group gating", () => {
  it("needs at least two members", () => {
    const a = addNode({ type: "text", title: "A" });
    selectNodes([a.id]);
    const { nodes } = getCanvasState();
    expect(canGroupSelection(new Set([a.id]), nodes)).toBe(false);
  });

  it("an intact group re-selected on its own cannot be re-grouped", () => {
    const { a, b } = twoSelected();
    const groupId = groupSelectedNodes();
    if (!groupId) throw new Error("expected a group");
    selectNodes([groupId]);
    const { nodes } = getCanvasState();
    expect(canGroupSelection(new Set([groupId]), nodes)).toBe(false);
    expect(canGroupSelection(new Set([a.id, b.id]), nodes)).toBe(false);
  });

  it("a group plus an outside node can be grouped (the group flattens in)", () => {
    const { a, b } = twoSelected();
    const groupId = groupSelectedNodes();
    if (!groupId) throw new Error("expected a group");
    const c = addNode({ type: "text", title: "C" });
    const { nodes } = getCanvasState();
    expect(canGroupSelection(new Set([groupId, c.id]), nodes)).toBe(true);
    expect(
      groupSelectionMembers(new Set([groupId, c.id]), nodes).map((n) => n.id),
    ).toEqual([a.id, b.id, c.id]);
  });

  it("ungroup is offered for a selected group and for a selected member", () => {
    const { a } = twoSelected();
    const groupId = groupSelectedNodes();
    if (!groupId) throw new Error("expected a group");
    const { nodes } = getCanvasState();
    expect(canUngroupSelection(new Set([groupId]), nodes)).toBe(true);
    expect(canUngroupSelection(new Set([a.id]), nodes)).toBe(true);
  });

  it("ungroup is not offered for ungrouped nodes", () => {
    const { a, b } = twoSelected();
    const { nodes } = getCanvasState();
    expect(canUngroupSelection(new Set([a.id, b.id]), nodes)).toBe(false);
  });
});

describe("groupWrapRect", () => {
  it("wraps the union with side padding and extra room above for titles", () => {
    const { a, b } = twoSelected();
    const rect = groupWrapRect([a, b]);
    expect(rect.position).toEqual({
      x: 100 - GROUP_WRAP_PADDING,
      y: 100 - GROUP_WRAP_TOP_PADDING,
    });
    expect(rect.size).toEqual({
      width: 600 - 100 + GROUP_WRAP_PADDING * 2,
      height: 400 - 100 + GROUP_WRAP_TOP_PADDING + GROUP_WRAP_PADDING,
    });
  });
});

describe("groupSelectedNodes", () => {
  it("creates a group that wraps the selection and takes it as members", () => {
    const { a, b } = twoSelected();
    const groupId = groupSelectedNodes();
    if (!groupId) throw new Error("expected a group");

    const state = getCanvasState();
    const group = state.nodes.find((n) => n.id === groupId);
    expect(group?.type).toBe("group");
    expect(group?.position).toEqual({
      x: 100 - GROUP_WRAP_PADDING,
      y: 100 - GROUP_WRAP_TOP_PADDING,
    });
    for (const id of [a.id, b.id]) {
      expect(state.nodes.find((n) => n.id === id)?.metadata.groupId).toBe(
        groupId,
      );
    }
    expect(state.selectedNodeIds).toEqual([groupId]);
  });

  it("returns null when the selection cannot be grouped", () => {
    const a = addNode({ type: "text", title: "A" });
    selectNodes([a.id]);
    expect(groupSelectedNodes()).toBeNull();
  });

  it("flattens a selected group into the new one, keeping every member", () => {
    const { a, b } = twoSelected();
    const inner = groupSelectedNodes();
    if (!inner) throw new Error("expected a group");
    const c = addNode({ type: "text", title: "C" });
    selectNodes([inner, c.id]);

    const outer = groupSelectedNodes();
    if (!outer) throw new Error("expected a group");

    const state = getCanvasState();
    // The old box is gone — groups never nest.
    expect(state.nodes.find((n) => n.id === inner)).toBeUndefined();
    for (const id of [a.id, b.id, c.id]) {
      expect(state.nodes.find((n) => n.id === id)?.metadata.groupId).toBe(
        outer,
      );
    }
  });

  it("is a single undo step", () => {
    const { a, b } = twoSelected();
    __flushCanvasHistoryForTests();
    const groupId = groupSelectedNodes();
    if (!groupId) throw new Error("expected a group");
    __flushCanvasHistoryForTests();

    undo();
    const state = getCanvasState();
    expect(state.nodes.find((n) => n.id === groupId)).toBeUndefined();
    expect(state.nodes.find((n) => n.id === a.id)?.metadata.groupId).toBe(
      undefined,
    );
    expect(state.nodes.find((n) => n.id === b.id)?.metadata.groupId).toBe(
      undefined,
    );
  });
});

describe("ungroupSelectedNodes", () => {
  it("removes the group and releases its members", () => {
    const { a, b } = twoSelected();
    const groupId = groupSelectedNodes();
    if (!groupId) throw new Error("expected a group");

    expect(ungroupSelectedNodes()).toBe(true);
    const state = getCanvasState();
    expect(state.nodes.find((n) => n.id === groupId)).toBeUndefined();
    expect(state.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    for (const id of [a.id, b.id]) {
      expect(
        state.nodes.find((n) => n.id === id)?.metadata.groupId,
      ).toBeUndefined();
    }
  });

  it("drops the edges the removed group carried", () => {
    twoSelected();
    const groupId = groupSelectedNodes();
    if (!groupId) throw new Error("expected a group");
    const target = addNode({ type: "image", title: "目标" });
    connectNodes(groupId, target.id);
    selectNodes([groupId]);

    ungroupSelectedNodes();
    expect(getCanvasState().connections).toHaveLength(0);
  });

  it("releasing one selected member leaves the group and its others intact", () => {
    const { a, b } = twoSelected();
    const c = addNode({ type: "text", title: "C" });
    selectNodes([a.id, b.id, c.id]);
    const groupId = groupSelectedNodes();
    if (!groupId) throw new Error("expected a group");

    selectNodes([a.id]);
    expect(ungroupSelectedNodes()).toBe(true);
    const state = getCanvasState();
    expect(state.nodes.find((n) => n.id === groupId)).toBeDefined();
    expect(
      state.nodes.find((n) => n.id === a.id)?.metadata.groupId,
    ).toBeUndefined();
    expect(state.nodes.find((n) => n.id === b.id)?.metadata.groupId).toBe(
      groupId,
    );
    expect(state.nodes.find((n) => n.id === c.id)?.metadata.groupId).toBe(
      groupId,
    );
  });

  it("is a no-op on a selection with no grouping", () => {
    twoSelected();
    expect(ungroupSelectedNodes()).toBe(false);
  });
});
