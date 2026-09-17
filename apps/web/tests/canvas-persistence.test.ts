/**
 * canvas-persistence.test.ts
 *
 * Tests for IndexedDB canvas persistence (W1.1).
 * All tests run in the plain Node env — no jsdom, no IndexedDB global.
 * We inject a fake CanvasStorage via __setCanvasStorageForTests.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type {
  CanvasStorage,
  PersistedCanvas,
} from "../src/lib/canvas/canvas-persistence";
import { __setCanvasStorageForTests } from "../src/lib/canvas/canvas-persistence";
import {
  __flushCanvasPersistForTests,
  __resetCanvasForTests,
  addNode,
  getCanvasState,
  hydrateCanvasFromStorage,
  undo,
} from "../src/lib/canvas/canvas-store";

// Minimal localStorage polyfill (same as infinite-canvas.test.tsx)
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

/** Build an in-memory CanvasStorage fake */
function makeFakeStorage() {
  const db = new Map<string, PersistedCanvas>();
  let saveCallCount = 0;

  const storage: CanvasStorage = {
    load: async (boardId: string) => db.get(boardId) ?? null,
    save: async (boardId: string, snapshot: PersistedCanvas) => {
      saveCallCount++;
      db.set(boardId, snapshot);
    },
  };

  return {
    storage,
    getDb: () => db,
    getSaveCallCount: () => saveCallCount,
    resetSaveCallCount: () => {
      saveCallCount = 0;
    },
  };
}

beforeEach(() => {
  __resetCanvasForTests();
  __setCanvasStorageForTests(null); // restore default between tests
});

describe("canvas persistence", () => {
  it("a. addNode → flush → fake received snapshot containing the node with version 1", async () => {
    const fake = makeFakeStorage();
    __setCanvasStorageForTests(fake.storage);

    addNode({ type: "text", title: "hello" });
    await __flushCanvasPersistForTests();

    const saved = fake.getDb().get("sidebar");
    expect(saved).not.toBeNull();
    expect(saved?.version).toBe(1);
    expect(saved?.nodes).toHaveLength(1);
    expect(saved?.nodes[0]?.title).toBe("hello");
    expect(saved?.savedAt).toBeDefined();
  });

  it("b. hydrate into empty store → nodes+connections restored; undo immediately after is a no-op", async () => {
    const fake = makeFakeStorage();

    // Pre-seed the fake storage with a snapshot
    const snapshot: PersistedCanvas = {
      version: 1,
      savedAt: new Date().toISOString(),
      nodes: [
        {
          id: "node-1",
          type: "text",
          title: "note",
          position: { x: 10, y: 20 },
          size: { width: 300, height: 180 },
          metadata: { content: "hello" },
        },
      ],
      connections: [],
    };
    await fake.storage.save("sidebar", snapshot);

    __setCanvasStorageForTests(fake.storage);

    const applied = await hydrateCanvasFromStorage();
    expect(applied).toBe(true);

    const state = getCanvasState();
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0]?.id).toBe("node-1");
    expect(state.connections).toHaveLength(0);

    // undo immediately after hydration must be a no-op (no history recorded)
    undo();
    expect(getCanvasState().nodes).toHaveLength(1);
  });

  it("c. hydrate into store that already has a node with same id → no duplicate; other ids merge in", async () => {
    const fake = makeFakeStorage();

    // Add a node to the live store first
    addNode({
      type: "text",
      title: "existing",
      id: "node-existing",
    });

    // Snapshot with the same id plus a new one
    const snapshot: PersistedCanvas = {
      version: 1,
      savedAt: new Date().toISOString(),
      nodes: [
        {
          id: "node-existing", // duplicate — must not be added again
          type: "text",
          title: "existing-from-storage",
          position: { x: 0, y: 0 },
          size: { width: 300, height: 180 },
          metadata: {},
        },
        {
          id: "node-new",
          type: "image",
          title: "new",
          position: { x: 100, y: 100 },
          size: { width: 340, height: 240 },
          metadata: {},
        },
      ],
      connections: [],
    };
    await fake.storage.save("sidebar", snapshot);

    __setCanvasStorageForTests(fake.storage);
    await hydrateCanvasFromStorage();

    const state = getCanvasState();
    // existing kept, new node merged in, no duplicate
    expect(state.nodes).toHaveLength(2);
    const existingNode = state.nodes.find((n) => n.id === "node-existing");
    expect(existingNode?.title).toBe("existing"); // original title preserved
    expect(state.nodes.find((n) => n.id === "node-new")).toBeDefined();
  });

  it("d. persisted connection whose endpoint node is missing → dropped on hydrate", async () => {
    const fake = makeFakeStorage();

    const snapshot: PersistedCanvas = {
      version: 1,
      savedAt: new Date().toISOString(),
      nodes: [
        {
          id: "node-a",
          type: "text",
          title: "A",
          position: { x: 0, y: 0 },
          size: { width: 300, height: 180 },
          metadata: {},
        },
      ],
      connections: [
        {
          id: "conn-1",
          fromNodeId: "node-a",
          toNodeId: "node-missing", // this node doesn't exist
        },
      ],
    };
    await fake.storage.save("sidebar", snapshot);

    __setCanvasStorageForTests(fake.storage);
    await hydrateCanvasFromStorage();

    const state = getCanvasState();
    expect(state.nodes).toHaveLength(1);
    expect(state.connections).toHaveLength(0); // connection dropped
  });

  it("e. hydration itself does not schedule a save-back: after hydrate + flush, save call count is 0", async () => {
    const fake = makeFakeStorage();

    const snapshot: PersistedCanvas = {
      version: 1,
      savedAt: new Date().toISOString(),
      nodes: [
        {
          id: "node-e",
          type: "text",
          title: "E",
          position: { x: 0, y: 0 },
          size: { width: 300, height: 180 },
          metadata: {},
        },
      ],
      connections: [],
    };
    await fake.storage.save("sidebar", snapshot);

    // Reset save count after the seed
    fake.resetSaveCallCount();

    __setCanvasStorageForTests(fake.storage);
    await hydrateCanvasFromStorage();
    await __flushCanvasPersistForTests();

    expect(fake.getSaveCallCount()).toBe(0);
  });

  it("g. hydration normalizes a persisted `generating` task to error with interrupted message", async () => {
    const fake = makeFakeStorage();

    const snapshot: PersistedCanvas = {
      version: 1,
      savedAt: new Date().toISOString(),
      nodes: [
        {
          id: "node-gen",
          type: "image",
          title: "图片",
          position: { x: 0, y: 0 },
          size: { width: 340, height: 240 },
          metadata: {
            task: {
              status: "generating",
              retry: { kind: "image", prompt: "a cat" },
            },
          },
        },
        {
          id: "node-err",
          type: "image",
          title: "已错误",
          position: { x: 100, y: 0 },
          size: { width: 340, height: 240 },
          metadata: {
            task: {
              status: "error",
              error: "原错误",
              retry: { kind: "image", prompt: "a dog" },
            },
          },
        },
        {
          id: "node-ok",
          type: "image",
          title: "成功",
          position: { x: 200, y: 0 },
          size: { width: 340, height: 240 },
          metadata: {
            content: "http://localhost/img/x.png",
          },
        },
        {
          id: "node-job",
          type: "video",
          title: "有任务",
          position: { x: 300, y: 0 },
          size: { width: 420, height: 260 },
          metadata: {
            task: {
              status: "generating",
              retry: { kind: "video", prompt: "a river" },
              job: { kind: "video", jobId: "job-1" },
            },
          },
        },
      ],
      connections: [],
    };
    await fake.storage.save("sidebar", snapshot);
    __setCanvasStorageForTests(fake.storage);
    await hydrateCanvasFromStorage();

    const state = getCanvasState();

    // Node with generating task → normalized to error
    const genNode = state.nodes.find((n) => n.id === "node-gen");
    expect(genNode?.metadata.task?.status).toBe("error");
    expect(genNode?.metadata.task?.error).toBe("生成已中断（应用重启）");
    expect(genNode?.metadata.task?.retry).toEqual({
      kind: "image",
      prompt: "a cat",
    });

    // A job-backed task stays generating — the run is still alive on the
    // controller, and canvas-generation's resume re-attaches to the poll.
    const jobNode = state.nodes.find((n) => n.id === "node-job");
    expect(jobNode?.metadata.task?.status).toBe("generating");
    expect(jobNode?.metadata.task?.job).toEqual({
      kind: "video",
      jobId: "job-1",
    });

    // Node with error task → unchanged
    const errNode = state.nodes.find((n) => n.id === "node-err");
    expect(errNode?.metadata.task?.status).toBe("error");
    expect(errNode?.metadata.task?.error).toBe("原错误");

    // Node without task → unchanged, no task key
    const okNode = state.nodes.find((n) => n.id === "node-ok");
    expect(okNode?.metadata).not.toHaveProperty("task");
    expect(okNode?.metadata.content).toBe("http://localhost/img/x.png");
  });

  it("f. default storage in node env (no indexedDB global): load → null, save resolves, nothing throws", async () => {
    // __setCanvasStorageForTests(null) restores the default IDB storage
    // In Node env there's no indexedDB global → should degrade gracefully
    __setCanvasStorageForTests(null);

    // Import the default storage directly to test it in isolation
    const { createIndexedDBStorage } = await import(
      "../src/lib/canvas/canvas-persistence"
    );
    const defaultStorage = createIndexedDBStorage();

    // load should return null (no IDB global in Node)
    const result = await defaultStorage.load("sidebar");
    expect(result).toBeNull();

    // save should resolve without throwing
    const snapshot: PersistedCanvas = {
      version: 1,
      savedAt: new Date().toISOString(),
      nodes: [],
      connections: [],
    };
    await expect(
      defaultStorage.save("sidebar", snapshot),
    ).resolves.toBeUndefined();
  });
});
