import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabbyMediaRunner } from "../src/services/bundled-tabby-media-runner.js";
import {
  ImageGenerationFailedError,
  InvalidMediaReferenceError,
  MediaGenerationService,
  extractLatestGatewayAssistantReply,
  extractMediaPath,
  extractMediaPaths,
} from "../src/services/media-generation-service.js";

describe("extractLatestGatewayAssistantReply", () => {
  it("reads plain assistant text and ignores user or tool-result messages", () => {
    expect(
      extractLatestGatewayAssistantReply({
        messages: [
          { role: "assistant", content: " earlier response " },
          { role: "user", content: "please generate" },
          { role: "toolResult", content: "tool output" },
          { role: "assistant", content: '  {"profile":"ready"}  ' },
        ],
      }),
    ).toEqual({ status: "done", text: '{"profile":"ready"}' });
  });

  it("returns the latest assistant text and ignores non-text blocks", () => {
    expect(
      extractLatestGatewayAssistantReply({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", text: "internal reasoning" },
              { type: "text", text: " /tmp/media/out.png " },
            ],
          },
        ],
      }),
    ).toEqual({ status: "done", text: "/tmp/media/out.png" });
  });

  it("does not treat assistant preamble before a tool call as the final result", () => {
    expect(
      extractLatestGatewayAssistantReply({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "I will generate it now." },
              { type: "toolCall", name: "image_generate", arguments: {} },
            ],
          },
        ],
      }),
    ).toEqual({ status: "running", text: null });
  });

  it("keeps polling after a tool-only assistant message", () => {
    expect(
      extractLatestGatewayAssistantReply({
        messages: [
          { role: "assistant", content: [{ type: "text", text: "old" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", name: "image_generate" }],
          },
        ],
      }),
    ).toEqual({ status: "running", text: null });
  });

  it("surfaces an assistant error as failed", () => {
    expect(
      extractLatestGatewayAssistantReply({
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            content: [{ type: "text", text: "provider failed" }],
          },
        ],
      }),
    ).toEqual({ status: "failed", text: null });
  });

  it("fails on error even when the provider returned no text", () => {
    expect(
      extractLatestGatewayAssistantReply({
        messages: [{ role: "assistant", stopReason: "error", content: [] }],
      }),
    ).toEqual({ status: "failed", text: null });
  });
});

describe("extractMediaPath", () => {
  it("pulls the first media file path out of a noisy reply", () => {
    expect(
      extractMediaPath(
        "Done! Saved to /state/media/tool-image-generation/cat.png — enjoy.",
      ),
    ).toBe("/state/media/tool-image-generation/cat.png");
    expect(extractMediaPath("no path here")).toBeNull();
  });
});

describe("extractMediaPaths", () => {
  it("extracts all image paths from a multi-line reply", () => {
    const reply = [
      "/state/media/tool-image-generation/a.png",
      "/state/media/tool-image-generation/b.jpg",
      "some other text",
      "/state/media/tool-image-generation/c.webp",
    ].join("\n");
    expect(extractMediaPaths(reply, "image")).toEqual([
      "/state/media/tool-image-generation/a.png",
      "/state/media/tool-image-generation/b.jpg",
      "/state/media/tool-image-generation/c.webp",
    ]);
  });

  it("does not match video extension when kind is image", () => {
    const reply = "/state/media/videogen/clip.mp4\n/state/media/gen/img.png";
    const paths = extractMediaPaths(reply, "image");
    expect(paths).toEqual(["/state/media/gen/img.png"]);
  });

  it("extracts video paths", () => {
    const reply = "/state/media/videogen/clip.mp4\n/state/media/gen/movie.webm";
    expect(extractMediaPaths(reply, "video")).toEqual([
      "/state/media/videogen/clip.mp4",
      "/state/media/gen/movie.webm",
    ]);
  });

  it("extracts audio paths", () => {
    const reply =
      "/state/media/audiogen/track.mp3\n/state/media/audiogen/bg.wav";
    expect(extractMediaPaths(reply, "audio")).toEqual([
      "/state/media/audiogen/track.mp3",
      "/state/media/audiogen/bg.wav",
    ]);
  });

  it("preserves spaces in packaged macOS media paths", () => {
    const reply =
      "/Users/test/Library/Application Support/@nexu/desktop/runtime/openclaw/state/media/outbound/cat.png";
    expect(extractMediaPaths(reply, "image")).toEqual([reply]);
  });

  it("extractMediaPath is an alias for first image path", () => {
    const reply = "/state/media/gen/first.png\n/state/media/gen/second.png";
    expect(extractMediaPath(reply)).toBe("/state/media/gen/first.png");
  });
});

describe("MediaGenerationService", () => {
  let tmpDir: string;
  let sendChat: ReturnType<typeof vi.fn>;
  let readGatewayHistory: ReturnType<typeof vi.fn>;
  let readSessionEntry: ReturnType<typeof vi.fn>;
  let readAssistantReply: ReturnType<typeof vi.fn>;

  function buildService(tabbyMediaRunner?: TabbyMediaRunner) {
    return new MediaGenerationService(
      {
        pickUtilityBotId: async () => "bot-1",
        sendChat,
        readGatewayHistory,
        readSessionEntry,
        readAssistantReply,
        openclawStateDir: tmpDir,
        genId: () => "gen-1",
        ...(tabbyMediaRunner ? { tabbyMediaRunner } : {}),
      },
      { pollIntervalMs: 1, timeoutMs: 300 },
    );
  }

  function makeMediaFile(subpath: string): string {
    const full = join(tmpDir, "media", subpath);
    mkdirSync(
      join(tmpDir, "media", subpath.split("/").slice(0, -1).join("/")),
      {
        recursive: true,
      },
    );
    writeFileSync(full, "data");
    return full;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "media generation-"));
    sendChat = vi.fn(async () => ({ status: "started" }));
    readGatewayHistory = vi.fn(async () => null);
    readSessionEntry = vi.fn(async () => ({
      status: "done",
      sessionFile: "/fake/session.jsonl",
    }));
    readAssistantReply = vi.fn(async () => "");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Existing generateImage tests (must keep passing)
  // -----------------------------------------------------------------------
  it("uses the trusted Tabby runner for the default image model", async () => {
    const out = makeMediaFile("outbound/bot-1/tabby-image/out.png");
    const tabbyMediaRunner: TabbyMediaRunner = {
      generateImage: vi.fn(async () => [out]),
      generateVideo: vi.fn(async () => ""),
    };

    const result = await buildService(tabbyMediaRunner).generateImage({
      prompt: "a cat",
      model: "tabby-image-flash",
      aspectRatio: "9:16",
      size: "2K",
    });

    expect(result.path).toBe(out);
    expect(tabbyMediaRunner.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "bot-1",
        model: "tabby-image-flash",
        aspectRatio: "9:16",
        size: "2K",
      }),
    );
    expect(sendChat).not.toHaveBeenCalled();
  });

  it("maps legacy image model IDs to the renamed official models", async () => {
    const out = makeMediaFile("outbound/bot-1/tabby-image/out.png");
    const tabbyMediaRunner: TabbyMediaRunner = {
      generateImage: vi.fn(async () => [out]),
      generateVideo: vi.fn(async () => ""),
    };

    await buildService(tabbyMediaRunner).generateImage({
      prompt: "a cat",
      model: "tabby-image-free",
    });

    expect(tabbyMediaRunner.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ model: "tabby-image-flash" }),
    );
    expect(sendChat).not.toHaveBeenCalled();
  });

  it("keeps third-party image models on the utility-agent fallback", async () => {
    const out = makeMediaFile("tool-image-generation/out.png");
    readAssistantReply.mockResolvedValue(out);
    const tabbyMediaRunner: TabbyMediaRunner = {
      generateImage: vi.fn(async () => [out]),
      generateVideo: vi.fn(async () => ""),
    };

    await buildService(tabbyMediaRunner).generateImage({
      prompt: "a cat",
      model: "seedream-4",
    });

    expect(tabbyMediaRunner.generateImage).not.toHaveBeenCalled();
    expect(sendChat).toHaveBeenCalledOnce();
  });

  it("reads the completed utility lane from gateway history on OpenClaw 9.4", async () => {
    const out = makeMediaFile("tool-image-generation/gateway.png");
    readSessionEntry.mockResolvedValue(null);
    readGatewayHistory.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", name: "image_generate" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: ` ${out} ` }],
        },
      ],
    });

    const result = await buildService().generateImage({ prompt: "a cat" });

    expect(result.path).toBe(out);
    expect(readGatewayHistory).toHaveBeenCalledWith(
      expect.stringContaining("subagent:imagegen"),
      200,
    );
    expect(readAssistantReply).not.toHaveBeenCalled();
  });

  it("keeps polling gateway history after a tool-only turn", async () => {
    const out = makeMediaFile("tool-image-generation/polled.png");
    readSessionEntry.mockResolvedValue(null);
    readGatewayHistory
      .mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_call", name: "image_generate" }],
          },
        ],
      })
      .mockResolvedValue({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_call", name: "image_generate" }],
          },
          { role: "toolResult", content: "ok" },
          { role: "assistant", content: [{ type: "text", text: out }] },
        ],
      });

    const result = await buildService().generateImage({ prompt: "a cat" });

    expect(result.path).toBe(out);
    expect(readGatewayHistory.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("fails promptly when gateway history reports an assistant error", async () => {
    readSessionEntry.mockResolvedValue(null);
    readGatewayHistory.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          content: [{ type: "text", text: "provider failed" }],
        },
      ],
    });

    await expect(
      buildService().generateImage({ prompt: "a cat" }),
    ).rejects.toThrow("generation session failed");
  });

  it("falls back to the legacy transcript when gateway history is unavailable", async () => {
    readGatewayHistory.mockRejectedValue(new Error("method unavailable"));
    readAssistantReply.mockResolvedValue("legacy result");

    await expect(
      buildService().generateText({ prompt: "summarize" }),
    ).resolves.toEqual({ text: "legacy result" });
    expect(readAssistantReply).toHaveBeenCalledWith("/fake/session.jsonl");
  });

  it("returns the servable url for a file inside the media dir", async () => {
    const mediaFile = join(tmpDir, "media", "tool-image-generation", "a.png");
    rmSync(join(tmpDir, "media"), { recursive: true, force: true });
    mkdirSync(join(tmpDir, "media", "tool-image-generation"), {
      recursive: true,
    });
    writeFileSync(mediaFile, "png");
    readAssistantReply.mockResolvedValue(mediaFile);

    const result = await buildService().generateImage({ prompt: "a cat" });

    expect(result.path).toBe(mediaFile);
    expect(result.url).toBe(
      `/api/v1/media/state-file?path=${encodeURIComponent(mediaFile)}`,
    );
    // The utility lane got the prompt and the strict reply contract.
    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain("a cat");
    expect(message).toContain("image_generate");
    expect(message).toContain("tabby-image");
    expect(message).toContain("ONLY the generated file's absolute path");
  });

  it("fails fast when the agent reports UNAVAILABLE (no image backend)", async () => {
    readAssistantReply.mockResolvedValue("UNAVAILABLE");
    await expect(buildService().generateImage({ prompt: "x" })).rejects.toThrow(
      /backend is not configured/,
    );
  });

  it("rejects a path that escapes the media directory", async () => {
    readAssistantReply.mockResolvedValue(
      `${tmpDir}/media/../secrets/media/x.png`,
    );
    await expect(
      buildService().generateImage({ prompt: "x" }),
    ).rejects.toBeInstanceOf(ImageGenerationFailedError);
  });

  it("fails when the reply carries no media path before the deadline", async () => {
    readAssistantReply.mockResolvedValue("sorry, I cannot");
    await expect(
      buildService().generateImage({ prompt: "x" }),
    ).rejects.toBeInstanceOf(ImageGenerationFailedError);
  });

  // -----------------------------------------------------------------------
  // generateImage + referenceImages
  // -----------------------------------------------------------------------
  it("includes the reference block in the contract when referenceImages provided", async () => {
    const ref1 = makeMediaFile("inbound/ref1.png");
    const ref2 = makeMediaFile("inbound/ref2.jpg");
    const out = makeMediaFile("tool-image-generation/out.png");
    readAssistantReply.mockResolvedValue(out);

    await buildService().generateImage({
      prompt: "a cat",
      referenceImages: [ref1, ref2],
    });

    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain("Reference images");
    expect(message).toContain(ref1);
    expect(message).toContain(ref2);
  });

  it("throws InvalidMediaReferenceError and never calls sendChat for an invalid reference", async () => {
    await expect(
      buildService().generateImage({
        prompt: "a cat",
        referenceImages: ["/etc/passwd"],
      }),
    ).rejects.toBeInstanceOf(InvalidMediaReferenceError);

    expect(sendChat).not.toHaveBeenCalled();
  });

  it("throws InvalidMediaReferenceError for a non-existent reference file under media dir", async () => {
    const nonExistent = join(tmpDir, "media", "inbound", "missing.png");
    await expect(
      buildService().generateImage({
        prompt: "a cat",
        referenceImages: [nonExistent],
      }),
    ).rejects.toBeInstanceOf(InvalidMediaReferenceError);

    expect(sendChat).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // generateImage + count
  // -----------------------------------------------------------------------
  it("count=2: message mentions count and multi-path reply yields items.length 2", async () => {
    const out1 = makeMediaFile("tool-image-generation/a.png");
    const out2 = makeMediaFile("tool-image-generation/b.png");
    readAssistantReply.mockResolvedValue(`${out1}\n${out2}`);

    const result = await buildService().generateImage({
      prompt: "cats",
      count: 2,
    });

    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain("2");
    expect(message).toContain("2 times");
    expect(message).not.toContain("once with this prompt.");

    expect(result.items).toHaveLength(2);
    expect(result.url).toBe(result.items[0]?.url);
    expect(result.path).toBe(result.items[0]?.path);
  });

  it("count=2 but only 1 valid path in reply → succeeds with items.length 1", async () => {
    const out1 = makeMediaFile("tool-image-generation/a.png");
    // second path is not under media dir → gets dropped, but ≥1 remains
    readAssistantReply.mockResolvedValue(`${out1}\n/etc/not-media/b.png`);

    const result = await buildService().generateImage({
      prompt: "cats",
      count: 2,
    });

    expect(result.items).toHaveLength(1);
    expect(result.path).toBe(out1);
  });

  it("deduplicates repeated valid paths in reply", async () => {
    const out1 = makeMediaFile("tool-image-generation/a.png");
    // Same path repeated twice with count=2 → deduped to 1 item
    readAssistantReply.mockResolvedValue(`${out1}\n${out1}`);

    const result = await buildService().generateImage({
      prompt: "cats",
      count: 2,
    });

    expect(result.items).toHaveLength(1);
    expect(result.path).toBe(out1);
  });

  // -----------------------------------------------------------------------
  // generateImage + W5 generation hints (model/quality/aspectRatio/size)
  // -----------------------------------------------------------------------
  it("includes model/quality/aspectRatio/size hints in the image contract", async () => {
    const out = makeMediaFile("tool-image-generation/out.png");
    readAssistantReply.mockResolvedValue(out);

    await buildService().generateImage({
      prompt: "a cat",
      model: "seedream-4",
      quality: "high",
      aspectRatio: "16:9",
      size: "2K",
    });

    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain("Preferred model: seedream-4");
    expect(message).toContain("Quality: high");
    expect(message).toContain("Aspect ratio: 16:9");
    expect(message).toContain("Size: 2K");
  });

  it("omits the hints block entirely when no W5 params are given", async () => {
    const out = makeMediaFile("tool-image-generation/plain.png");
    readAssistantReply.mockResolvedValue(out);

    await buildService().generateImage({ prompt: "a dog" });

    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).not.toContain("Generation hints");
  });

  // -----------------------------------------------------------------------
  // generateVideo
  // -----------------------------------------------------------------------
  it("uses the trusted Tabby runner with documented video parameters", async () => {
    const out = makeMediaFile("outbound/bot-1/tabby-video/out.mp4");
    const tabbyMediaRunner: TabbyMediaRunner = {
      generateImage: vi.fn(async () => []),
      generateVideo: vi.fn(async () => out),
    };

    const result = await buildService(tabbyMediaRunner).generateVideo({
      prompt: "waves",
      model: "tabby-video",
      durationSeconds: 10,
      resolution: "1080p",
      aspectRatio: "16:9",
      numFrames: 241,
      frameRate: 30,
      numInferenceSteps: 28,
      negativePrompt: "text",
      seed: 42,
    });

    expect(result.path).toBe(out);
    expect(tabbyMediaRunner.generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "tabby-video",
        resolution: "1080p",
        aspectRatio: "16:9",
        numFrames: 241,
        frameRate: 30,
        numInferenceSteps: 28,
        negativePrompt: "text",
        seed: 42,
      }),
    );
    expect(
      vi.mocked(tabbyMediaRunner.generateVideo).mock.calls[0]?.[0],
    ).not.toHaveProperty("durationSeconds");
    expect(sendChat).not.toHaveBeenCalled();
  });

  it("does not silently drop unsupported audio or watermark requests", async () => {
    const out = makeMediaFile("tool-video-generation/with-audio.mp4");
    readAssistantReply.mockResolvedValue(out);
    const tabbyMediaRunner: TabbyMediaRunner = {
      generateImage: vi.fn(async () => []),
      generateVideo: vi.fn(async () => out),
    };

    await buildService(tabbyMediaRunner).generateVideo({
      prompt: "waves with sound",
      generateAudio: true,
      watermark: true,
    });

    expect(tabbyMediaRunner.generateVideo).not.toHaveBeenCalled();
    expect(sendChat).toHaveBeenCalledOnce();
    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain("Also generate an audio track");
    expect(message).toContain("Add a watermark");
  });

  it("generateVideo UNAVAILABLE reply → error /not configured/", async () => {
    readAssistantReply.mockResolvedValue("UNAVAILABLE");
    await expect(
      buildService().generateVideo({ prompt: "a sunset timelapse" }),
    ).rejects.toThrow(/not configured/);
  });

  it("generateVideo happy path with .mp4 → url/path returned", async () => {
    const out = makeMediaFile("tool-video-generation/clip.mp4");
    readAssistantReply.mockResolvedValue(out);

    const result = await buildService().generateVideo({
      prompt: "a sunset timelapse",
    });

    expect(result.path).toBe(out);
    expect(result.url).toContain("/api/v1/media/state-file");
    expect(result.items).toHaveLength(1);

    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain("video");
    expect(message).toContain("UNAVAILABLE");
    expect(message).toContain("video_generate");
  });

  it("generateVideo contract includes session key with videogen prefix", async () => {
    readAssistantReply.mockResolvedValue("UNAVAILABLE");
    await expect(
      buildService().generateVideo({ prompt: "x" }),
    ).rejects.toThrow();
    const call = sendChat.mock.calls[0]?.[0] as { sessionKey: string };
    expect(call.sessionKey).toContain("videogen");
  });

  it("includes model/aspectRatio/generateAudio/watermark hints in the video contract", async () => {
    const out = makeMediaFile("tool-video-generation/hint.mp4");
    readAssistantReply.mockResolvedValue(out);

    await buildService().generateVideo({
      prompt: "a sunset",
      model: "seedance-1",
      aspectRatio: "9:16",
      generateAudio: true,
      watermark: true,
    });

    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain("Preferred model: seedance-1");
    expect(message).toContain("Aspect ratio: 9:16");
    expect(message).toContain("Also generate an audio track");
    expect(message).toContain("Add a watermark");
  });

  // -----------------------------------------------------------------------
  // generateAudio
  // -----------------------------------------------------------------------
  it("generateAudio UNAVAILABLE reply → error /not configured/", async () => {
    readAssistantReply.mockResolvedValue("UNAVAILABLE");
    await expect(
      buildService().generateAudio({ prompt: "background music" }),
    ).rejects.toThrow(/not configured/);
  });

  it("generateAudio happy path with .mp3 → url/path returned", async () => {
    const out = makeMediaFile("tool-audio-generation/track.mp3");
    readAssistantReply.mockResolvedValue(out);

    const result = await buildService().generateAudio({
      prompt: "background music",
    });

    expect(result.path).toBe(out);
    expect(result.url).toContain("/api/v1/media/state-file");
    expect(result.items).toHaveLength(1);

    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain("audio");
    expect(message).toContain("UNAVAILABLE");
    expect(message).toContain("audio_generate");
  });

  it("generateAudio contract includes session key with audiogen prefix", async () => {
    readAssistantReply.mockResolvedValue("UNAVAILABLE");
    await expect(
      buildService().generateAudio({ prompt: "x" }),
    ).rejects.toThrow();
    const call = sendChat.mock.calls[0]?.[0] as { sessionKey: string };
    expect(call.sessionKey).toContain("audiogen");
  });

  it("includes model/format/instructions hints in the audio contract", async () => {
    const out = makeMediaFile("tool-audio-generation/hint.wav");
    readAssistantReply.mockResolvedValue(out);

    await buildService().generateAudio({
      prompt: "calm music",
      model: "tts-1",
      format: "wav",
      instructions: "warm female voice",
    });

    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain("Preferred model: tts-1");
    expect(message).toContain("Format: wav");
    expect(message).toContain("Voice/style instructions: warm female voice");
  });

  // -----------------------------------------------------------------------
  // generateText (W5.7)
  // -----------------------------------------------------------------------
  it("generateText returns the trimmed reply text", async () => {
    readAssistantReply.mockResolvedValue("  Hello world  ");
    const result = await buildService().generateText({ prompt: "greet" });
    expect(result.text).toBe("Hello world");
    const call = sendChat.mock.calls[0]?.[0] as { sessionKey: string };
    expect(call.sessionKey).toContain("textgen");
  });

  it("generateText UNAVAILABLE reply → error /not configured/", async () => {
    readAssistantReply.mockResolvedValue("UNAVAILABLE");
    await expect(buildService().generateText({ prompt: "x" })).rejects.toThrow(
      /not configured/,
    );
  });

  it("generateText empty reply → error /empty/", async () => {
    readAssistantReply.mockResolvedValue("   ");
    await expect(buildService().generateText({ prompt: "x" })).rejects.toThrow(
      /empty/,
    );
  });

  it("generateText includes source text (rewrite) + model hint in the contract", async () => {
    readAssistantReply.mockResolvedValue("rewritten");
    await buildService().generateText({
      prompt: "make it formal",
      sourceText: "hey there",
      model: "gpt-x",
    });
    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain("Rewrite/transform");
    expect(message).toContain("make it formal");
    expect(message).toContain("hey there");
    expect(message).toContain("Preferred model: gpt-x");
  });

  // -----------------------------------------------------------------------
  // generateImage + sourceImage (inpaint/img2img) — Test group (a) & (b)
  // -----------------------------------------------------------------------
  it("(a) sourceImage outside media root → InvalidMediaReferenceError before sendChat", async () => {
    await expect(
      buildService().generateImage({
        prompt: "make it blue",
        sourceImage: "/etc/passwd",
      }),
    ).rejects.toBeInstanceOf(InvalidMediaReferenceError);
    expect(sendChat).not.toHaveBeenCalled();
  });

  it("(a) valid sourceImage → contract contains the source block", async () => {
    const srcFile = makeMediaFile("inbound/source.png");
    const out = makeMediaFile("tool-image-generation/out.png");
    readAssistantReply.mockResolvedValue(out);

    await buildService().generateImage({
      prompt: "make it blue",
      sourceImage: srcFile,
    });

    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain("Source image");
    expect(message).toContain(srcFile);
    expect(message).toContain("edit/transform");
  });

  it("(b) maskDataUrl with valid sourceImage → mask file exists under media/inbound and contract contains its path", async () => {
    const srcFile = makeMediaFile("inbound/source.png");
    const out = makeMediaFile("tool-image-generation/out.png");
    readAssistantReply.mockResolvedValue(out);

    // A minimal 1x1 white PNG encoded as base64
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==";
    const maskDataUrl = `data:image/png;base64,${pngBase64}`;

    await buildService().generateImage({
      prompt: "remove the background",
      sourceImage: srcFile,
      maskDataUrl,
    });

    // Check the contract message
    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain("mask file");
    expect(message).toContain("white = editable");
    // Check that the mask file exists under media/inbound
    const { readdirSync } = await import("node:fs");
    const inboundDir = join(tmpDir, "media", "inbound");
    const maskFiles = readdirSync(inboundDir).filter(
      (f) => f.startsWith("mask-") && f.endsWith(".png"),
    );
    expect(maskFiles.length).toBeGreaterThan(0);
  });

  it("(b) invalid base64 in maskDataUrl → InvalidMediaReferenceError, no sendChat", async () => {
    const srcFile = makeMediaFile("inbound/source.png");

    await expect(
      buildService().generateImage({
        prompt: "remove bg",
        sourceImage: srcFile,
        maskDataUrl: "data:image/png;base64,!!!not-valid-base64!!!",
      }),
    ).rejects.toBeInstanceOf(InvalidMediaReferenceError);
    expect(sendChat).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // enhanceImage — Test group (c) & (d)
  // -----------------------------------------------------------------------
  it("(c) super-resolve: contract contains path + default 2048 target", async () => {
    const srcFile = makeMediaFile("inbound/source.png");
    const out = makeMediaFile("tool-image-generation/enhanced.png");
    readAssistantReply.mockResolvedValue(out);

    await buildService().enhanceImage({
      sourceImage: srcFile,
      operation: "super-resolve",
    });

    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain(srcFile);
    expect(message).toContain("2048");
    expect(message).toContain("super-resol");
  });

  it("(c) super-resolve UNAVAILABLE → error /not configured/", async () => {
    const srcFile = makeMediaFile("inbound/source.png");
    readAssistantReply.mockResolvedValue("UNAVAILABLE");

    await expect(
      buildService().enhanceImage({
        sourceImage: srcFile,
        operation: "super-resolve",
      }),
    ).rejects.toThrow(/not configured/);
  });

  it("(c) super-resolve happy path .png → url/path returned", async () => {
    const srcFile = makeMediaFile("inbound/source.png");
    const out = makeMediaFile("tool-image-generation/enhanced.png");
    readAssistantReply.mockResolvedValue(out);

    const result = await buildService().enhanceImage({
      sourceImage: srcFile,
      operation: "super-resolve",
    });

    expect(result.path).toBe(out);
    expect(result.url).toContain("/api/v1/media/state-file");
    expect(result.items).toHaveLength(1);
  });

  it("(d) multi-angle: contract contains all numeric params + wide-angle when set", async () => {
    const srcFile = makeMediaFile("inbound/source.png");
    const out = makeMediaFile("tool-image-generation/angle.png");
    readAssistantReply.mockResolvedValue(out);

    await buildService().enhanceImage({
      sourceImage: srcFile,
      operation: "multi-angle",
      horizontalDeg: 30,
      pitchDeg: -15,
      distance: 7,
      wideAngle: true,
    });

    const message = (sendChat.mock.calls[0]?.[0] as { message: string })
      .message;
    expect(message).toContain(srcFile);
    expect(message).toContain("30");
    expect(message).toContain("-15");
    expect(message).toContain("7");
    expect(message).toContain("wide-angle");
  });

  // -----------------------------------------------------------------------
  // describeImage — Test group (e)
  // -----------------------------------------------------------------------
  it("(e) describe happy reply → trimmed prompt returned", async () => {
    const srcFile = makeMediaFile("inbound/photo.png");
    readAssistantReply.mockResolvedValue(
      "  A cat sitting on a windowsill, warm afternoon light, bokeh background  ",
    );

    const result = await buildService().describeImage({ sourceImage: srcFile });

    expect(result.prompt).toBe(
      "A cat sitting on a windowsill, warm afternoon light, bokeh background",
    );
  });

  it("(e) describe UNAVAILABLE → ImageGenerationFailedError /not configured/", async () => {
    const srcFile = makeMediaFile("inbound/photo.png");
    readAssistantReply.mockResolvedValue("UNAVAILABLE");

    await expect(
      buildService().describeImage({ sourceImage: srcFile }),
    ).rejects.toThrow(/not configured/);
  });

  it("(e) describe whitespace-only reply → failure", async () => {
    const srcFile = makeMediaFile("inbound/photo.png");
    readAssistantReply.mockResolvedValue("   ");

    await expect(
      buildService().describeImage({ sourceImage: srcFile }),
    ).rejects.toBeInstanceOf(ImageGenerationFailedError);
  });
});
