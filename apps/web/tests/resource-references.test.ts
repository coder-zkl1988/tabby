/**
 * resource-references.test.ts
 *
 * W2.1 — Upstream resource collection for generation inputs.
 * Plain Node env — no jsdom, no DOM events.
 * All assertions work against canvas-store state directly.
 *
 * BFS semantics (exact per brief):
 *  - Incoming edges (connections whose toNodeId === starting node)
 *  - Level-by-level (direct parents first, then grandparents, etc.)
 *  - Within a level: order connections appear in state.connections
 *  - Dedupe visited node ids; cycle-safe (visited set)
 *  - Starting node itself is NOT included
 *
 * Type mapping:
 *  - text with non-empty trimmed content → prompts
 *  - image with non-empty content → images
 *  - video → videos
 *  - audio → audios
 *  - a2ui / team-step → nothing (but their ancestors still traversed)
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetCanvasForTests,
  addNode,
  connectNodes,
} from "../src/lib/canvas/canvas-store";
import {
  collectUpstream,
  collectUpstreamNodes,
  collectUpstreamRefs,
  hasUpstream,
} from "../src/lib/canvas/resource-references";

// Minimal localStorage polyfill (matches other canvas tests).
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

describe("collectUpstream", () => {
  it("a. chain: text A → image B → target C (transitive)", () => {
    const A = addNode({
      type: "text",
      title: "A",
      metadata: { content: "hello" },
    });
    const B = addNode({
      type: "image",
      title: "B",
      metadata: { content: "data:image/png;base64,abc" },
    });
    const C = addNode({ type: "text", title: "C" });
    connectNodes(A.id, B.id); // A → B
    connectNodes(B.id, C.id); // B → C

    const result = collectUpstream(C.id);

    // B is direct upstream, A is transitive
    expect(result.prompts).toEqual(["hello"]);
    expect(result.images).toEqual(["data:image/png;base64,abc"]);
    expect(result.videos).toEqual([]);
    expect(result.audios).toEqual([]);
  });

  it("b. fork: image X and image Y both → target (both images, connections-array order)", () => {
    const X = addNode({
      type: "image",
      title: "X",
      metadata: { content: "img-x" },
    });
    const Y = addNode({
      type: "image",
      title: "Y",
      metadata: { content: "img-y" },
    });
    const T = addNode({ type: "text", title: "T" });
    connectNodes(X.id, T.id); // X → T  (first in connections array)
    connectNodes(Y.id, T.id); // Y → T  (second in connections array)

    const result = collectUpstream(T.id);

    expect(result.images).toEqual(["img-x", "img-y"]);
  });

  it("c. level order: direct first — D direct, E transitive (E→D→target)", () => {
    const E = addNode({
      type: "image",
      title: "E",
      metadata: { content: "img-e" },
    });
    const D = addNode({
      type: "image",
      title: "D",
      metadata: { content: "img-d" },
    });
    const T = addNode({ type: "text", title: "T" });
    connectNodes(E.id, D.id); // E → D
    connectNodes(D.id, T.id); // D → T (direct)

    const result = collectUpstream(T.id);

    // Direct first: D (level 1), then E (level 2)
    expect(result.images).toEqual(["img-d", "img-e"]);
  });

  it("d. cycle: A→B, B→A, B→target — terminates; each counted once", () => {
    const A = addNode({
      type: "text",
      title: "A",
      metadata: { content: "text-a" },
    });
    const B = addNode({
      type: "text",
      title: "B",
      metadata: { content: "text-b" },
    });
    const T = addNode({ type: "text", title: "T" });
    connectNodes(A.id, B.id); // A → B
    connectNodes(B.id, A.id); // B → A  (creates a cycle)
    connectNodes(B.id, T.id); // B → T

    // Must not throw/hang, and both A and B counted exactly once
    const result = collectUpstream(T.id);

    expect(result.prompts).toContain("text-b"); // B is direct
    expect(result.prompts).toContain("text-a"); // A is transitive
    expect(result.prompts).toHaveLength(2); // dedupe: each once
  });

  it("e. empty/whitespace content is skipped; a2ui contributes nothing but its upstream is traversed", () => {
    const text = addNode({
      type: "text",
      title: "Prefix",
      metadata: { content: "  " }, // whitespace only → skipped
    });
    const realText = addNode({
      type: "text",
      title: "Real",
      metadata: { content: "  actual  " }, // non-empty after trim
    });
    const a2uiNode = addNode({
      type: "a2ui",
      title: "A2UI",
      metadata: { surfaceId: "s1" },
    });
    const T = addNode({ type: "text", title: "T" });
    connectNodes(text.id, a2uiNode.id); // text → a2ui (whitespace text, skipped)
    connectNodes(realText.id, a2uiNode.id); // realText → a2ui
    connectNodes(a2uiNode.id, T.id); // a2ui → T

    const result = collectUpstream(T.id);

    // a2ui itself contributes nothing
    // whitespace text is skipped
    // realText's trimmed content is included
    expect(result.prompts).toEqual(["  actual  "]); // content pushed as-is (not trimmed)
    expect(result.images).toEqual([]);
  });

  it("e. team-step node contributes nothing; its upstream is still traversed", () => {
    const img = addNode({
      type: "image",
      title: "Img",
      metadata: { content: "img-data" },
    });
    const step = addNode({ type: "team-step", title: "Step" });
    const T = addNode({ type: "text", title: "T" });
    connectNodes(img.id, step.id); // img → team-step
    connectNodes(step.id, T.id); // team-step → T

    const result = collectUpstream(T.id);

    // team-step contributes nothing, but img (its upstream) is included
    expect(result.images).toEqual(["img-data"]);
  });

  it("a. video and audio nodes populate their respective arrays", () => {
    const vid = addNode({
      type: "video",
      title: "V",
      metadata: { content: "video-url" },
    });
    const aud = addNode({
      type: "audio",
      title: "A",
      metadata: { content: "audio-url" },
    });
    const T = addNode({ type: "text", title: "T" });
    connectNodes(vid.id, T.id);
    connectNodes(aud.id, T.id);

    const result = collectUpstream(T.id);

    expect(result.videos).toEqual(["video-url"]);
    expect(result.audios).toEqual(["audio-url"]);
    expect(result.prompts).toEqual([]);
    expect(result.images).toEqual([]);
  });

  it("no upstream returns empty buckets", () => {
    const lone = addNode({ type: "text", title: "Lone" });

    const result = collectUpstream(lone.id);

    expect(result.prompts).toEqual([]);
    expect(result.images).toEqual([]);
    expect(result.videos).toEqual([]);
    expect(result.audios).toEqual([]);
  });
});

describe("collectUpstreamNodes", () => {
  it("returns nodes in BFS order (direct first, then transitive)", () => {
    const A = addNode({
      type: "text",
      title: "A",
      metadata: { content: "hello" },
    });
    const B = addNode({
      type: "image",
      title: "B",
      metadata: { content: "img-b" },
    });
    const T = addNode({ type: "image", title: "T" });
    connectNodes(A.id, B.id); // A → B
    connectNodes(B.id, T.id); // B → T (direct), A is transitive

    const result = collectUpstreamNodes(T.id);

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe(B.id); // direct first
    expect(result[1]?.id).toBe(A.id); // transitive second
  });

  it("returns empty array when there is no upstream", () => {
    const lone = addNode({ type: "text", title: "Lone" });
    expect(collectUpstreamNodes(lone.id)).toEqual([]);
  });

  it("does not include the starting node itself", () => {
    const A = addNode({ type: "text", title: "A" });
    const T = addNode({ type: "image", title: "T" });
    connectNodes(A.id, T.id);

    const result = collectUpstreamNodes(T.id);
    expect(result.map((n) => n.id)).not.toContain(T.id);
    expect(result.map((n) => n.id)).toContain(A.id);
  });

  it("is cycle-safe and deduplicates", () => {
    const A = addNode({ type: "text", title: "A", metadata: { content: "a" } });
    const B = addNode({ type: "text", title: "B", metadata: { content: "b" } });
    const T = addNode({ type: "image", title: "T" });
    connectNodes(A.id, B.id); // A → B
    connectNodes(B.id, A.id); // B → A (cycle)
    connectNodes(B.id, T.id); // B → T

    const result = collectUpstreamNodes(T.id);
    const ids = result.map((n) => n.id);
    // Both A and B are reachable, each exactly once
    expect(ids).toContain(A.id);
    expect(ids).toContain(B.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });
});

describe("hasUpstream", () => {
  it("returns false for a node with no incoming connections", () => {
    const lone = addNode({ type: "text", title: "Lone" });
    expect(hasUpstream(lone.id)).toBe(false);
  });

  it("returns true for a node with an incoming connection", () => {
    const src = addNode({ type: "image", title: "Src" });
    const dst = addNode({ type: "text", title: "Dst" });
    connectNodes(src.id, dst.id);

    expect(hasUpstream(dst.id)).toBe(true);
  });

  it("returns false for source node (only outgoing connection)", () => {
    const src = addNode({ type: "image", title: "Src" });
    const dst = addNode({ type: "text", title: "Dst" });
    connectNodes(src.id, dst.id);

    expect(hasUpstream(src.id)).toBe(false);
  });
});

describe("group nodes as generation inputs", () => {
  /** A group holding a text node and an image node, plus a target to feed. */
  function groupFixture() {
    const group = addNode({ type: "group", title: "素材组" });
    const text = addNode({
      type: "text",
      title: "文案",
      metadata: { content: "a cat", groupId: group.id },
    });
    const image = addNode({
      type: "image",
      title: "参考图",
      metadata: { content: "/img/ref.png", groupId: group.id },
    });
    const target = addNode({ type: "image", title: "生成目标" });
    const edge = connectNodes(group.id, target.id);
    return { group, text, image, target, edge };
  }

  it("one edge from a group feeds every resource inside it", () => {
    const { target } = groupFixture();
    const upstream = collectUpstream(target.id);
    expect(upstream.prompts).toEqual(["a cat"]);
    expect(upstream.images).toEqual(["/img/ref.png"]);
  });

  it("the group itself contributes nothing and is not a mention candidate", () => {
    const { group, text, image, target } = groupFixture();
    expect(collectUpstreamNodes(target.id).map((n) => n.id)).toEqual([
      text.id,
      image.id,
    ]);
    expect(collectUpstreamRefs(target.id).map((ref) => ref.node.id)).toContain(
      group.id,
    );
  });

  it("members inherit the group's edge id, so one cut drops the whole group", () => {
    const { group, text, image, target, edge } = groupFixture();
    const refs = collectUpstreamRefs(target.id);
    const byId = new Map(refs.map((ref) => [ref.node.id, ref]));
    expect(byId.get(group.id)?.edgeId).toBe(edge?.id);
    expect(byId.get(text.id)?.edgeId).toBe(edge?.id);
    expect(byId.get(image.id)?.edgeId).toBe(edge?.id);
    // Only the members are marked as arriving through the group.
    expect(byId.get(group.id)?.viaGroupId).toBeUndefined();
    expect(byId.get(text.id)?.viaGroupId).toBe(group.id);
    expect(byId.get(image.id)?.viaGroupId).toBe(group.id);
  });

  it("a member's own upstream is traversed, exactly as a direct edge would", () => {
    const { text, target } = groupFixture();
    const ancestor = addNode({
      type: "text",
      title: "上游",
      metadata: { content: "ancestor note" },
    });
    connectNodes(ancestor.id, text.id);
    expect(collectUpstream(target.id).prompts).toEqual([
      "a cat",
      "ancestor note",
    ]);
  });

  it("a node reached both directly and through a group is collected once", () => {
    const { image, target } = groupFixture();
    connectNodes(image.id, target.id);
    expect(collectUpstream(target.id).images).toEqual(["/img/ref.png"]);
  });

  it("an empty group feeds nothing", () => {
    const group = addNode({ type: "group", title: "空组" });
    const target = addNode({ type: "image", title: "生成目标" });
    connectNodes(group.id, target.id);
    const upstream = collectUpstream(target.id);
    expect(upstream.prompts).toEqual([]);
    expect(upstream.images).toEqual([]);
  });
});
