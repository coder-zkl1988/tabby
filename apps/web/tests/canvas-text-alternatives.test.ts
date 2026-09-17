/**
 * canvas-text-alternatives.test.ts
 *
 * Several generated texts held in ONE node (reference v0.17), plus the
 * write-through that keeps an edit from being discarded on switch.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetCanvasForTests,
  addNode,
  getCanvasState,
} from "../src/lib/canvas/canvas-store";
import {
  attachTextAlternatives,
  setActiveTextAlternative,
  updateTextNodeContent,
} from "../src/lib/canvas/canvas-text-alternatives";

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

function textNode() {
  return addNode({ type: "text", title: "文案" });
}

function read(id: string) {
  return getCanvasState().nodes.find((n) => n.id === id)?.metadata;
}

describe("attachTextAlternatives", () => {
  it("a single result stays plain content — no alternatives block", () => {
    const node = textNode();
    attachTextAlternatives(node.id, ["only one"], 1);
    expect(read(node.id)?.content).toBe("only one");
    expect(read(node.id)?.textAlternatives).toBeUndefined();
  });

  it("several results land as alternatives showing the first", () => {
    const node = textNode();
    attachTextAlternatives(node.id, ["a", "b", "c"], 3);
    expect(read(node.id)?.content).toBe("a");
    expect(read(node.id)?.textAlternatives).toEqual({
      items: ["a", "b", "c"],
      activeIndex: 0,
    });
  });

  it("records the requested count only when some failed", () => {
    const node = textNode();
    attachTextAlternatives(node.id, ["a", "b"], 4);
    expect(read(node.id)?.textAlternatives?.requested).toBe(4);

    const complete = textNode();
    attachTextAlternatives(complete.id, ["a", "b"], 2);
    expect(read(complete.id)?.textAlternatives?.requested).toBeUndefined();
  });

  it("drops blank results before counting", () => {
    const node = textNode();
    attachTextAlternatives(node.id, ["a", "   ", "b"], 3);
    expect(read(node.id)?.textAlternatives?.items).toEqual(["a", "b"]);
    expect(read(node.id)?.textAlternatives?.requested).toBe(3);
  });

  it("all-blank is a no-op rather than an empty node", () => {
    const node = textNode();
    attachTextAlternatives(node.id, ["  ", ""], 2);
    expect(read(node.id)?.content).toBeUndefined();
  });
});

describe("setActiveTextAlternative", () => {
  it("switching mirrors the chosen item into content", () => {
    const node = textNode();
    attachTextAlternatives(node.id, ["a", "b", "c"], 3);
    setActiveTextAlternative(node.id, 2);
    expect(read(node.id)?.content).toBe("c");
    expect(read(node.id)?.textAlternatives?.activeIndex).toBe(2);
  });

  it("an out-of-range index changes nothing", () => {
    const node = textNode();
    attachTextAlternatives(node.id, ["a", "b"], 2);
    setActiveTextAlternative(node.id, 9);
    expect(read(node.id)?.content).toBe("a");
    expect(read(node.id)?.textAlternatives?.activeIndex).toBe(0);
  });
});

describe("updateTextNodeContent", () => {
  it("an edit survives switching away and back", () => {
    const node = textNode();
    attachTextAlternatives(node.id, ["a", "b"], 2);
    updateTextNodeContent(node.id, "a edited");
    setActiveTextAlternative(node.id, 1);
    expect(read(node.id)?.content).toBe("b");
    setActiveTextAlternative(node.id, 0);
    expect(read(node.id)?.content).toBe("a edited");
  });

  it("a node without alternatives just writes content", () => {
    const node = textNode();
    updateTextNodeContent(node.id, "plain");
    expect(read(node.id)?.content).toBe("plain");
    expect(read(node.id)?.textAlternatives).toBeUndefined();
  });
});
