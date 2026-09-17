/**
 * canvas-batch.test.ts
 *
 * Tests for batch image groups (W2.7) — new canvas-batch.ts module.
 * Covers:
 *   a. attachBatchChildren fan-out
 *   b. toggle + isHiddenBatchChild
 *   c. setBatchPrimary swap
 *   d. removeNodes cascade (root removes children; child cleans root)
 *   e. seam: mocked SDK multi-item response triggers fan-out
 *   f. importCanvas: batch group round-trips; orphan stripped
 *   g. clipboard: copying root yields independent image (no batch field)
 *   h. markup: collapsed ghost present, badge, hidden children absent
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachBatchChildren,
  isHiddenBatchChild,
  setBatchPrimary,
  toggleBatchExpanded,
} from "../src/lib/canvas/canvas-batch";
import {
  __resetCanvasClipboardForTests,
  copySelection,
  duplicateNodes,
  pasteClipboard,
} from "../src/lib/canvas/canvas-clipboard";
import { generateImageIntoNode } from "../src/lib/canvas/canvas-generation";
import {
  __resetCanvasForTests,
  addNode,
  exportCanvas,
  getCanvasState,
  importCanvas,
  removeNodes,
  selectNodes,
} from "../src/lib/canvas/canvas-store";
import { CanvasSurface } from "../src/lib/canvas/infinite-canvas";

// Minimal localStorage polyfill
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

const apiMocks = vi.hoisted(() => ({
  postApiV1MediaGenerateImage: vi.fn(),
  postApiV1MediaGenerateVideo: vi.fn(),
  postApiV1MediaGenerateAudio: vi.fn(),
}));

// Mock SDK for seam tests. Async job submission/polling is covered separately.
// The fake keeps the real submit-then-poll shape so the node picks up a job id.
const jobResults = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../lib/api/sdk.gen", () => apiMocks);
vi.mock("../src/lib/media/image-generation-jobs", () => ({
  submitImageGenerationJob: vi.fn(async (body: Record<string, unknown>) => {
    const response = await apiMocks.postApiV1MediaGenerateImage({ body });
    const jobId = `image-job-${jobResults.size + 1}`;
    jobResults.set(jobId, response);
    return jobId;
  }),
  waitForImageGenerationJob: vi.fn(async (jobId: string) => {
    const response = (jobResults.get(jobId) ?? {}) as {
      data?: unknown;
      error?: unknown;
    };
    if (!response.data || response.error) throw new Error("生成失败");
    return response.data;
  }),
}));

import { postApiV1MediaGenerateImage } from "../lib/api/sdk.gen";
const mockGenerateImage = vi.mocked(postApiV1MediaGenerateImage);

beforeEach(() => {
  __resetCanvasForTests();
  __resetCanvasClipboardForTests();
  vi.clearAllMocks();
  jobResults.clear();
});

// ── a. attachBatchChildren ─────────────────────────────────────

describe("a. attachBatchChildren", () => {
  it("root content = items[0].url, 2 children at expected positions, root childIds length 2, expanded true", () => {
    const root = addNode({
      type: "image",
      title: "sunrise",
      position: { x: 100, y: 200 },
      size: { width: 340, height: 240 },
    });

    const items = [
      { url: "http://srv/img/a.png" },
      { url: "http://srv/img/b.png" },
      { url: "http://srv/img/c.png" },
    ];
    attachBatchChildren(root.id, items);

    const state = getCanvasState();
    const rootNode = state.nodes.find((n) => n.id === root.id);
    expect(rootNode).toBeDefined();

    // Root content = items[0].url
    expect(rootNode?.metadata.content).toBe("http://srv/img/a.png");

    // Root batch: childIds length 2, expanded true
    expect(rootNode?.metadata.batch?.childIds).toHaveLength(2);
    expect(rootNode?.metadata.batch?.expanded).toBe(true);

    // Children exist with correct rootId
    const childIds = rootNode?.metadata.batch?.childIds ?? [];
    expect(childIds).toHaveLength(2);

    const child1 = state.nodes.find((n) => n.id === childIds[0]);
    const child2 = state.nodes.find((n) => n.id === childIds[1]);
    expect(child1?.metadata.batch?.rootId).toBe(root.id);
    expect(child2?.metadata.batch?.rootId).toBe(root.id);

    // Child content = items[1], items[2]
    expect(child1?.metadata.content).toBe("http://srv/img/b.png");
    expect(child2?.metadata.content).toBe("http://srv/img/c.png");

    // Child positions: root.x + root.width + 24 + (i-1)*24, root.y + (i-1)*24
    // child 1 (i=1): x = 100 + 340 + 24 + 0 = 464, y = 200 + 0 = 200
    // child 2 (i=2): x = 100 + 340 + 24 + 24 = 488, y = 200 + 24 = 224
    expect(child1?.position).toEqual({ x: 464, y: 200 });
    expect(child2?.position).toEqual({ x: 488, y: 224 });
  });

  it("child titles are <rootTitle> #2, #3, …", () => {
    const root = addNode({
      type: "image",
      title: "forest",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 240 },
    });
    const items = [
      { url: "http://srv/a.png" },
      { url: "http://srv/b.png" },
      { url: "http://srv/c.png" },
    ];
    attachBatchChildren(root.id, items);

    const state = getCanvasState();
    const rootNode = state.nodes.find((n) => n.id === root.id);
    const childIds = rootNode?.metadata.batch?.childIds ?? [];
    const child1 = state.nodes.find((n) => n.id === childIds[0]);
    const child2 = state.nodes.find((n) => n.id === childIds[1]);

    expect(child1?.title).toBe("forest #2");
    expect(child2?.title).toBe("forest #3");
  });

  it("single-item list: no children created, no batch field", () => {
    const root = addNode({
      type: "image",
      title: "sky",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 240 },
    });
    const items = [{ url: "http://srv/single.png" }];
    // attachBatchChildren with 1 item should be a no-op for batch
    attachBatchChildren(root.id, items);

    const state = getCanvasState();
    const rootNode = state.nodes.find((n) => n.id === root.id);
    // content set
    expect(rootNode?.metadata.content).toBe("http://srv/single.png");
    // no batch group (no children)
    expect(rootNode?.metadata.batch).toBeUndefined();
    // still only 1 node (root)
    expect(state.nodes).toHaveLength(1);
  });
});

// ── b. toggleBatchExpanded + isHiddenBatchChild ────────────────

describe("b. toggleBatchExpanded + isHiddenBatchChild", () => {
  it("toggle flips expanded; isHiddenBatchChild true only when root collapsed", () => {
    const root = addNode({
      type: "image",
      title: "test",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 240 },
    });
    const items = [{ url: "http://srv/a.png" }, { url: "http://srv/b.png" }];
    attachBatchChildren(root.id, items);

    const stateAfterAttach = getCanvasState();
    const rootNode = stateAfterAttach.nodes.find((n) => n.id === root.id);
    expect(rootNode?.metadata.batch?.expanded).toBe(true);

    const childId = rootNode?.metadata.batch?.childIds?.[0] as string;
    const childNode = stateAfterAttach.nodes.find((n) => n.id === childId);
    if (!childNode) throw new Error("child node missing");

    // When expanded=true, child is NOT hidden
    expect(isHiddenBatchChild(childNode, stateAfterAttach.nodes)).toBe(false);

    // Toggle → collapsed
    toggleBatchExpanded(root.id);

    const stateCollapsed = getCanvasState();
    const rootCollapsed = stateCollapsed.nodes.find((n) => n.id === root.id);
    expect(rootCollapsed?.metadata.batch?.expanded).toBe(false);

    const childCollapsed = stateCollapsed.nodes.find((n) => n.id === childId);
    if (!childCollapsed) throw new Error("child node missing after collapse");
    expect(isHiddenBatchChild(childCollapsed, stateCollapsed.nodes)).toBe(true);

    // Toggle again → expanded
    toggleBatchExpanded(root.id);

    const stateExpanded = getCanvasState();
    const childExpanded = stateExpanded.nodes.find((n) => n.id === childId);
    if (!childExpanded) throw new Error("child node missing after expand");
    expect(isHiddenBatchChild(childExpanded, stateExpanded.nodes)).toBe(false);
  });

  it("isHiddenBatchChild returns false for a root node (not a child)", () => {
    const root = addNode({
      type: "image",
      title: "root",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 240 },
    });
    attachBatchChildren(root.id, [
      { url: "http://srv/a.png" },
      { url: "http://srv/b.png" },
    ]);
    toggleBatchExpanded(root.id);
    const state = getCanvasState();
    const rootNode = state.nodes.find((n) => n.id === root.id);
    if (!rootNode) throw new Error("root node missing");
    // Root is never hidden (it has no rootId)
    expect(isHiddenBatchChild(rootNode, state.nodes)).toBe(false);
  });

  it("isHiddenBatchChild returns false when root is missing (orphan)", () => {
    // A node with rootId pointing at a non-existent root
    const orphan = addNode({
      type: "image",
      title: "orphan",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 240 },
      metadata: { batch: { rootId: "ghost-root-id" } },
    });
    const state = getCanvasState();
    expect(isHiddenBatchChild(orphan, state.nodes)).toBe(false);
  });
});

// ── c. setBatchPrimary ─────────────────────────────────────────

describe("c. setBatchPrimary", () => {
  it("swaps content + title between child and root (both directions)", () => {
    const root = addNode({
      type: "image",
      title: "root-title",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 240 },
    });
    const items = [
      { url: "http://srv/root.png" },
      { url: "http://srv/child.png" },
    ];
    attachBatchChildren(root.id, items);

    const state1 = getCanvasState();
    const rootNode1 = state1.nodes.find((n) => n.id === root.id);
    if (!rootNode1) throw new Error("root missing");
    const childId = rootNode1.metadata.batch?.childIds?.[0] as string;
    const childNode1 = state1.nodes.find((n) => n.id === childId);
    if (!childNode1) throw new Error("child missing");

    expect(rootNode1.metadata.content).toBe("http://srv/root.png");
    expect(childNode1.metadata.content).toBe("http://srv/child.png");

    // Swap: promote child to primary
    setBatchPrimary(childId);

    const state2 = getCanvasState();
    const rootAfter = state2.nodes.find((n) => n.id === root.id);
    const childAfter = state2.nodes.find((n) => n.id === childId);
    if (!rootAfter || !childAfter) throw new Error("nodes missing after swap");

    // Content swapped
    expect(rootAfter.metadata.content).toBe("http://srv/child.png");
    expect(childAfter.metadata.content).toBe("http://srv/root.png");

    // Title swapped
    expect(rootAfter.title).toBe(childNode1.title);
    expect(childAfter.title).toBe("root-title");

    // Batch linkage unchanged
    expect(rootAfter.metadata.batch?.childIds).toContain(childId);
    expect(childAfter.metadata.batch?.rootId).toBe(root.id);

    // Swap back
    setBatchPrimary(childId);

    const state3 = getCanvasState();
    const rootFinal = state3.nodes.find((n) => n.id === root.id);
    const childFinal = state3.nodes.find((n) => n.id === childId);
    if (!rootFinal || !childFinal)
      throw new Error("nodes missing after swap back");

    expect(rootFinal.metadata.content).toBe("http://srv/root.png");
    expect(childFinal.metadata.content).toBe("http://srv/child.png");
  });
});

// ── d. removeNodes cascade ─────────────────────────────────────

describe("d. removeNodes cascade", () => {
  it("removeNodes(root) removes all children too", () => {
    const root = addNode({
      type: "image",
      title: "root",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 240 },
    });
    const items = [
      { url: "http://srv/a.png" },
      { url: "http://srv/b.png" },
      { url: "http://srv/c.png" },
    ];
    attachBatchChildren(root.id, items);

    const stateBefore = getCanvasState();
    expect(stateBefore.nodes).toHaveLength(3); // root + 2 children

    removeNodes([root.id]);

    const stateAfter = getCanvasState();
    expect(stateAfter.nodes).toHaveLength(0);
  });

  it("removeNodes(child) cleans root childIds", () => {
    const root = addNode({
      type: "image",
      title: "root",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 240 },
    });
    const items = [
      { url: "http://srv/a.png" },
      { url: "http://srv/b.png" },
      { url: "http://srv/c.png" },
    ];
    attachBatchChildren(root.id, items);

    const state1 = getCanvasState();
    const rootNode1 = state1.nodes.find((n) => n.id === root.id);
    if (!rootNode1) throw new Error("root missing");
    const childIds = rootNode1.metadata.batch?.childIds ?? [];
    expect(childIds).toHaveLength(2);

    // Remove first child
    removeNodes([childIds[0] as string]);

    const state2 = getCanvasState();
    const rootNode2 = state2.nodes.find((n) => n.id === root.id);
    if (!rootNode2) throw new Error("root missing after child removal");
    expect(rootNode2.metadata.batch?.childIds).toHaveLength(1);
    expect(rootNode2.metadata.batch?.childIds).not.toContain(childIds[0]);
    // Second child still exists
    expect(state2.nodes.find((n) => n.id === childIds[1])).toBeDefined();
  });

  it("removeNodes with both root and child: root cascade wins (no double processing)", () => {
    const root = addNode({
      type: "image",
      title: "root",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 240 },
    });
    attachBatchChildren(root.id, [
      { url: "http://srv/a.png" },
      { url: "http://srv/b.png" },
    ]);

    const state1 = getCanvasState();
    const rootNode1 = state1.nodes.find((n) => n.id === root.id);
    if (!rootNode1) throw new Error("root missing");
    const childId = rootNode1.metadata.batch?.childIds?.[0] as string;

    // Remove both root and child in same call — no errors
    removeNodes([root.id, childId]);

    const state2 = getCanvasState();
    expect(state2.nodes).toHaveLength(0);
  });
});

// ── e. seam: mocked SDK 3-item / 1-item ───────────────────────

describe("e. seam: batch fan-out from generateImageIntoNode", () => {
  it("3-item success → 2 children exist, root has batch.childIds", async () => {
    const node = addNode({
      type: "image",
      title: "mountain",
      position: { x: 100, y: 100 },
      size: { width: 340, height: 240 },
    });

    mockGenerateImage.mockResolvedValueOnce({
      data: {
        url: "http://srv/img/1.png",
        path: "/img/1.png",
        items: [
          { url: "http://srv/img/1.png", path: "/img/1.png" },
          { url: "http://srv/img/2.png", path: "/img/2.png" },
          { url: "http://srv/img/3.png", path: "/img/3.png" },
        ],
      },
      error: undefined,
      response: new Response(),
    } as never);

    const result = await generateImageIntoNode(node.id, "mountain");
    expect(result).toBe(true);

    const state = getCanvasState();
    const rootNode = state.nodes.find((n) => n.id === node.id);
    expect(rootNode?.metadata.batch?.childIds).toHaveLength(2);
    expect(rootNode?.metadata.batch?.expanded).toBe(true);
    // Children actually exist
    const childIds = rootNode?.metadata.batch?.childIds ?? [];
    for (const childId of childIds) {
      expect(state.nodes.find((n) => n.id === childId)).toBeDefined();
    }
  });

  it("single-item success → no batch field, existing behavior preserved", async () => {
    const node = addNode({
      type: "image",
      title: "sky",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 240 },
    });

    mockGenerateImage.mockResolvedValueOnce({
      data: {
        url: "http://srv/img/sky.png",
        path: "/img/sky.png",
        items: [{ url: "http://srv/img/sky.png", path: "/img/sky.png" }],
      },
      error: undefined,
      response: new Response(),
    } as never);

    const result = await generateImageIntoNode(node.id, "sky");
    expect(result).toBe(true);

    const state = getCanvasState();
    const updated = state.nodes.find((n) => n.id === node.id);
    expect(updated?.metadata.content).toBe("http://srv/img/sky.png");
    expect(updated?.metadata.batch).toBeUndefined();
    expect(state.nodes).toHaveLength(1);
  });
});

// ── f. importCanvas batch round-trip + orphan strip ───────────

describe("f. importCanvas: batch remapping + orphan stripping", () => {
  it("batch group round-trips: childIds and rootId point at new ids after import", () => {
    const root = addNode({
      type: "image",
      title: "root",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 240 },
    });
    // 3 items → root + 2 children = 3 nodes total
    attachBatchChildren(root.id, [
      { url: "http://srv/a.png" },
      { url: "http://srv/b.png" },
      { url: "http://srv/c.png" },
    ]);

    const file = exportCanvas();
    expect(file.nodes).toHaveLength(3); // sanity check before reset

    __resetCanvasForTests();

    importCanvas(file);

    const state = getCanvasState();
    // 3 nodes total (root + 2 children)
    expect(state.nodes).toHaveLength(3);

    // Find the new root (by checking which has childIds)
    const newRoot = state.nodes.find(
      (n) => n.metadata.batch?.childIds !== undefined,
    );
    expect(newRoot).toBeDefined();

    const newChildIds = newRoot?.metadata.batch?.childIds ?? [];
    expect(newChildIds).toHaveLength(2);

    // Both child ids exist in state
    for (const childId of newChildIds) {
      const child = state.nodes.find((n) => n.id === childId);
      expect(child).toBeDefined();
      // Each child's rootId points at the new root id
      expect(child?.metadata.batch?.rootId).toBe(newRoot?.id);
    }

    // Ensure old ids are gone (all ids are fresh)
    expect(state.nodes.map((n) => n.id)).not.toContain(root.id);
  });

  it("orphan child (root not in file) → batch field stripped", () => {
    // Manually craft an export file with a child whose root id is not in the file
    const file = {
      app: "nexu-canvas" as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      nodes: [
        {
          id: "child-node-1",
          type: "image" as const,
          title: "orphan child",
          position: { x: 200, y: 200 },
          size: { width: 340, height: 240 },
          // rootId points at a node NOT in this file
          metadata: {
            content: "http://srv/c.png",
            batch: { rootId: "ghost-root-id" },
          },
        },
      ],
      connections: [],
    };

    importCanvas(file);

    const state = getCanvasState();
    expect(state.nodes).toHaveLength(1);
    const imported = state.nodes[0];
    // batch field must be stripped (orphan)
    expect(imported?.metadata.batch).toBeUndefined();
    // content preserved
    expect(imported?.metadata.content).toBe("http://srv/c.png");
  });
});

// ── g. clipboard: copy strips batch field ─────────────────────

describe("g. clipboard: copying a root yields independent image (no batch field)", () => {
  it("copied-then-pasted root has no batch field", () => {
    const root = addNode({
      type: "image",
      title: "original",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 240 },
    });
    attachBatchChildren(root.id, [
      { url: "http://srv/a.png" },
      { url: "http://srv/b.png" },
    ]);

    // Select and copy the root
    selectNodes([root.id]);
    const copied = copySelection();
    expect(copied).toBe(1);

    // Paste
    const pasted = pasteClipboard();
    expect(pasted).toBe(1);

    const state = getCanvasState();
    // Find the pasted node (the one that isn't the root and isn't a child)
    const rootNode = state.nodes.find((n) => n.id === root.id);
    const children = rootNode?.metadata.batch?.childIds ?? [];
    const pastedNode = state.nodes.find(
      (n) => n.id !== root.id && !children.includes(n.id),
    );
    expect(pastedNode).toBeDefined();
    expect(pastedNode?.metadata.batch).toBeUndefined();
  });

  it("duplicating a root yields independent image (no batch field)", () => {
    const root = addNode({
      type: "image",
      title: "dup-test",
      position: { x: 0, y: 0 },
      size: { width: 340, height: 240 },
    });
    attachBatchChildren(root.id, [
      { url: "http://srv/a.png" },
      { url: "http://srv/b.png" },
    ]);

    const count = duplicateNodes([root.id]);
    expect(count).toBe(1);

    const state = getCanvasState();
    const rootNode = state.nodes.find((n) => n.id === root.id);
    const children = rootNode?.metadata.batch?.childIds ?? [];
    const dupe = state.nodes.find(
      (n) => n.id !== root.id && !children.includes(n.id),
    );
    expect(dupe?.metadata.batch).toBeUndefined();
  });
});

// ── h. markup: collapsed ghost, badge, hidden children ────────

describe("h. markup: collapsed batch rendering", () => {
  it("collapsed root has ghost element, badge ×3, children absent from markup", () => {
    const root = addNode({
      type: "image",
      title: "batch-root",
      position: { x: 10, y: 10 },
      size: { width: 340, height: 240 },
    });
    // 3 items → root + 2 children = ×3 badge
    attachBatchChildren(root.id, [
      { url: "http://srv/a.png" },
      { url: "http://srv/b.png" },
      { url: "http://srv/c.png" },
    ]);
    // Collapse
    toggleBatchExpanded(root.id);

    const state = getCanvasState();
    const markup = renderToStaticMarkup(React.createElement(CanvasSurface));

    // Children must be absent from the rendered markup
    const rootNode = state.nodes.find((n) => n.id === root.id);
    if (!rootNode) throw new Error("root node missing");
    const childIds = rootNode.metadata.batch?.childIds ?? [];
    expect(childIds).toHaveLength(2); // sanity
    for (const childId of childIds) {
      expect(markup).not.toContain(childId);
    }

    // Ghost element must be present
    expect(markup).toMatch(/data-canvas-batch-ghost/);

    // Badge must show ×3 (root + 2 children = 3 total)
    expect(markup).toMatch(/×3/);
  });

  it("expanded root shows children in markup, ghost absent", () => {
    const root = addNode({
      type: "image",
      title: "batch-root-expanded",
      position: { x: 10, y: 10 },
      size: { width: 340, height: 240 },
    });
    attachBatchChildren(root.id, [
      { url: "http://srv/a.png" },
      { url: "http://srv/b.png" },
    ]);
    // expanded by default

    const state = getCanvasState();
    const markup = renderToStaticMarkup(React.createElement(CanvasSurface));

    // Children visible
    const rootNode = state.nodes.find((n) => n.id === root.id);
    if (!rootNode) throw new Error("root node missing");
    const childIds = rootNode.metadata.batch?.childIds ?? [];
    for (const childId of childIds) {
      expect(markup).toContain(childId);
    }

    // Ghost absent when expanded
    expect(markup).not.toMatch(/data-canvas-batch-ghost/);
  });

  it("child nodes have a star button (data-canvas-batch-primary)", () => {
    const root = addNode({
      type: "image",
      title: "with-star",
      position: { x: 10, y: 10 },
      size: { width: 340, height: 240 },
    });
    attachBatchChildren(root.id, [
      { url: "http://srv/a.png" },
      { url: "http://srv/b.png" },
    ]);

    const state = getCanvasState();
    const rootNode = state.nodes.find((n) => n.id === root.id);
    if (!rootNode) throw new Error("root node missing");
    const childIds = rootNode.metadata.batch?.childIds ?? [];

    const markup = renderToStaticMarkup(React.createElement(CanvasSurface));

    for (const childId of childIds) {
      expect(markup).toContain(`data-canvas-batch-primary="${childId}"`);
    }
  });
});

// ── i. partial failure: the shortfall becomes retryable placeholders ──────

describe("i. partial failure placeholders", () => {
  it("fewer pictures than requested leaves failed children, not a short grid", () => {
    const root = addNode({ type: "image", title: "根" });
    attachBatchChildren(
      root.id,
      [{ url: "/img/1.png" }, { url: "/img/2.png" }],
      { requested: 4, retry: { kind: "image", prompt: "a cat" } },
    );

    const state = getCanvasState();
    const rootNode = state.nodes.find((n) => n.id === root.id);
    const childIds = rootNode?.metadata.batch?.childIds ?? [];
    // 1 real sibling + 2 placeholders = the 4 slots that were asked for.
    expect(childIds).toHaveLength(3);

    const children = childIds.map((id) => state.nodes.find((n) => n.id === id));
    expect(children[0]?.metadata.content).toBe("/img/2.png");
    for (const failed of children.slice(1)) {
      expect(failed?.metadata.content).toBeUndefined();
      expect(failed?.metadata.task?.status).toBe("error");
      // Retry regenerates exactly this one — no count, or it would fan out again.
      expect(failed?.metadata.task?.retry).toEqual({
        kind: "image",
        prompt: "a cat",
      });
    }
  });

  it("a complete result adds no placeholders", () => {
    const root = addNode({ type: "image", title: "根" });
    attachBatchChildren(
      root.id,
      [{ url: "/img/1.png" }, { url: "/img/2.png" }],
      {
        requested: 2,
      },
    );
    const rootNode = getCanvasState().nodes.find((n) => n.id === root.id);
    expect(rootNode?.metadata.batch?.childIds).toHaveLength(1);
  });

  it("a single requested image that failed entirely is not turned into a batch", () => {
    const root = addNode({ type: "image", title: "根" });
    attachBatchChildren(root.id, [{ url: "/img/1.png" }], { requested: 1 });
    const rootNode = getCanvasState().nodes.find((n) => n.id === root.id);
    expect(rootNode?.metadata.batch).toBeUndefined();
  });

  it("deleting the root still cascades the placeholders away", () => {
    const root = addNode({ type: "image", title: "根" });
    attachBatchChildren(root.id, [{ url: "/img/1.png" }], {
      requested: 3,
      retry: { kind: "image", prompt: "a cat" },
    });
    expect(getCanvasState().nodes).toHaveLength(3);
    removeNodes([root.id]);
    expect(getCanvasState().nodes).toHaveLength(0);
  });
});
