import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachBatchChildren,
  toggleBatchExpanded,
} from "../src/lib/canvas/canvas-batch";

// Mock hooks used by TeamStepNodeContent to avoid a QueryClient requirement
// when rendering via renderToStaticMarkup (same pattern as hover-toolbar.test.tsx).
vi.mock("../src/hooks/use-teams", () => ({
  useTeamBoard: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("../src/hooks/use-team-workflows", () => ({
  useWorkflowApprovals: () => ({ data: undefined }),
  useApproveWorkflowStep: () => ({ mutate: vi.fn() }),
}));
import { __resetCanvasBoardsForTests } from "../src/lib/canvas/canvas-boards";
import {
  __flushCanvasHistoryForTests,
  __resetCanvasForTests,
  addNode,
  connectNodes,
  exportCanvas,
  getCanvasState,
  importCanvas,
  moveNodes,
  redo,
  removeNodes,
  selectConnection,
  selectNodes,
  undo,
  upsertA2UINode,
} from "../src/lib/canvas/canvas-store";
import { CanvasBoardTitle } from "../src/lib/canvas/canvas-toolbar";
import {
  __resetCanvasUiPrefsForTests,
  setCanvasUiPref,
} from "../src/lib/canvas/canvas-ui-prefs";
import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  CONNECT_MENU_ITEMS,
  CanvasSurface,
  clampScale,
  connectionPath,
  fitViewport,
  gridBackgroundSize,
  gridBackgroundStyle,
  topmostNodeAtPoint,
  zoomAtPoint,
} from "../src/lib/canvas/infinite-canvas";
import { shouldStoreNaturalSize } from "../src/lib/canvas/node-views";

// Plain-Node test env: minimal localStorage so the store's geometry
// persistence paths run instead of throwing.
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
  __resetCanvasUiPrefsForTests();
  __resetCanvasBoardsForTests();
});

describe("viewport math", () => {
  it("zoomAtPoint keeps the point under the pointer fixed", () => {
    const viewport = { x: 0, y: 0, scale: 1 };
    const pointer = { x: 100, y: 50 };
    const next = zoomAtPoint(viewport, pointer, 2);
    expect(100 * next.scale + next.x).toBeCloseTo(pointer.x);
    expect(50 * next.scale + next.y).toBeCloseTo(pointer.y);
  });

  it("clamps scale to 0.05–5 range", () => {
    expect(CANVAS_MIN_SCALE).toBe(0.05);
    expect(CANVAS_MAX_SCALE).toBe(5);
    expect(
      zoomAtPoint({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 99).scale,
    ).toBe(CANVAS_MAX_SCALE);
    expect(clampScale(0.001)).toBe(CANVAS_MIN_SCALE);
  });

  it("fitViewport uses real node sizes", () => {
    const nodes = [
      { position: { x: 0, y: 0 }, size: { width: 380, height: 300 } },
      { position: { x: 900, y: 700 }, size: { width: 380, height: 300 } },
    ];
    const fitted = fitViewport(nodes, { width: 400, height: 500 });
    expect(fitted.scale).toBeLessThan(1);
    expect(fitted.scale).toBeGreaterThanOrEqual(CANVAS_MIN_SCALE);
  });

  it("connectionPath bends between anchors", () => {
    const path = connectionPath({ x: 0, y: 0 }, { x: 200, y: 100 });
    expect(path).toMatch(/^M 0 0 C /);
    expect(path).toContain("200 100");
  });
});

describe("grid LOD", () => {
  it("gridBackgroundSize returns pixel size at scale 1", () => {
    expect(gridBackgroundSize(1)).toBe(24);
  });

  it("gridBackgroundSize returns null at min scale 0.05 (1.2px < 4px threshold)", () => {
    expect(gridBackgroundSize(0.05)).toBeNull();
  });

  it("gridBackgroundSize returns value at boundary scale 4/24 (exactly 4px)", () => {
    const boundaryScale = 4 / 24;
    expect(gridBackgroundSize(boundaryScale)).toBe(4);
  });

  it("gridBackgroundSize returns null just below the 4px threshold", () => {
    // (4/24 - epsilon) * 24 < 4
    const justBelow = 4 / 24 - 0.001;
    expect(gridBackgroundSize(justBelow)).toBeNull();
  });
});

describe("canvas store", () => {
  it("adds nodes, connects them, and rejects self/duplicate edges", () => {
    const a = addNode({ type: "text", title: "A" });
    const b = addNode({ type: "text", title: "B" });
    expect(connectNodes(a.id, a.id)).toBeNull();
    const edge = connectNodes(a.id, b.id);
    expect(edge).not.toBeNull();
    expect(connectNodes(a.id, b.id)).toBeNull(); // duplicate
    expect(getCanvasState().connections).toHaveLength(1);
  });

  it("rejects a connection referencing a node id that doesn't exist", () => {
    const a = addNode({ type: "text", title: "A" });
    expect(connectNodes(a.id, "does-not-exist")).toBeNull();
    expect(connectNodes("does-not-exist", a.id)).toBeNull();
    expect(connectNodes("ghost-1", "ghost-2")).toBeNull();
    expect(getCanvasState().connections).toHaveLength(0);
  });

  it("moveNodes moves a multi-selection in one state update", () => {
    const a = addNode({ type: "text", title: "A" });
    const b = addNode({ type: "text", title: "B" });
    moveNodes([
      { id: a.id, position: { x: 10, y: 20 } },
      { id: b.id, position: { x: 30, y: 40 } },
    ]);
    const state = getCanvasState();
    expect(state.nodes.find((n) => n.id === a.id)?.position).toEqual({
      x: 10,
      y: 20,
    });
    expect(state.nodes.find((n) => n.id === b.id)?.position).toEqual({
      x: 30,
      y: 40,
    });
  });

  it("removing a node cascades its connections", () => {
    const a = addNode({ type: "text", title: "A" });
    const b = addNode({ type: "text", title: "B" });
    connectNodes(a.id, b.id);
    removeNodes([a.id]);
    const state = getCanvasState();
    expect(state.nodes.map((n) => n.id)).toEqual([b.id]);
    expect(state.connections).toHaveLength(0);
  });

  it("removing a node clears selectedConnectionId when the selection is cascade-deleted", () => {
    const a = addNode({ type: "text", title: "A" });
    const b = addNode({ type: "text", title: "B" });
    const edge = connectNodes(a.id, b.id);
    selectConnection(edge?.id ?? null);
    expect(getCanvasState().selectedConnectionId).toBe(edge?.id);
    removeNodes([a.id]);
    expect(getCanvasState().selectedConnectionId).toBeNull();
  });

  it("removing a node preserves selectedConnectionId when an unrelated connection is selected", () => {
    const a = addNode({ type: "text", title: "A" });
    const b = addNode({ type: "text", title: "B" });
    const c = addNode({ type: "text", title: "C" });
    connectNodes(a.id, b.id);
    const untouched = connectNodes(b.id, c.id);
    selectConnection(untouched?.id ?? null);
    removeNodes([a.id]);
    expect(getCanvasState().selectedConnectionId).toBe(untouched?.id);
  });

  it("undo/redo restores node and connection snapshots", () => {
    const a = addNode({ type: "text", title: "A" });
    __flushCanvasHistoryForTests();
    const b = addNode({ type: "text", title: "B" });
    connectNodes(a.id, b.id);
    __flushCanvasHistoryForTests();

    undo(); // back to just A
    expect(getCanvasState().nodes).toHaveLength(1);
    expect(getCanvasState().connections).toHaveLength(0);

    redo();
    expect(getCanvasState().nodes).toHaveLength(2);
    expect(getCanvasState().connections).toHaveLength(1);
  });

  it("export skips a2ui nodes and import round-trips portable ones", () => {
    upsertA2UINode("sidebar:run-1", "运行", [], () => {});
    const t = addNode({
      type: "text",
      title: "note",
      metadata: { content: "hello" },
    });
    const img = addNode({
      type: "image",
      title: "pic",
      metadata: { content: "data:image/png;base64,x" },
    });
    connectNodes(t.id, img.id);
    // Connection touching the a2ui node must not be exported either.
    const a2uiNode = getCanvasState().nodes.find((n) => n.type === "a2ui");
    if (a2uiNode) connectNodes(a2uiNode.id, t.id);

    const file = exportCanvas();
    expect(file.app).toBe("nexu-canvas");
    expect(file.nodes.map((n) => n.type).sort()).toEqual(["image", "text"]);
    expect(file.connections).toHaveLength(1);

    __resetCanvasForTests();
    importCanvas(file);
    const state = getCanvasState();
    expect(state.nodes).toHaveLength(2);
    expect(state.connections).toHaveLength(1);
    expect(state.nodes[0]?.metadata.content).toBe("hello");
  });

  it("importCanvas remaps ids, strips surfaceId, and validates connection endpoints", () => {
    // Live store has one node with a known id.
    const live = addNode({ type: "text", title: "live" });
    const liveId = live.id;

    // Craft a file whose two imported nodes reuse the SAME id as the live node
    // and include a metadata.surfaceId that must be stripped.
    const importedRawId1 = liveId; // deliberate collision
    const importedRawId2 = "imported-node-2";
    const file = {
      app: "nexu-canvas" as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      nodes: [
        {
          id: importedRawId1,
          type: "text" as const,
          title: "imported-a",
          position: { x: 10, y: 10 },
          size: { width: 300, height: 180 },
          metadata: { surfaceId: "sneak", content: "keep-me" },
        },
        {
          id: importedRawId2,
          type: "image" as const,
          title: "imported-b",
          position: { x: 20, y: 20 },
          size: { width: 340, height: 240 },
          metadata: { surfaceId: "sneak2" },
        },
      ],
      connections: [
        {
          id: "old-conn-id",
          fromNodeId: importedRawId1,
          toNodeId: importedRawId2,
        },
        // This connection references an id not in the import set — must be dropped.
        {
          id: "dangling-conn-id",
          fromNodeId: importedRawId1,
          toNodeId: "ghost-node",
        },
      ],
    };

    importCanvas(file);
    const state = getCanvasState();

    // Total nodes = 1 live + 2 imported (no replacement).
    expect(state.nodes).toHaveLength(3);

    // No duplicate ids in state.
    const allIds = state.nodes.map((n) => n.id);
    expect(new Set(allIds).size).toBe(3);

    // Imported nodes got new ids (neither kept the raw collision id).
    const importedNodes = state.nodes.filter((n) => n.id !== liveId);
    expect(importedNodes).toHaveLength(2);
    for (const n of importedNodes) {
      expect(n.id).not.toBe(importedRawId1);
      expect(n.id).not.toBe(importedRawId2);
    }

    // Only the valid connection survived; the dangling one was dropped.
    // Its endpoints are the NEW remapped ids.
    expect(state.connections).toHaveLength(1);
    const conn = state.connections[0];
    expect(conn).toBeDefined();
    const importedIds = new Set(importedNodes.map((n) => n.id));
    expect(importedIds.has(conn?.fromNodeId)).toBe(true);
    expect(importedIds.has(conn?.toNodeId)).toBe(true);

    // No imported node carries metadata.surfaceId.
    for (const n of importedNodes) {
      expect(n.metadata).not.toHaveProperty("surfaceId");
      // Other metadata is preserved.
    }
    // content from first imported node survived.
    const importedA = importedNodes.find((n) => n.title === "imported-a");
    expect(importedA?.metadata.content).toBe("keep-me");
  });

  it("upsertA2UINode refreshes in place instead of duplicating", () => {
    upsertA2UINode("sidebar:run-1", "运行", [], () => {});
    upsertA2UINode("sidebar:run-1", "运行", [], () => {});
    expect(
      getCanvasState().nodes.filter(
        (n) => n.metadata.surfaceId === "sidebar:run-1",
      ),
    ).toHaveLength(1);
  });
});

describe("topmostNodeAtPoint", () => {
  it("resolves to the visually topmost node, not the most-recently-created one", () => {
    // A text node created first, then a group created afterward that
    // overlaps it. Groups always render behind everything else, so the drop
    // should still hit the text node even though the group is later in
    // creation order.
    const text = addNode({
      type: "text",
      title: "note",
      position: { x: 0, y: 0 },
      size: { width: 300, height: 180 },
    });
    const group = addNode({
      type: "group",
      title: "group",
      position: { x: -50, y: -50 },
      size: { width: 800, height: 600 },
    });
    const point = { x: 50, y: 50 }; // inside both
    const hit = topmostNodeAtPoint(getCanvasState().nodes, point);
    expect(hit?.id).toBe(text.id);
    expect(hit?.id).not.toBe(group.id);
  });

  it("excludes the given node id even if it's the topmost match", () => {
    const a = addNode({
      type: "text",
      title: "A",
      position: { x: 0, y: 0 },
      size: { width: 300, height: 180 },
    });
    const b = addNode({
      type: "text",
      title: "B",
      position: { x: 0, y: 0 },
      size: { width: 300, height: 180 },
    });
    const point = { x: 50, y: 50 };
    expect(topmostNodeAtPoint(getCanvasState().nodes, point, b.id)?.id).toBe(
      a.id,
    );
  });

  it("returns undefined when nothing is under the point", () => {
    addNode({
      type: "text",
      title: "A",
      position: { x: 0, y: 0 },
      size: { width: 300, height: 180 },
    });
    expect(
      topmostNodeAtPoint(getCanvasState().nodes, { x: 9999, y: 9999 }),
    ).toBeUndefined();
  });
});

describe("CanvasSurface", () => {
  it("renders nodes, edges, toolbar and selection state from the store", () => {
    const a = addNode({
      type: "text",
      title: "初稿",
      position: { x: 0, y: 0 },
    });
    const b = addNode({
      type: "image",
      title: "配图",
      position: { x: 500, y: 100 },
    });
    connectNodes(a.id, b.id);

    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain('data-infinite-canvas="true"');
    expect(markup).toContain(`data-canvas-node="${a.id}"`);
    expect(markup).toContain(`data-canvas-node="${b.id}"`);
    expect(markup).toContain("data-canvas-edge=");
    expect(markup).toContain('data-canvas-toolbar="true"');
    // addNode selects the newest node.
    expect(markup).toContain("data-canvas-node-selected");
    expect(markup).toContain("初稿");
    expect(markup).toContain("配图");
  });

  it("keeps the smooth-interaction contract: select-none container, transform-positioned nodes", () => {
    addNode({ type: "text", title: "T", position: { x: 500, y: 100 } });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    // Dragging must never start a text selection…
    expect(markup).toContain("select-none");
    // …and nodes are compositor-positioned (no per-frame layout).
    expect(markup).toContain("translate3d(500px, 100px, 0)");
    expect(markup).toContain("contain:layout style");
  });

  it("uses the arrow cursor by default and reserves grab for explicit canvas panning", () => {
    const markup = renderToStaticMarkup(<CanvasSurface />);

    expect(markup).toContain("cursor-default");
    expect(markup).not.toContain("data-[space-pan]:cursor-grab");
  });

  it("does not let hidden node actions capture pointer hover", () => {
    addNode({ type: "text", title: "Unselected" });
    addNode({ type: "text", title: "Selected" });
    const markup = renderToStaticMarkup(<CanvasSurface />);

    expect(markup).toContain(
      "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
    );
  });

  it("renders the expired placeholder for an a2ui node without payload", () => {
    addNode({
      type: "a2ui",
      title: "旧运行",
      metadata: { surfaceId: "sidebar:gone" },
    });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("内容已过期");
  });

  it("context menu is NOT in default markup (closed-by-default contract)", () => {
    addNode({ type: "text", title: "节点" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    // The menu should only appear after a right-click — absent in static render.
    expect(markup).not.toContain("data-canvas-context-menu");
  });

  it("connect menu is NOT in default markup (closed-by-default contract)", () => {
    addNode({ type: "text", title: "节点" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    // The connect menu only appears after a connect-drop on empty canvas.
    expect(markup).not.toContain("data-canvas-connect-menu");
  });

  it("renders all four corner resize handles for a node", () => {
    addNode({ type: "text", title: "节点" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain('data-resize-corner="nw"');
    expect(markup).toContain('data-resize-corner="ne"');
    expect(markup).toContain('data-resize-corner="sw"');
    expect(markup).toContain('data-resize-corner="se"');
  });

  it("renders both a target (left) and source (right) connect handle per node (reference parity)", () => {
    const node = addNode({ type: "text", title: "节点" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain(`data-canvas-connect-handle-target="${node.id}"`);
    expect(markup).toContain(`data-canvas-connect-handle-source="${node.id}"`);
  });

  it("renders lock toggle button for image node with content, absent for text node", () => {
    addNode({
      type: "image",
      title: "pic",
      metadata: { content: "data:image/png;base64,x" },
    });
    addNode({ type: "text", title: "note" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    // Lock toggle only on the image node (it has content)
    expect(markup).toContain("data-canvas-lock-toggle");
    // aria-label present
    expect(markup).toContain("toggle aspect ratio lock");
  });

  it("lock toggle absent for text node", () => {
    addNode({ type: "text", title: "only text" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain("data-canvas-lock-toggle");
  });

  it("lock toggle absent for image node without content", () => {
    addNode({ type: "image", title: "empty image" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain("data-canvas-lock-toggle");
  });

  it("text node display and edit modes opt out of canvas wheel-zoom so long content scrolls natively", () => {
    addNode({
      type: "text",
      title: "笔记",
      metadata: { content: "一段很长的文字…" },
    });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("data-canvas-text-display");
    expect(markup).toContain('data-canvas-wheel-exempt="true"');
    expect(markup).toContain("overflow-y-auto");
  });

  it("a node with task.status=generating renders data-canvas-node-generating", () => {
    addNode({
      type: "image",
      title: "生成中",
      metadata: {
        task: { status: "generating", retry: { kind: "image", prompt: "sky" } },
      },
    });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("data-canvas-node-generating");
  });

  it("a node with task.status=error renders data-canvas-node-retry", () => {
    addNode({
      type: "image",
      title: "错误节点",
      metadata: {
        task: {
          status: "error",
          error: "生成失败，请重试",
          retry: { kind: "image", prompt: "sunset" },
        },
      },
    });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("data-canvas-node-retry");
  });

  it("text node default markup contains data-canvas-text-display (display mode)", () => {
    addNode({ type: "text", title: "note", metadata: {} });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("data-canvas-text-display");
  });

  it("text node default markup contains placeholder 双击编辑文字 for empty content", () => {
    addNode({ type: "text", title: "note", metadata: {} });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("双击编辑文字");
  });

  it("text node default markup does NOT contain textarea (edit mode entered by interaction only)", () => {
    addNode({ type: "text", title: "note", metadata: {} });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain("<textarea");
  });
});

describe("group node markup", () => {
  it("renders a group's inert body, NOT the image upload/generate UI (node-views trap)", () => {
    const group = addNode({ type: "group", title: "组" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    // Group frame + inert container body are present…
    expect(markup).toContain(`data-canvas-node="${group.id}"`);
    expect(markup).toContain('data-canvas-group-body="true"');
    // …and it must NOT fall through to the empty-image upload/generate node.
    expect(markup).not.toContain(`data-canvas-generate-image="${group.id}"`);
    expect(markup).not.toContain("上传或在下方生成");
  });

  it("renders group nodes before (behind) other nodes regardless of store order", () => {
    // Add a non-group node FIRST, then the group — store order is [text, group].
    const text = addNode({
      type: "text",
      title: "文本",
      position: { x: 900, y: 0 },
    });
    const group = addNode({
      type: "group",
      title: "组",
      position: { x: 0, y: 0 },
    });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    const groupAt = markup.indexOf(`data-canvas-node="${group.id}"`);
    const textAt = markup.indexOf(`data-canvas-node="${text.id}"`);
    expect(groupAt).toBeGreaterThanOrEqual(0);
    expect(textAt).toBeGreaterThanOrEqual(0);
    // Earlier in the markup = painted first = behind.
    expect(groupAt).toBeLessThan(textAt);
  });

  it("gives a group minimal chrome — no hover toolbar", () => {
    const group = addNode({ type: "group", title: "组" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain(`data-canvas-hover-toolbar="${group.id}"`);
  });

  it("a group node feeds downstream but takes no input — source handle only", () => {
    const group = addNode({ type: "group", title: "组" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    // No target handle: a group holds no content of its own for an incoming
    // edge to feed.
    expect(markup).not.toContain(
      `data-canvas-connect-handle-target="${group.id}"`,
    );
    // Source handle: one edge out of a group references every resource in it
    // (resource-references.ts expands members).
    expect(markup).toContain(`data-canvas-connect-handle-source="${group.id}"`);
  });

  it("a multi-selection draws one dashed box — a preview of the group ⌘G would build", () => {
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
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain('data-canvas-selection-box="true"');
  });

  it("a single selection draws no selection box", () => {
    const a = addNode({ type: "text", title: "A" });
    selectNodes([a.id]);
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain('data-canvas-selection-box="true"');
  });

  it("a team-step node renders no connect handles either", () => {
    const step = addNode({
      type: "team-step",
      title: "step-1",
      metadata: {
        step: { teamId: "t1", cardId: "c1", assigneeName: "Agent" },
      },
    });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain(
      `data-canvas-connect-handle-target="${step.id}"`,
    );
    expect(markup).not.toContain(
      `data-canvas-connect-handle-source="${step.id}"`,
    );
  });

  it("an ordinary text node still gets both connect handles", () => {
    const text = addNode({ type: "text", title: "note" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain(`data-canvas-connect-handle-target="${text.id}"`);
    expect(markup).toContain(`data-canvas-connect-handle-source="${text.id}"`);
  });

  it("a phone node exposes both handles so XHS can link its publish device", () => {
    const phone = addNode({
      type: "phone",
      title: "手机预览",
      metadata: { phone: { deviceId: "device-a" } },
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <CanvasSurface />
      </QueryClientProvider>,
    );
    expect(markup).toContain(`data-canvas-connect-handle-target="${phone.id}"`);
    expect(markup).toContain(`data-canvas-connect-handle-source="${phone.id}"`);
  });
});

describe("PromptPanel visibility", () => {
  it("single selected image node renders data-canvas-prompt-panel with 生成 button", () => {
    // addNode selects the newest node automatically
    addNode({ type: "image", title: "图片" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("data-canvas-prompt-panel=");
    expect(markup).toContain("data-canvas-panel-generate");
    expect(markup).toContain("生成");
  });

  it("two nodes selected: prompt panel is absent", () => {
    const a = addNode({ type: "image", title: "A" });
    const b = addNode({ type: "image", title: "B" });
    // Force multi-selection
    selectNodes([a.id, b.id]);
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain("data-canvas-prompt-panel");
  });

  it("single selected text node: prompt panel is absent", () => {
    addNode({ type: "text", title: "文本" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain("data-canvas-prompt-panel");
  });

  it("single selected video node renders panel", () => {
    addNode({ type: "video", title: "视频" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("data-canvas-prompt-panel=");
  });

  it("single selected audio node renders panel", () => {
    addNode({ type: "audio", title: "音频" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("data-canvas-prompt-panel=");
  });

  it("single selected config node does NOT render data-canvas-prompt-panel", () => {
    addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "image" } },
    });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    // Config nodes have their own inline UI — the media prompt panel must not appear.
    expect(markup).not.toContain("data-canvas-prompt-panel");
    // But the config generate button must appear.
    expect(markup).toContain("data-canvas-config-generate");
  });
});

describe("ConfigNode markup", () => {
  it("config node renders data-canvas-config-generate and mode labels", () => {
    addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "image" } },
    });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("data-canvas-config-generate");
    // Mode labels must be present in the segmented control
    expect(markup).toContain("图");
    expect(markup).toContain("视频");
    expect(markup).toContain("音频");
  });

  it("toolbar contains config, XHS, and phone node buttons", () => {
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("生成配置");
    expect(markup).toContain("小红书");
    expect(markup).toContain("手机");
  });

  it("config node never shows 参考视频/参考音频 chips — no mode forwards them to generation", () => {
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "image" } },
    });
    const videoSource = addNode({
      type: "video",
      title: "视频",
      metadata: { content: "/api/v1/media/state-file?path=%2Fv.mp4" },
    });
    const audioSource = addNode({
      type: "audio",
      title: "音频",
      metadata: { content: "/api/v1/media/state-file?path=%2Fa.mp3" },
    });
    connectNodes(videoSource.id, config.id);
    connectNodes(audioSource.id, config.id);

    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain("参考视频");
    expect(markup).not.toContain("参考音频");
  });

  it("config node shows 参考图 only in image mode — other modes never forward image references", () => {
    addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "image" } },
    });
    expect(renderToStaticMarkup(<CanvasSurface />)).toContain("参考图");

    __resetCanvasForTests();
    addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "text" } },
    });
    expect(renderToStaticMarkup(<CanvasSurface />)).not.toContain("参考图");
  });

  it("connect menu offers all creatable types (real menu constant)", () => {
    // The menu only renders after a connect-drop gesture (unreachable in
    // static markup), so the contract is pinned on the exported constant
    // that drives the menu JSX.
    expect(CONNECT_MENU_ITEMS.map((item) => item.type)).toEqual([
      "text",
      "image",
      "video",
      "audio",
      "config",
      "xhs",
      "phone",
    ]);
    expect(CONNECT_MENU_ITEMS.map((item) => item.label)).toEqual([
      "文本",
      "图片",
      "视频",
      "音频",
      "配置",
      "小红书",
      "手机",
    ]);
  });
});

describe("CanvasMinimap markup", () => {
  it("minimap present with a node and pref on (default)", () => {
    addNode({ type: "text", title: "节点A" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain('data-canvas-minimap="true"');
  });

  it("minimap present with zero nodes (default empty-world bounds)", () => {
    // no nodes added — reference parity: the minimap stays visible on an
    // empty board so the toolbar toggle always has a visible effect
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain('data-canvas-minimap="true"');
    // viewport outline still rendered against the default world bounds
    expect(markup).toContain('data-canvas-minimap-viewport="true"');
  });

  it("minimap absent when minimapVisible pref is off", () => {
    setCanvasUiPref("minimapVisible", false);
    addNode({ type: "text", title: "节点A" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain('data-canvas-minimap="true"');
    // restore for other tests
    __resetCanvasUiPrefsForTests();
  });

  it("minimap toggle moved into the appearance panel (not the dock)", () => {
    // Showing/hiding a panel is a display preference, so the switch now
    // lives beside 网格样式 / 图片信息 rather than on the dock. Like those
    // two it is only in the markup once the panel is open; the dock keeps
    // the trigger that reaches it.
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("data-canvas-appearance-toggle");
    expect(markup).not.toContain('data-canvas-minimap-toggle="true"');
  });

  it("minimap node rects rendered for visible nodes only (data-canvas-minimap-node)", () => {
    const root = addNode({ type: "image", title: "root" });
    attachBatchChildren(root.id, [
      { url: "data:image/png;base64,A" },
      { url: "data:image/png;base64,B" },
    ]);
    // collapse the batch so children are hidden
    toggleBatchExpanded(root.id);

    const markup = renderToStaticMarkup(<CanvasSurface />);
    // Minimap present (at least root is visible)
    expect(markup).toContain('data-canvas-minimap="true"');
    // Count occurrences of data-canvas-minimap-node= — should equal number of visible nodes
    const matches = markup.match(/data-canvas-minimap-node=/g) ?? [];
    // Only the root (1) should appear, hidden children excluded
    expect(matches.length).toBe(1);
  });

  it("viewport outline is rendered inside minimap", () => {
    addNode({ type: "text", title: "T" });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain('data-canvas-minimap-viewport="true"');
  });
});

describe("connection effects", () => {
  it("image → canvas XHS node appends the image once", async () => {
    const { applyConnectionEffects } = await import(
      "../src/lib/canvas/connection-effects"
    );
    const image = addNode({
      type: "image",
      title: "cover",
      metadata: { content: "data:image/png;base64,COVER" },
    });
    const xhs = addNode({
      type: "xhs",
      title: "post",
      metadata: {
        xhs: {
          title: "",
          content: "",
          images: [],
          hashtags: [],
        },
      },
    });

    applyConnectionEffects(image, xhs);
    applyConnectionEffects(image, xhs);

    const updated = getCanvasState().nodes.find((node) => node.id === xhs.id);
    expect(updated?.metadata.xhs?.images).toEqual([
      "data:image/png;base64,COVER",
    ]);
  });

  it("image → XHS editor connection feeds the post's image list", async () => {
    const { applyConnectionEffects } = await import(
      "../src/lib/canvas/connection-effects"
    );
    const { seedBatch, getBatch } = await import(
      "../src/lib/a2ui/custom-components/xhs-batch-store"
    );
    __resetCanvasForTests();
    seedBatch("batch-1", [
      {
        id: "post-1",
        title: "t",
        content: "c",
        images: [],
        hashtags: [],
        deviceId: "",
      },
    ]);
    upsertA2UINode(
      "sidebar:xhs-editor-batch-1-post-1",
      "xhs",
      [
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: "sidebar:xhs-editor-batch-1-post-1",
            components: [
              {
                id: "xhs-editor",
                type: "XHSEditor",
                batchId: "batch-1",
                postId: "post-1",
              } as never,
            ],
          },
        },
      ],
      () => {},
    );
    const img = addNode({
      type: "image",
      title: "cover",
      metadata: { content: "data:image/png;base64,COVER" },
    });
    const editorNode = getCanvasState().nodes.find((n) => n.type === "a2ui");
    if (!editorNode) throw new Error("editor node missing");

    applyConnectionEffects(img, editorNode);
    applyConnectionEffects(img, editorNode); // dedupe

    expect(getBatch("batch-1").posts[0]?.images).toEqual([
      "data:image/png;base64,COVER",
    ]);
  });
});

// ── W4.2: gridBackgroundStyle ──────────────────────────────────────

describe("gridBackgroundStyle", () => {
  const viewport = { x: 10, y: 20 };

  it("dots mode: backgroundImage matches the existing radial-gradient output exactly", () => {
    const size = 24; // gridBackgroundSize(1) = 24
    const style = gridBackgroundStyle("dots", 1, viewport);
    expect(style).not.toBeNull();
    expect(style?.backgroundImage).toBe(
      "radial-gradient(circle, var(--color-border) 1px, transparent 1px)",
    );
    expect(style?.backgroundSize).toBe(`${size}px ${size}px`);
    expect(style?.backgroundPosition).toBe(
      `${viewport.x % size}px ${viewport.y % size}px`,
    );
  });

  it("lines mode: two linear-gradients", () => {
    const style = gridBackgroundStyle("lines", 1, viewport);
    expect(style).not.toBeNull();
    expect(style?.backgroundImage).toBe(
      "linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px)",
    );
  });

  it("blank mode → null", () => {
    expect(gridBackgroundStyle("blank", 1, viewport)).toBeNull();
  });

  it("LOD null (scale 0.05) → null for dots", () => {
    expect(gridBackgroundStyle("dots", 0.05, viewport)).toBeNull();
  });

  it("LOD null (scale 0.05) → null for lines", () => {
    expect(gridBackgroundStyle("lines", 0.05, viewport)).toBeNull();
  });
});

// ── W4.2: shouldStoreNaturalSize ──────────────────────────────────

describe("shouldStoreNaturalSize", () => {
  it("returns true when both naturalWidth and naturalHeight are absent", () => {
    expect(shouldStoreNaturalSize({}, 800, 600)).toBe(true);
  });

  it("returns false when dims match stored values exactly", () => {
    expect(
      shouldStoreNaturalSize(
        { naturalWidth: 800, naturalHeight: 600 },
        800,
        600,
      ),
    ).toBe(false);
  });

  it("returns true when width differs", () => {
    expect(
      shouldStoreNaturalSize(
        { naturalWidth: 400, naturalHeight: 600 },
        800,
        600,
      ),
    ).toBe(true);
  });

  it("returns true when height differs", () => {
    expect(
      shouldStoreNaturalSize(
        { naturalWidth: 800, naturalHeight: 300 },
        800,
        600,
      ),
    ).toBe(true);
  });

  it("returns false when w=0 (zero dims → skip)", () => {
    expect(shouldStoreNaturalSize({}, 0, 600)).toBe(false);
  });

  it("returns false when h=0 (zero dims → skip)", () => {
    expect(shouldStoreNaturalSize({}, 800, 0)).toBe(false);
  });
});

// ── W4.2: markup tests ────────────────────────────────────────────

describe("W4.2 appearance markup", () => {
  it("toolbar contains appearance toggle button", () => {
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("data-canvas-appearance-toggle");
  });

  it("appearance panel is ABSENT by default (panel closed)", () => {
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain("data-canvas-appearance-panel");
  });

  it("image node with dims+pref on renders image info badge", () => {
    setCanvasUiPref("showImageInfo", true);
    addNode({
      type: "image",
      title: "pic",
      metadata: {
        content: "data:image/png;base64,x",
        naturalWidth: 1920,
        naturalHeight: 1080,
      },
    });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).toContain("data-canvas-image-info");
    expect(markup).toContain("1920×1080");
  });

  it("image info badge absent when pref off", () => {
    // pref defaults to false
    addNode({
      type: "image",
      title: "pic",
      metadata: {
        content: "data:image/png;base64,x",
        naturalWidth: 1920,
        naturalHeight: 1080,
      },
    });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain("data-canvas-image-info");
  });

  it("image info badge absent when dims missing", () => {
    setCanvasUiPref("showImageInfo", true);
    addNode({
      type: "image",
      title: "pic",
      metadata: { content: "data:image/png;base64,x" },
    });
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain("data-canvas-image-info");
  });
});

// ── W4.4: board switcher markup ───────────────────────────────────

describe("W4.4 board switcher markup", () => {
  it("board switcher lives in the panel header, not the toolbar", () => {
    const markup = renderToStaticMarkup(<CanvasSurface />);
    expect(markup).not.toContain("data-canvas-board-switcher");
  });

  it("header title shows the switcher button with the active board name", () => {
    const markup = renderToStaticMarkup(<CanvasBoardTitle />);
    expect(markup).toContain("data-canvas-board-switcher");
    // default board name is 画布 1
    expect(markup).toContain("画布 1");
  });

  it("board popover is ABSENT by default (closed)", () => {
    const markup = renderToStaticMarkup(<CanvasBoardTitle />);
    expect(markup).not.toContain("data-canvas-board-panel");
  });
});
