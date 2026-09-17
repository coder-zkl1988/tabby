/**
 * config-node-logic.test.ts
 *
 * TDD: tests first (RED), then config-node-logic.ts implementation.
 * Plain Node env — no jsdom. vi.mock for canvas-generation seam.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock canvas-generation so we can assert calls without hitting the API.
vi.mock("../src/lib/canvas/canvas-generation", () => ({
  generateImageIntoNode: vi.fn().mockResolvedValue(true),
  generateVideoIntoNode: vi.fn().mockResolvedValue(true),
  generateAudioIntoNode: vi.fn().mockResolvedValue(true),
  retryNodeTask: vi.fn(),
}));

import {
  generateAudioIntoNode,
  generateImageIntoNode,
  generateVideoIntoNode,
} from "../src/lib/canvas/canvas-generation";
import {
  __resetCanvasForTests,
  addNode,
  connectNodes,
  getCanvasState,
} from "../src/lib/canvas/canvas-store";
import {
  buildConfigGenerationPlan,
  runConfigGeneration,
} from "../src/lib/canvas/config-node-logic";

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
  vi.clearAllMocks();
});

describe("buildConfigGenerationPlan", () => {
  it("returns {error: 'no-config'} when config node has no metadata.config", () => {
    const node = addNode({
      type: "config",
      title: "生成配置",
      // no metadata.config
    });
    const result = buildConfigGenerationPlan(node.id);
    expect(result).toEqual({ error: "no-config" });
  });

  it("returns {error: 'no-prompt'} when no upstream text nodes with content", () => {
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "image" } },
    });
    // No upstream connections at all
    const result = buildConfigGenerationPlan(config.id);
    expect(result).toEqual({ error: "no-prompt" });
  });

  it("returns {error: 'no-prompt'} when upstream text node has only whitespace", () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "   " },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "image" } },
    });
    connectNodes(text.id, config.id);

    const result = buildConfigGenerationPlan(config.id);
    expect(result).toEqual({ error: "no-prompt" });
  });

  it("image mode: joins multiple upstream prompts with double newline, includes usable reference paths and count", () => {
    const text1 = addNode({
      type: "text",
      title: "文本1",
      metadata: { content: "a cat" },
    });
    const text2 = addNode({
      type: "text",
      title: "文本2",
      metadata: { content: "  portrait style  " },
    });
    const img = addNode({
      type: "image",
      title: "参考图",
      // state-file URL — servablePathFromUrl extracts /abs/path
      metadata: {
        content: "/api/v1/media/state-file?path=%2Fabs%2Fpath%2Fref.png",
      },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "image", count: 2 } },
      position: { x: 100, y: 100 },
      size: { width: 320, height: 240 },
    });
    connectNodes(text1.id, config.id);
    connectNodes(text2.id, config.id);
    connectNodes(img.id, config.id);

    const result = buildConfigGenerationPlan(config.id);
    expect(result).not.toHaveProperty("error");
    if ("error" in result) throw new Error("expected plan");

    expect(result.kind).toBe("image");
    expect(result.prompt).toBe("【文本1】\na cat\n\n【文本2】\nportrait style");
    expect(result.referenceImages).toEqual(["/abs/path/ref.png"]);
    expect(result.count).toBe(2);
  });

  it("image mode: carries model/quality/aspectRatio/size hints from config", () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "a cat" },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: {
        config: {
          mode: "image",
          model: "seedream-4",
          quality: "high",
          aspectRatio: "16:9",
          size: "2K",
        },
      },
    });
    connectNodes(text.id, config.id);

    const result = buildConfigGenerationPlan(config.id);
    if ("error" in result) throw new Error("expected plan");
    if (result.kind !== "image") throw new Error("expected image plan");
    expect(result.model).toBe("seedream-4");
    expect(result.quality).toBe("high");
    expect(result.aspectRatio).toBe("16:9");
    // Tier + aspect resolve to fixed pixels through IMAGE_SIZE_TABLE.
    expect(result.size).toBe("2048x1152");
  });

  it("prepends the composer's composedPrompt before upstream prompts", () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "a cat" },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: {
        config: { mode: "image", composedPrompt: "  cinematic base  " },
      },
    });
    connectNodes(text.id, config.id);

    const result = buildConfigGenerationPlan(config.id);
    if ("error" in result) throw new Error("expected plan");
    expect(result.prompt).toBe("cinematic base\n\n【文本1】\na cat");
  });

  it("composedPrompt alone (no upstream text) satisfies the no-prompt guard", () => {
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "image", composedPrompt: "solo prompt" } },
    });

    const result = buildConfigGenerationPlan(config.id);
    if ("error" in result) throw new Error("expected plan");
    expect(result.prompt).toBe("solo prompt");
  });

  it("text mode: plan carries the assembled prompt + model", () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "write a poem" },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "text", model: "gpt-x" } },
    });
    connectNodes(text.id, config.id);

    const result = buildConfigGenerationPlan(config.id);
    if ("error" in result) throw new Error("expected plan");
    if (result.kind !== "text") throw new Error("expected text plan");
    expect(result.prompt).toBe("【文本1】\nwrite a poem");
    expect(result.model).toBe("gpt-x");
  });

  it("image mode: dataURL upstream images are excluded from referenceImages (not usable)", () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "sky" },
    });
    const img = addNode({
      type: "image",
      title: "data img",
      metadata: { content: "data:image/png;base64,abc123" },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "image" } },
    });
    connectNodes(text.id, config.id);
    connectNodes(img.id, config.id);

    const result = buildConfigGenerationPlan(config.id);
    if ("error" in result) throw new Error("expected plan");
    expect(result.kind).toBe("image");
    expect(result.referenceImages).toEqual([]);
  });

  it("video mode: passes the documented Agnes parameters from metadata.config", () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "ocean waves" },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: {
        config: {
          mode: "video",
          durationSeconds: 10,
          resolution: "1080p",
          aspectRatio: "9:16",
          numFrames: 241,
          frameRate: 30,
          numInferenceSteps: 28,
          negativePrompt: "text",
          seed: 42,
        },
      },
    });
    connectNodes(text.id, config.id);

    const result = buildConfigGenerationPlan(config.id);
    if ("error" in result) throw new Error("expected plan");
    expect(result.kind).toBe("video");
    expect(result.prompt).toBe("【文本1】\nocean waves");
    if (result.kind === "video") {
      expect(result.resolution).toBe("1080p");
      expect(result.durationSeconds).toBeUndefined();
      expect(result.aspectRatio).toBe("9:16");
      expect(result.numFrames).toBe(241);
      expect(result.frameRate).toBe(30);
      expect(result.numInferenceSteps).toBe(28);
      expect(result.negativePrompt).toBe("text");
      expect(result.seed).toBe(42);
    }
  });

  it("video mode: ignores legacy unsupported flags for Tabby models", () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "ocean waves" },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: {
        config: {
          mode: "video",
          model: "tabby-video",
          generateAudio: true,
          watermark: true,
        },
      },
    });
    connectNodes(text.id, config.id);

    const result = buildConfigGenerationPlan(config.id);
    if ("error" in result || result.kind !== "video") {
      throw new Error("expected video plan");
    }
    expect(result.generateAudio).toBeUndefined();
    expect(result.watermark).toBeUndefined();
  });

  it("video mode: drops an invalid persisted aspect ratio", () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "ocean waves" },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: {
        config: { mode: "video", aspectRatio: "2:1", numFrames: 121 },
      },
    });
    connectNodes(text.id, config.id);

    const result = buildConfigGenerationPlan(config.id);
    if ("error" in result || result.kind !== "video") {
      throw new Error("expected video plan");
    }
    expect(result.aspectRatio).toBeUndefined();
    expect(result.numFrames).toBe(121);
  });

  it("video mode: migrates legacy seconds to a legal frame count", () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "ocean waves" },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: {
        config: {
          mode: "video",
          durationSeconds: 10,
          frameRate: 24,
        },
      },
    });
    connectNodes(text.id, config.id);

    const result = buildConfigGenerationPlan(config.id);
    if ("error" in result || result.kind !== "video") {
      throw new Error("expected video plan");
    }
    expect(result.durationSeconds).toBeUndefined();
    expect(result.numFrames).toBe(241);
    expect(result.frameRate).toBe(24);
  });

  it("video mode: normalizes invalid persisted frame settings before submit", () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "ocean waves" },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: {
        config: {
          mode: "video",
          numFrames: 100,
          frameRate: 99,
          negativePrompt: `  ${"x".repeat(2_100)}  `,
          seed: 1.5,
        },
      },
    });
    connectNodes(text.id, config.id);

    const result = buildConfigGenerationPlan(config.id);
    if ("error" in result || result.kind !== "video") {
      throw new Error("expected video plan");
    }
    expect(result.numFrames).toBe(121);
    expect(result.frameRate).toBe(24);
    expect(result.negativePrompt).toHaveLength(2_000);
    expect(result.seed).toBeUndefined();
  });

  it("audio mode: passes voice and speed from metadata.config", () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "hello world" },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "audio", voice: "en-US", speed: 1.5 } },
    });
    connectNodes(text.id, config.id);

    const result = buildConfigGenerationPlan(config.id);
    if ("error" in result) throw new Error("expected plan");
    expect(result.kind).toBe("audio");
    expect(result.prompt).toBe("【文本1】\nhello world");
    if (result.kind === "audio") {
      expect(result.voice).toBe("en-US");
      expect(result.speed).toBe(1.5);
    }
  });
});

describe("runConfigGeneration", () => {
  it("returns null and creates no node when no-prompt error", async () => {
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "image" } },
    });

    const result = await runConfigGeneration(config.id);
    expect(result).toBeNull();

    const { nodes } = getCanvasState();
    // Only the config node — no result node created
    expect(nodes).toHaveLength(1);
    expect(generateImageIntoNode).not.toHaveBeenCalled();
  });

  it("image plan: creates a result image node, connects config→result, calls generateImageIntoNode with plan args", async () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "a sunny day" },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "image", count: 3 } },
      position: { x: 200, y: 100 },
      size: { width: 320, height: 240 },
    });
    connectNodes(text.id, config.id);

    const result = await runConfigGeneration(config.id);
    expect(result).not.toBeNull();

    const { nodes, connections } = getCanvasState();

    // A new result node should exist (type=image, title=生成结果)
    const resultNode = nodes.find(
      (n) => n.type === "image" && n.title === "生成结果",
    );
    expect(resultNode).toBeDefined();
    if (!resultNode) throw new Error("result node missing");

    // Result node positioned at config.x + config.width + 60
    expect(resultNode.position.x).toBe(200 + 320 + 60);
    expect(resultNode.position.y).toBe(100);

    // Connection: config → resultNode
    const conn = connections.find(
      (c) => c.fromNodeId === config.id && c.toNodeId === resultNode.id,
    );
    expect(conn).toBeDefined();

    // generateImageIntoNode called with result node id, prompt, {count}
    expect(generateImageIntoNode).toHaveBeenCalledWith(
      resultNode.id,
      "【文本1】\na sunny day",
      { referenceImages: [], count: 3 },
    );
  });

  it("video plan: creates result video node and calls generateVideoIntoNode", async () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "rain forest" },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: {
        config: {
          mode: "video",
          resolution: "720p",
          aspectRatio: "16:9",
          numFrames: 121,
          frameRate: 24,
          negativePrompt: "watermark",
          seed: 7,
        },
      },
      position: { x: 0, y: 0 },
      size: { width: 320, height: 240 },
    });
    connectNodes(text.id, config.id);

    await runConfigGeneration(config.id);

    const { nodes } = getCanvasState();
    const resultNode = nodes.find(
      (n) => n.type === "video" && n.title === "生成结果",
    );
    expect(resultNode).toBeDefined();

    expect(generateVideoIntoNode).toHaveBeenCalledWith(
      resultNode?.id,
      "【文本1】\nrain forest",
      {
        resolution: "720p",
        aspectRatio: "16:9",
        numFrames: 121,
        frameRate: 24,
        negativePrompt: "watermark",
        seed: 7,
      },
    );
  });

  it("audio plan: creates result audio node and calls generateAudioIntoNode", async () => {
    const text = addNode({
      type: "text",
      title: "文本",
      metadata: { content: "good morning" },
    });
    const config = addNode({
      type: "config",
      title: "生成配置",
      metadata: { config: { mode: "audio", voice: "zh-CN", speed: 1.0 } },
      position: { x: 0, y: 0 },
      size: { width: 320, height: 240 },
    });
    connectNodes(text.id, config.id);

    await runConfigGeneration(config.id);

    const { nodes } = getCanvasState();
    const resultNode = nodes.find(
      (n) => n.type === "audio" && n.title === "生成结果",
    );
    expect(resultNode).toBeDefined();

    expect(generateAudioIntoNode).toHaveBeenCalledWith(
      resultNode?.id,
      "【文本1】\ngood morning",
      { voice: "zh-CN", speed: 1.0 },
    );
  });

  it("no-config error: returns null, no node created, no seam called", async () => {
    // Config node with no metadata.config
    const config = addNode({
      type: "config",
      title: "生成配置",
    });

    const result = await runConfigGeneration(config.id);
    expect(result).toBeNull();
    expect(getCanvasState().nodes).toHaveLength(1);
    expect(generateImageIntoNode).not.toHaveBeenCalled();
    expect(generateVideoIntoNode).not.toHaveBeenCalled();
    expect(generateAudioIntoNode).not.toHaveBeenCalled();
  });
});
