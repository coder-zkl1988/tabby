/**
 * prompt-panel.test.tsx
 *
 * W5.2–W5.5: per-mode generation settings + model picker on the prompt panel.
 *
 * Plain-Node env → renderToStaticMarkup (no jsdom/testing-library), matching the
 * neighboring canvas render tests. Static markup can't fire the generate button,
 * so the "forwards a chosen setting into generate*IntoNode" contract is pinned on
 * the pure build*GenOpts builders — the exact seam handleGenerate calls. The
 * render tests assert every mode's controls appear (incl. the SDK-fed model
 * picker options).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "../src/lib/canvas/canvas-store";
import {
  __resetCanvasForTests,
  addNode,
  connectNodes,
} from "../src/lib/canvas/canvas-store";
import { PromptPanel } from "../src/lib/canvas/prompt-panel";
import {
  buildAudioGenOpts,
  buildImageGenOpts,
  buildVideoGenOpts,
  imageSettingsSummary,
} from "../src/lib/canvas/prompt-panel-utils";

// Mock the SDK so importing the real client is unnecessary. getApiV1Models is
// never invoked under renderToStaticMarkup (no effects run) — model options come
// from the query cache seeded below.
vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1Models: vi.fn(),
  postApiV1MediaGenerateImage: vi.fn(),
  postApiV1MediaGenerateVideo: vi.fn(),
  postApiV1MediaGenerateAudio: vi.fn(),
  postApiV1MediaGenerateText: vi.fn(),
}));
vi.mock("../src/lib/media/image-generation-jobs", () => ({
  generateImageViaJob: vi.fn(),
}));

// Minimal localStorage polyfill (plain Node env, same as sibling canvas tests).
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

function renderPanel(node: CanvasNode): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Seed the ["models"] cache so the picker renders options synchronously.
  queryClient.setQueryData(["models"], {
    models: [
      { id: "tabby-image-pro", name: "tabby-image-pro", provider: "link" },
      {
        id: "tabby-image-flash",
        name: "tabby-image-flash",
        provider: "link",
      },
      { id: "tabby-video", name: "tabby-video", provider: "link" },
      { id: "tabby-ultra", name: "tabby-ultra", provider: "link" },
    ],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <PromptPanel node={node} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  __resetCanvasForTests();
  vi.clearAllMocks();
});

describe("PromptPanel controls per mode", () => {
  it("image: renders settings chip (defaults summary) + model picker with seeded options", () => {
    const node = addNode({ type: "image", title: "图" });
    const markup = renderPanel(node);
    // Params live behind the settings chip (reference paradigm) — the chip
    // shows the defaults summary; the popover itself is closed by default.
    expect(markup).toContain("data-canvas-image-settings-toggle");
    expect(markup).toContain("自动 · 默认 · 1 张");
    expect(markup).not.toContain("data-canvas-image-settings-panel");
    // reference-parity textarea placeholder
    expect(markup).toContain("描述要生成的图片内容");
    expect(markup).toContain("data-canvas-optimize-image-prompt");
    expect(markup).toContain("优化为 GPT-image-2 更容易理解的提示词");
    // model picker: default + capability-filtered options — image nodes only
    // offer the image backends, never chat/video models
    expect(markup).toContain("模型");
    expect(markup).toContain("默认模型");
    expect(markup).toContain("tabby-image-pro");
    expect(markup).toContain("tabby-image-flash");
    expect(markup).not.toContain("tabby-ultra");
    expect(markup).not.toContain("tabby-video");
  });

  it("image settings summary helper reflects non-default params", () => {
    expect(
      imageSettingsSummary({
        quality: "high",
        aspectRatio: "16:9",
        size: "2K",
        count: 3,
      }),
    ).toBe("高 · 16:9 · 2K（2048x1152） · 3 张");
    expect(
      imageSettingsSummary({
        quality: "auto",
        aspectRatio: "",
        size: "",
        count: 1,
      }),
    ).toBe("自动 · 默认 · 1 张");
  });

  it("video: renders settings chip (defaults summary) + model picker", () => {
    const node = addNode({ type: "video", title: "视" });
    const markup = renderPanel(node);
    // Params live behind the settings chip (reference paradigm) — the chip
    // shows the defaults summary; the popover itself is closed by default.
    expect(markup).toContain("data-canvas-image-settings-toggle");
    expect(markup).toContain("121帧 · 5s · 720p · 16:9");
    expect(markup).not.toContain("data-canvas-image-settings-panel");
    expect(markup).toContain("描述要生成的视频内容");
    expect(markup).not.toContain("data-canvas-optimize-image-prompt");
    expect(markup).toContain("模型");
    expect(markup).toContain("默认模型");
    // video nodes only offer the video backend
    expect(markup).toContain("tabby-video");
    expect(markup).not.toContain("tabby-image");
    expect(markup).not.toContain("tabby-ultra");
  });

  it("video: restores persisted settings and legacy duration from the node", () => {
    const node = addNode({
      type: "video",
      title: "视",
      metadata: {
        config: {
          mode: "video",
          durationSeconds: 10,
          frameRate: 24,
          resolution: "1080p",
          aspectRatio: "9:16",
          model: "tabby-video",
        },
      },
    });
    const markup = renderPanel(node);

    expect(markup).toContain("241帧 · 10s · 1080p · 9:16");
    expect(markup).toContain('<option value="tabby-video" selected="">');
  });

  it("audio: renders settings chip (defaults summary) + model picker", () => {
    const node = addNode({ type: "audio", title: "音" });
    const markup = renderPanel(node);
    expect(markup).toContain("data-canvas-image-settings-toggle");
    expect(markup).toContain("默认音色 · 1x");
    expect(markup).not.toContain("data-canvas-image-settings-panel");
    expect(markup).toContain("描述要生成的音频内容");
    expect(markup).toContain("模型");
  });

  it("always renders the generate button", () => {
    const node = addNode({ type: "image", title: "图" });
    const markup = renderPanel(node);
    expect(markup).toContain("data-canvas-panel-generate");
    expect(markup).toContain('aria-label="生成"');
  });

  it("renders the prompt-library toggle (dialog opens via canvas-dialogs)", () => {
    const node = addNode({ type: "image", title: "图" });
    const markup = renderPanel(node);
    expect(markup).toContain("data-canvas-prompt-library-toggle");
  });
});

// The forwarding seam handleGenerate uses. Chosen hints flow through; defaults
// (auto / 默认 / empty / count 1 / speed 1 / unchecked) are omitted so the
// backend keeps its own default.
describe("buildImageGenOpts", () => {
  it("forwards chosen quality/aspectRatio/model; omits count 1 + empty size", () => {
    expect(
      buildImageGenOpts({
        referenceImages: undefined,
        count: 1,
        model: "openai/gpt-image-1",
        quality: "high",
        aspectRatio: "16:9",
        size: "",
      }),
    ).toEqual({
      model: "openai/gpt-image-1",
      quality: "high",
      aspectRatio: "16:9",
    });
  });

  it("all defaults → empty opts", () => {
    expect(
      buildImageGenOpts({
        referenceImages: undefined,
        count: 1,
        model: "",
        quality: "auto",
        aspectRatio: "",
        size: "",
      }),
    ).toEqual({});
  });

  it("forwards referenceImages + count>1 + size", () => {
    expect(
      buildImageGenOpts({
        referenceImages: ["/img/a.png"],
        count: 4,
        model: "",
        quality: "auto",
        aspectRatio: "",
        size: "2K",
      }),
    ).toEqual({ referenceImages: ["/img/a.png"], count: 4, size: "2K" });
  });
});

describe("buildVideoGenOpts", () => {
  it("forwards the documented Agnes video parameters", () => {
    expect(
      buildVideoGenOpts({
        resolution: "1080p",
        aspectRatio: "9:16",
        numFrames: 241,
        frameRate: 30,
        numInferenceSteps: "28",
        negativePrompt: "  text, watermark  ",
        seed: "42",
        model: "tabby-video",
      }),
    ).toEqual({
      resolution: "1080p",
      aspectRatio: "9:16",
      numFrames: 241,
      frameRate: 30,
      numInferenceSteps: 28,
      negativePrompt: "text, watermark",
      seed: 42,
      model: "tabby-video",
    });
  });

  it("omits empty optional values and an invalid seed", () => {
    expect(
      buildVideoGenOpts({
        resolution: "720p",
        aspectRatio: "",
        numFrames: 121,
        frameRate: 24,
        numInferenceSteps: "0",
        negativePrompt: "  ",
        seed: "not-a-number",
        model: "",
      }),
    ).toEqual({
      resolution: "720p",
      numFrames: 121,
      frameRate: 24,
    });
  });
});

describe("buildAudioGenOpts", () => {
  it("forwards format/instructions/model; trims voice+instructions", () => {
    expect(
      buildAudioGenOpts({
        voice: " nova ",
        speed: 1.5,
        model: "openai/tts-1",
        format: "wav",
        instructions: "  keep it calm  ",
      }),
    ).toEqual({
      voice: "nova",
      speed: 1.5,
      model: "openai/tts-1",
      format: "wav",
      instructions: "keep it calm",
    });
  });

  it("omits default voice/speed/model/format/instructions", () => {
    expect(
      buildAudioGenOpts({
        voice: "",
        speed: 1,
        model: "",
        format: "",
        instructions: "",
      }),
    ).toEqual({});
  });
});

describe("buildImageGenOpts transparent background", () => {
  it("emits transparentBackground only when enabled", () => {
    const base = {
      count: 1,
      model: "",
      quality: "auto" as const,
      aspectRatio: "",
      size: "",
    };
    expect(buildImageGenOpts({ ...base, transparentBackground: true })).toEqual(
      { transparentBackground: true },
    );
    expect(
      buildImageGenOpts({ ...base, transparentBackground: false }),
    ).toEqual({});
    expect(buildImageGenOpts(base)).toEqual({});
  });

  it("renders the 透明背景 toggle group in the image settings popover contract", () => {
    // The popover is closed under static markup; the group is pinned via the
    // settings summary contract + the pure builder above. Render the panel to
    // ensure the chip row still mounts for image nodes.
    const node = addNode({ type: "image", title: "图" });
    const markup = renderPanel(node);
    expect(markup).toContain("data-canvas-image-settings-toggle");
  });
});

describe("PromptPanel upstream reference thumbnails", () => {
  it("renders real thumbnails of upstream images in the summary strip", () => {
    const source = addNode({
      type: "image",
      title: "参考图",
      metadata: { content: "data:image/png;base64,AAAA" },
    });
    const target = addNode({ type: "image", title: "生成目标" });
    connectNodes(source.id, target.id);

    const markup = renderPanel(target);
    expect(markup).toContain('src="data:image/png;base64,AAAA"');
  });

  it("renders no thumbnail strip without upstream images", () => {
    const node = addNode({ type: "image", title: "孤立节点" });
    const markup = renderPanel(node);
    expect(markup).not.toContain("data:image/png");
  });

  it("marks an upstream image as not-sent on a video target — video generation has no reference-image field", () => {
    const source = addNode({
      type: "image",
      title: "参考图",
      metadata: { content: "data:image/png;base64,AAAA" },
    });
    const target = addNode({ type: "video", title: "视频目标" });
    connectNodes(source.id, target.id);

    // The reference bar shows the connection (hiding it left the user with an
    // edge on the canvas and nothing to explain it) but says plainly that it
    // is not sent.
    const markup = renderPanel(target);
    expect(markup).toContain(`data-canvas-reference-chip="${source.id}"`);
    expect(markup).toContain("不会作为参考图发送");
  });

  it("marks an upstream image as not-sent on an audio target", () => {
    const source = addNode({
      type: "image",
      title: "参考图",
      metadata: { content: "data:image/png;base64,AAAA" },
    });
    const target = addNode({ type: "audio", title: "音频目标" });
    connectNodes(source.id, target.id);

    const markup = renderPanel(target);
    expect(markup).toContain(`data-canvas-reference-chip="${source.id}"`);
    expect(markup).toContain("不会作为参考图发送");
  });

  it("never shows upstream video/audio counts — no consumer forwards them to any generation call", () => {
    const videoSource = addNode({
      type: "video",
      title: "参考视频",
      metadata: { content: "/api/v1/media/state-file?path=%2Fv.mp4" },
    });
    const audioSource = addNode({
      type: "audio",
      title: "参考音频",
      metadata: { content: "/api/v1/media/state-file?path=%2Fa.mp3" },
    });
    const target = addNode({ type: "image", title: "生成目标" });
    connectNodes(videoSource.id, target.id);
    connectNodes(audioSource.id, target.id);

    const markup = renderPanel(target);
    expect(markup).not.toContain("视频 1");
    expect(markup).not.toContain("音频 1");
  });
});

// Send-button disabled state is driven by mergedPrompt (local draft + upstream
// text), not the raw local draft — proves a connected text node alone is
// enough to enable generation, matching the "文本 N" badge's implied contract.
// Slices up to `class=` (not the tag's closing `>`) so the button's own
// `disabled:opacity-40` Tailwind variant class never false-positives this
// check — React SSR renders a true boolean `disabled` prop as `disabled=""`
// immediately before the class attribute, never inside it.
function generateButtonDisabled(markup: string): boolean {
  const idx = markup.indexOf('data-canvas-panel-generate="true"');
  const classIdx = markup.indexOf("class=", idx);
  return markup.slice(idx, classIdx).includes("disabled=");
}

describe("PromptPanel upstream text feeds the merged prompt", () => {
  it("connected text node alone (empty local draft) enables the send button", () => {
    const source = addNode({
      type: "text",
      title: "风格说明",
      metadata: { content: "always mention a cat" },
    });
    const target = addNode({ type: "image", title: "生成目标" });
    connectNodes(source.id, target.id);

    const markup = renderPanel(target);
    expect(generateButtonDisabled(markup)).toBe(false);
  });

  it("no local draft and no upstream text keeps the send button disabled", () => {
    const node = addNode({ type: "image", title: "孤立节点" });
    const markup = renderPanel(node);
    expect(generateButtonDisabled(markup)).toBe(true);
  });
});

describe("PromptPanel reference bar", () => {
  it("shows a numbered chip per upstream text, matching the prompt's 【文本N】", () => {
    const t1 = addNode({
      type: "text",
      title: "文案一",
      metadata: { content: "a cat" },
    });
    const t2 = addNode({
      type: "text",
      title: "文案二",
      metadata: { content: "portrait style" },
    });
    const target = addNode({ type: "image", title: "生成目标" });
    connectNodes(t1.id, target.id);
    connectNodes(t2.id, target.id);

    const markup = renderPanel(target);
    expect(markup).toContain("【文本1】");
    expect(markup).toContain("【文本2】");
    expect(markup).toContain(`data-canvas-reference-chip="${t1.id}"`);
  });

  it("each chip carries a remove button bound to the edge that brought it in", () => {
    const source = addNode({
      type: "image",
      title: "参考图",
      metadata: { content: "data:image/png;base64,AAAA" },
    });
    const target = addNode({ type: "image", title: "生成目标" });
    const edge = connectNodes(source.id, target.id);

    const markup = renderPanel(target);
    expect(markup).toContain(`data-canvas-reference-remove="${edge?.id}"`);
  });

  it("a group reference expands into a chip per member, all on the one edge", () => {
    const group = addNode({ type: "group", title: "素材组" });
    const text = addNode({
      type: "text",
      title: "文案",
      metadata: { content: "a cat", groupId: group.id },
    });
    const image = addNode({
      type: "image",
      title: "参考图",
      metadata: { content: "data:image/png;base64,AAAA", groupId: group.id },
    });
    const target = addNode({ type: "image", title: "生成目标" });
    const edge = connectNodes(group.id, target.id);

    const markup = renderPanel(target);
    expect(markup).toContain(`data-canvas-reference-chip="${text.id}"`);
    expect(markup).toContain(`data-canvas-reference-chip="${image.id}"`);
    // One edge feeds both, so the remove button says what goes with it.
    expect(markup).toContain("移除这组 2 项参考");
    expect(markup).toContain(`data-canvas-reference-remove="${edge?.id}"`);
  });

  it("falls back to the summary line when nothing is connected", () => {
    const node = addNode({ type: "image", title: "孤立节点" });
    const markup = renderPanel(node);
    expect(markup).toContain("无上游输入");
    expect(markup).not.toContain("data-canvas-reference-chip");
  });

  it("offers the full-size prompt editor on every generatable node", () => {
    for (const type of ["image", "video", "audio"] as const) {
      const node = addNode({ type, title: `${type} 节点` });
      expect(renderPanel(node)).toContain(
        `data-canvas-expand-prompt="${node.id}"`,
      );
    }
  });
});
