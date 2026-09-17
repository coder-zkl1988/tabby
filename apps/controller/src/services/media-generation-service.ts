import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../lib/logger.js";
import type { TabbyMediaRunner } from "./bundled-tabby-media-runner.js";

/**
 * Prompt-to-image generation for the canvas workbench (design doc
 * 2026-07-03-infinite-canvas-sidebar.md, S7).
 *
 * Tabby image/video models use trusted scripts bundled with the desktop app.
 * Other providers and image-editing flows keep the utility-subagent fallback,
 * which returns files through the existing /api/v1/media/state-file server.
 *
 * W2.5-2.6: extended with reference images, multi-count, video and audio
 * channels (UNAVAILABLE-first — channels ship before backend skills land).
 */

export class ImageGenerationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenerationFailedError";
  }
}

export class InvalidMediaReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMediaReferenceError";
  }
}

export type MediaGenerationServiceDeps = {
  /** Bot that runs the utility lane (any active bot; the default agent). */
  pickUtilityBotId: () => Promise<string | null>;
  sendChat: (input: {
    botId: string;
    sessionKey: string;
    message: string;
  }) => Promise<unknown>;
  readSessionEntry: (
    botId: string,
    sessionKey: string,
  ) => Promise<{ status?: string; sessionFile?: string } | null>;
  readAssistantReply: (sessionFile: string) => Promise<string | null>;
  /** OpenClaw state dir — generated files must live under <stateDir>/media. */
  openclawStateDir: string;
  genId: () => string;
  /** Trusted bundled scripts used by canvas media generation without agent shell access. */
  tabbyMediaRunner?: TabbyMediaRunner;
};

export type MediaGenerationServiceOptions = {
  pollIntervalMs?: number;
  /** Skill-driven generation stacks agent overhead (read SKILL.md, spawn the
   * script, poll it) on top of model time — allow several minutes. */
  timeoutMs?: number;
  /** Per-kind timeout overrides. Takes precedence over timeoutMs for image. */
  timeoutMsByKind?: Partial<
    Record<"image" | "video" | "audio" | "enhance", number>
  >;
};

type MediaKind = "image" | "video" | "audio";

const IMAGE_PATH_SRC =
  "(\\/[^\\r\\n\"'`]+\\/media\\/[^\\r\\n\"'`]+\\.(?:png|jpe?g|webp|gif))";
const VIDEO_PATH_SRC =
  "(\\/[^\\r\\n\"'`]+\\/media\\/[^\\r\\n\"'`]+\\.(?:mp4|webm|mov|m4v))";
const AUDIO_PATH_SRC =
  "(\\/[^\\r\\n\"'`]+\\/media\\/[^\\r\\n\"'`]+\\.(?:mp3|wav|m4a|ogg|flac))";

function regexForKind(kind: MediaKind): RegExp {
  switch (kind) {
    case "image":
      return new RegExp(IMAGE_PATH_SRC, "gi");
    case "video":
      return new RegExp(VIDEO_PATH_SRC, "gi");
    case "audio":
      return new RegExp(AUDIO_PATH_SRC, "gi");
  }
}

/** Extract all plausible media-file paths from the agent's reply for a given kind. */
export function extractMediaPaths(reply: string, kind: MediaKind): string[] {
  const re = regexForKind(kind);
  const results: string[] = [];
  for (const match of reply.matchAll(re)) {
    if (match[1] !== undefined) {
      results.push(match[1]);
    }
  }
  return results;
}

/** Extract the first plausible image media-file path from the agent's reply. */
export function extractMediaPath(reply: string): string | null {
  return extractMediaPaths(reply, "image")[0] ?? null;
}

export type GeneratedMediaItem = { url: string; path: string };
export type GenerateMediaResult = {
  url: string;
  path: string;
  items: GeneratedMediaItem[];
};

export type EnhanceMediaResult = {
  url: string;
  path: string;
  items: GeneratedMediaItem[];
};

export type DescribeMediaResult = { prompt: string };

export type GenerateTextResult = { text: string };

export class MediaGenerationService {
  private readonly pollIntervalMs: number;
  private readonly timeoutMsByKind: Record<MediaKind | "enhance", number>;

  constructor(
    private readonly deps: MediaGenerationServiceDeps,
    options: MediaGenerationServiceOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const base = options.timeoutMs ?? 240_000;
    this.timeoutMsByKind = {
      image: options.timeoutMsByKind?.image ?? base,
      video: options.timeoutMsByKind?.video ?? 480_000,
      audio: options.timeoutMsByKind?.audio ?? 240_000,
      enhance: options.timeoutMsByKind?.enhance ?? 480_000,
    };
    // Back-compat: if timeoutMs was set, let it override image unless kind-specific set.
    if (
      options.timeoutMs !== undefined &&
      options.timeoutMsByKind?.image === undefined
    ) {
      this.timeoutMsByKind.image = options.timeoutMs;
    }
  }

  async generateImage(input: {
    prompt: string;
    referenceImages?: string[];
    count?: number;
    sourceImage?: string;
    maskDataUrl?: string;
    model?: string;
    quality?: "auto" | "high" | "medium" | "low";
    aspectRatio?: string;
    size?: string;
    transparentBackground?: boolean;
  }): Promise<GenerateMediaResult> {
    const mediaRoot = path.resolve(this.deps.openclawStateDir, "media");

    // Validate reference images BEFORE sending anything.
    if (input.referenceImages && input.referenceImages.length > 0) {
      for (const ref of input.referenceImages) {
        await this.validateMediaReference(ref, mediaRoot);
      }
    }

    // Validate sourceImage (inpaint/img2img source).
    if (input.sourceImage !== undefined) {
      await this.validateMediaReference(input.sourceImage, mediaRoot);
    }

    // Decode and write mask file BEFORE sendChat.
    let maskPath: string | undefined;
    if (input.maskDataUrl !== undefined && input.sourceImage !== undefined) {
      maskPath = await this.writeMaskFile(input.maskDataUrl);
    }

    const botId = await this.deps.pickUtilityBotId();
    if (!botId) {
      throw new ImageGenerationFailedError(
        "no active bot available to run image generation",
      );
    }

    const count = input.count ?? 1;
    const tabbyMediaRunner = this.deps.tabbyMediaRunner;
    const tabbyImageModel =
      input.model === "tabby-image"
        ? "tabby-image-pro"
        : input.model === "tabby-image-free"
          ? "tabby-image-flash"
          : input.model;
    const canUseBundledTabbyImage =
      tabbyMediaRunner !== undefined &&
      (tabbyImageModel === undefined ||
        tabbyImageModel === "tabby-image-pro" ||
        tabbyImageModel === "tabby-image-flash") &&
      (!input.referenceImages || input.referenceImages.length === 0) &&
      input.sourceImage === undefined &&
      input.maskDataUrl === undefined;
    if (canUseBundledTabbyImage) {
      try {
        const paths = await tabbyMediaRunner.generateImage({
          botId,
          prompt: input.prompt,
          count,
          ...(tabbyImageModel !== undefined ? { model: tabbyImageModel } : {}),
          ...(input.quality !== undefined ? { quality: input.quality } : {}),
          ...(input.aspectRatio !== undefined
            ? { aspectRatio: input.aspectRatio }
            : {}),
          ...(input.size !== undefined ? { size: input.size } : {}),
          ...(input.transparentBackground !== undefined
            ? { transparentBackground: input.transparentBackground }
            : {}),
          timeoutMs: this.timeoutMsByKind.image,
        });
        return this.validateAndBuildPaths(paths, mediaRoot, count, "image");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ImageGenerationFailedError(message);
      }
    }

    const sessionKey = `agent:${botId}:subagent:imagegen-${this.deps.genId()}`;

    const lines: string[] = [
      count === 1
        ? "[TASK] Generate one image."
        : `[TASK] Generate ${count} images.`,
      `Prompt: ${input.prompt}`,
    ];

    if (input.referenceImages && input.referenceImages.length > 0) {
      lines.push(
        "",
        "Reference images (guide the generation with them if your tool or skill supports image references; if not, ignore this block):",
        ...input.referenceImages,
      );
    }

    // Source image block (inpaint / img2img).
    if (input.sourceImage !== undefined) {
      if (maskPath !== undefined) {
        lines.push(
          "",
          `Edit the source image ${input.sourceImage} ONLY inside the masked region (mask file ${maskPath}, white = editable, black = keep). Requested change: ${input.prompt}.`,
        );
      } else {
        lines.push(
          "",
          `Source image (edit/transform it rather than generating from scratch): ${input.sourceImage}`,
        );
      }
    }

    const imageHints: string[] = [];
    if (input.model !== undefined) {
      imageHints.push(`Preferred model: ${input.model}`);
    }
    if (input.quality !== undefined) {
      imageHints.push(`Quality: ${input.quality}`);
    }
    if (input.aspectRatio !== undefined) {
      imageHints.push(`Aspect ratio: ${input.aspectRatio}`);
    }
    if (input.size !== undefined) {
      imageHints.push(`Size: ${input.size}`);
    }
    if (input.transparentBackground === true) {
      imageHints.push(
        "Transparent background: output PNG with a transparent (alpha) background, no backdrop.",
      );
    }
    if (imageHints.length > 0) {
      lines.push(
        "",
        "Generation hints (honor if your tool/skill supports them; else ignore):",
        ...imageHints,
      );
    }

    lines.push(
      "",
      "Rules (in order):",
      count === 1
        ? "1. If the image_generate tool is in your toolset, call it exactly"
        : `1. If the image_generate tool is in your toolset, call it exactly ${count} times (or once with count ${count} if the tool supports it)`,
    );
    if (count === 1) {
      lines.push("   once with this prompt.");
    }
    lines.push(
      "2. Otherwise use the official tabby-image skill (its script prints a",
      "   MEDIA: <absolute-path> line; the file lands under the media dir).",
      maskPath !== undefined
        ? "3. If no available tool or skill can edit images (with masks when given), reply ONLY UNAVAILABLE."
        : '3. If neither works, reply with ONLY the word "UNAVAILABLE" — no',
    );
    if (maskPath === undefined) {
      lines.push("   other workarounds.");
    }

    if (count === 1) {
      lines.push(
        "- Reply with ONLY the generated file's absolute path — one line, no",
        "  other words, no markdown, and do NOT render UI (no render_a2ui).",
      );
    } else {
      lines.push(
        `- Reply with ALL ${count} generated files' absolute paths, one per line,`,
        "  no other words, no markdown, and do NOT render UI (no render_a2ui).",
      );
    }

    const message = lines.join("\n");
    await this.deps.sendChat({ botId, sessionKey, message });

    const reply = await this.awaitLaneReply(botId, sessionKey, "image");

    if (/\bUNAVAILABLE\b/.test(reply)) {
      throw new ImageGenerationFailedError(
        "image generation backend is not configured (image_generate tool unavailable)",
      );
    }

    return this.validateAndBuildResult(
      reply,
      "image",
      mediaRoot,
      count,
      "image",
    );
  }

  async enhanceImage(input: {
    sourceImage: string;
    operation: "super-resolve" | "multi-angle";
    targetLongEdge?: 1024 | 2048 | 4096;
    horizontalDeg?: number;
    pitchDeg?: number;
    distance?: number;
    wideAngle?: boolean;
    prompt?: string;
  }): Promise<EnhanceMediaResult> {
    const mediaRoot = path.resolve(this.deps.openclawStateDir, "media");
    await this.validateMediaReference(input.sourceImage, mediaRoot);

    const botId = await this.deps.pickUtilityBotId();
    if (!botId) {
      throw new ImageGenerationFailedError(
        "no active bot available to run image enhancement",
      );
    }

    const sessionKey = `agent:${botId}:subagent:imgenhance-${this.deps.genId()}`;

    const lines: string[] = [];
    if (input.operation === "super-resolve") {
      const longEdge = input.targetLongEdge ?? 2048;
      lines.push(
        `Upscale/enhance the image at ${input.sourceImage} to a long edge of ${longEdge} px using a super-resolution tool or skill`,
      );
    } else {
      const h = input.horizontalDeg ?? 0;
      const p = input.pitchDeg ?? 0;
      const d = input.distance ?? 5;
      const wideStr = input.wideAngle ? ", wide-angle lens" : "";
      lines.push(
        `Re-render the image at ${input.sourceImage} from a different camera angle: horizontal ${h}°, pitch ${p}°, distance ${d}/10${wideStr}`,
      );
    }

    lines.push(
      "",
      "Reply with ONLY the output file's absolute path (under the media dir), one line, no markdown, and do NOT render UI.",
      'If no available tool or skill can perform this operation, reply ONLY the word "UNAVAILABLE".',
    );

    if (input.prompt) {
      lines.push("", `Extra guidance: ${input.prompt}`);
    }

    const message = lines.join("\n");
    await this.deps.sendChat({ botId, sessionKey, message });

    // Enhance can be slow; use the video timeout (480_000 default) as it is
    // sized for long-running generation-class tasks.
    const enhanceTimeoutMs = this.timeoutMsByKind.enhance;
    const reply = await this.awaitLaneReplyWithTimeout(
      botId,
      sessionKey,
      enhanceTimeoutMs,
    );

    if (/\bUNAVAILABLE\b/.test(reply)) {
      throw new ImageGenerationFailedError(
        "image enhancement backend is not configured",
      );
    }

    return this.validateAndBuildResult(
      reply,
      "image",
      mediaRoot,
      undefined,
      "imgenhance",
    );
  }

  async describeImage(input: {
    sourceImage: string;
  }): Promise<DescribeMediaResult> {
    const mediaRoot = path.resolve(this.deps.openclawStateDir, "media");
    await this.validateMediaReference(input.sourceImage, mediaRoot);

    const botId = await this.deps.pickUtilityBotId();
    if (!botId) {
      throw new ImageGenerationFailedError(
        "no active bot available to run image description",
      );
    }

    const sessionKey = `agent:${botId}:subagent:imgdescribe-${this.deps.genId()}`;

    const message = [
      `Look at the image file at ${input.sourceImage}. Reply with ONLY a text-to-image generation prompt (one paragraph) that would recreate this image — no preamble, no quotes. If you cannot view or analyze images, reply ONLY UNAVAILABLE.`,
    ].join("\n");

    await this.deps.sendChat({ botId, sessionKey, message });

    // Use min(configured image timeout, 120_000) for describe.
    const describeTimeoutMs = Math.min(this.timeoutMsByKind.image, 120_000);
    const reply = await this.awaitLaneReplyWithTimeout(
      botId,
      sessionKey,
      describeTimeoutMs,
      true,
    );

    if (/\bUNAVAILABLE\b/.test(reply)) {
      throw new ImageGenerationFailedError(
        "image description backend is not configured",
      );
    }

    const trimmed = reply.trim().slice(0, 2_000);
    if (!trimmed) {
      throw new ImageGenerationFailedError(
        "image description finished but returned an empty prompt",
      );
    }

    logger.info(
      { path: input.sourceImage },
      "media generation: describe ready",
    );
    return { prompt: trimmed };
  }

  async generateText(input: {
    prompt: string;
    sourceText?: string;
    model?: string;
  }): Promise<GenerateTextResult> {
    const botId = await this.deps.pickUtilityBotId();
    if (!botId) {
      throw new ImageGenerationFailedError(
        "no active bot available to run text generation",
      );
    }

    const sessionKey = `agent:${botId}:subagent:textgen-${this.deps.genId()}`;

    const lines: string[] =
      input.sourceText !== undefined
        ? [
            "[TASK] Rewrite/transform the text below per the instruction.",
            `Instruction: ${input.prompt}`,
            "",
            "Text:",
            input.sourceText,
          ]
        : [
            "[TASK] Write text per the instruction.",
            `Instruction: ${input.prompt}`,
          ];

    if (input.model !== undefined) {
      lines.push("", `Preferred model: ${input.model}`);
    }

    lines.push(
      "",
      "Reply with ONLY the resulting text — no preamble, no quotes, no markdown fences, and do NOT render UI (no render_a2ui). If you cannot, reply ONLY UNAVAILABLE.",
    );

    const message = lines.join("\n");
    await this.deps.sendChat({ botId, sessionKey, message });

    // Text is a fast turn; cap at min(configured image timeout, 120s) like describe.
    const timeoutMs = Math.min(this.timeoutMsByKind.image, 120_000);
    const reply = await this.awaitLaneReplyWithTimeout(
      botId,
      sessionKey,
      timeoutMs,
      true,
    );

    if (/\bUNAVAILABLE\b/.test(reply)) {
      throw new ImageGenerationFailedError(
        "text generation backend is not configured",
      );
    }

    const trimmed = reply.trim().slice(0, 8_000);
    if (!trimmed) {
      throw new ImageGenerationFailedError(
        "text generation finished but returned empty text",
      );
    }

    logger.info({ chars: trimmed.length }, "media generation: text ready");
    return { text: trimmed };
  }

  async generateVideo(input: {
    prompt: string;
    durationSeconds?: number;
    resolution?: "480p" | "720p" | "1080p";
    model?: string;
    aspectRatio?: string;
    numFrames?: number;
    frameRate?: number;
    numInferenceSteps?: number;
    negativePrompt?: string;
    seed?: number;
    generateAudio?: boolean;
    watermark?: boolean;
  }): Promise<GenerateMediaResult> {
    const botId = await this.deps.pickUtilityBotId();
    if (!botId) {
      throw new ImageGenerationFailedError(
        "no active bot available to run video generation",
      );
    }

    const tabbyMediaRunner = this.deps.tabbyMediaRunner;
    const canUseBundledTabbyVideo =
      tabbyMediaRunner !== undefined &&
      (input.model === undefined ||
        input.model === "tabby-video" ||
        input.model === "tabby-video-free") &&
      input.generateAudio !== true &&
      input.watermark !== true;
    if (canUseBundledTabbyVideo) {
      try {
        const videoPath = await tabbyMediaRunner.generateVideo({
          botId,
          prompt: input.prompt,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.numFrames === undefined &&
          input.durationSeconds !== undefined
            ? { durationSeconds: input.durationSeconds }
            : {}),
          ...(input.resolution !== undefined
            ? { resolution: input.resolution }
            : {}),
          ...(input.aspectRatio !== undefined
            ? { aspectRatio: input.aspectRatio }
            : {}),
          ...(input.numFrames !== undefined
            ? { numFrames: input.numFrames }
            : {}),
          ...(input.frameRate !== undefined
            ? { frameRate: input.frameRate }
            : {}),
          ...(input.numInferenceSteps !== undefined
            ? { numInferenceSteps: input.numInferenceSteps }
            : {}),
          ...(input.negativePrompt !== undefined
            ? { negativePrompt: input.negativePrompt }
            : {}),
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
          timeoutMs: this.timeoutMsByKind.video,
        });
        return this.validateAndBuildPaths(
          [videoPath],
          path.resolve(this.deps.openclawStateDir, "media"),
          undefined,
          "video",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ImageGenerationFailedError(message);
      }
    }

    const sessionKey = `agent:${botId}:subagent:videogen-${this.deps.genId()}`;
    const hints: string[] = [];
    if (input.durationSeconds !== undefined) {
      hints.push(`Duration: ${input.durationSeconds} seconds`);
    }
    if (input.resolution !== undefined) {
      hints.push(`Resolution: ${input.resolution}`);
    }
    if (input.aspectRatio !== undefined) {
      hints.push(`Aspect ratio: ${input.aspectRatio}`);
    }
    if (input.numFrames !== undefined) {
      hints.push(`Frames: ${input.numFrames}`);
    }
    if (input.frameRate !== undefined) {
      hints.push(`Frame rate: ${input.frameRate} fps`);
    }
    if (input.numInferenceSteps !== undefined) {
      hints.push(`Inference steps: ${input.numInferenceSteps}`);
    }
    if (input.negativePrompt !== undefined) {
      hints.push(`Negative prompt: ${input.negativePrompt}`);
    }
    if (input.seed !== undefined) {
      hints.push(`Seed: ${input.seed}`);
    }
    if (input.model !== undefined) {
      hints.push(`Preferred model: ${input.model}`);
    }
    if (input.generateAudio) {
      hints.push("Also generate an audio track");
    }
    if (input.watermark) {
      hints.push("Add a watermark");
    }

    const lines: string[] = [
      "[TASK] Generate a video clip.",
      `Prompt: ${input.prompt}`,
      ...(hints.length > 0 ? ["", ...hints] : []),
      "",
      "Rules (in order):",
      "1. If a video-generation tool (e.g. video_generate) is in your toolset,",
      "   call it once with this prompt (include duration/resolution hints when",
      "   provided).",
      "2. Otherwise if an official video-generation skill is installed (its",
      "   script writes files under the media dir and prints their paths) use it.",
      '3. Otherwise reply ONLY the word "UNAVAILABLE" — no other workarounds.',
      "- Reply with ONLY the generated file's absolute path (or paths, one per",
      "  line) — no other words, no markdown, and do NOT render UI.",
    ];

    const message = lines.join("\n");
    await this.deps.sendChat({ botId, sessionKey, message });

    const mediaRoot = path.resolve(this.deps.openclawStateDir, "media");
    const reply = await this.awaitLaneReply(botId, sessionKey, "video");

    if (/\bUNAVAILABLE\b/.test(reply)) {
      throw new ImageGenerationFailedError(
        "video generation backend is not configured",
      );
    }

    return this.validateAndBuildResult(
      reply,
      "video",
      mediaRoot,
      undefined,
      "video",
    );
  }

  async generateAudio(input: {
    prompt: string;
    voice?: string;
    speed?: number;
    model?: string;
    format?: "mp3" | "wav" | "m4a" | "ogg" | "flac";
    instructions?: string;
  }): Promise<GenerateMediaResult> {
    const botId = await this.deps.pickUtilityBotId();
    if (!botId) {
      throw new ImageGenerationFailedError(
        "no active bot available to run audio generation",
      );
    }

    const sessionKey = `agent:${botId}:subagent:audiogen-${this.deps.genId()}`;
    const hints: string[] = [];
    if (input.voice !== undefined) {
      hints.push(`Voice: ${input.voice}`);
    }
    if (input.speed !== undefined) {
      hints.push(`Speed: ${input.speed}`);
    }
    if (input.format !== undefined) {
      hints.push(`Format: ${input.format}`);
    }
    if (input.model !== undefined) {
      hints.push(`Preferred model: ${input.model}`);
    }
    if (input.instructions !== undefined) {
      hints.push(`Voice/style instructions: ${input.instructions}`);
    }

    const lines: string[] = [
      "[TASK] Generate an audio file.",
      `Prompt: ${input.prompt}`,
      ...(hints.length > 0 ? ["", ...hints] : []),
      "",
      "Rules (in order):",
      "1. If an audio-generation tool (e.g. audio_generate) is in your toolset,",
      "   call it once with this prompt (include voice/speed hints when provided).",
      "2. Otherwise if an official TTS or audio-generation skill is installed",
      "   (its script writes files under the media dir and prints their paths)",
      "   use it.",
      '3. Otherwise reply ONLY the word "UNAVAILABLE" — no other workarounds.',
      "- Reply with ONLY the generated file's absolute path (or paths, one per",
      "  line) — no other words, no markdown, and do NOT render UI.",
    ];

    const message = lines.join("\n");
    await this.deps.sendChat({ botId, sessionKey, message });

    const mediaRoot = path.resolve(this.deps.openclawStateDir, "media");
    const reply = await this.awaitLaneReply(botId, sessionKey, "audio");

    if (/\bUNAVAILABLE\b/.test(reply)) {
      throw new ImageGenerationFailedError(
        "audio generation backend is not configured",
      );
    }

    return this.validateAndBuildResult(
      reply,
      "audio",
      mediaRoot,
      undefined,
      "audio",
    );
  }

  /** Decode maskDataUrl, write to media/inbound/mask-<genId>.png, return path. */
  private async writeMaskFile(maskDataUrl: string): Promise<string> {
    return this.writeInboundImage(maskDataUrl, "mask", "invalid mask data");
  }

  /**
   * Decode a `data:image/...;base64,<payload>` URL and write it into the
   * inbound media dir, returning its absolute path.
   *
   * Shared by the mask parameter path and the public save-inbound-image route
   * (a canvas-composed image has to reach disk before it can be a reference —
   * `validateMediaReference` only accepts paths under the media dir).
   */
  private async writeInboundImage(
    dataUrl: string,
    prefix: string,
    invalidMessage: string,
  ): Promise<string> {
    // Strip the data URL prefix: data:image/png;base64,<payload>
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx === -1) {
      throw new InvalidMediaReferenceError(invalidMessage);
    }
    const b64 = dataUrl.slice(commaIdx + 1);
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
      // Validate: a valid base64 round-trip should not produce an empty buffer
      // and re-encoding should match the input (modulo padding).
      if (buf.length === 0) {
        throw new InvalidMediaReferenceError(invalidMessage);
      }
      // Strict check: base64 decode then re-encode must reproduce input (ignoring whitespace).
      const re = buf.toString("base64");
      const normalised = b64.replace(/\s/g, "");
      // Allow padding differences only
      if (re.replace(/=+$/, "") !== normalised.replace(/=+$/, "")) {
        throw new InvalidMediaReferenceError(invalidMessage);
      }
    } catch (err) {
      if (err instanceof InvalidMediaReferenceError) {
        throw err;
      }
      throw new InvalidMediaReferenceError(invalidMessage);
    }
    const inboundDir = path.resolve(
      this.deps.openclawStateDir,
      "media",
      "inbound",
    );
    await mkdir(inboundDir, { recursive: true });
    const filePath = path.join(
      inboundDir,
      `${prefix}-${this.deps.genId()}.png`,
    );
    await writeFile(filePath, buf);
    return filePath;
  }

  /**
   * Persist a canvas-composed PNG into the inbound media dir.
   *
   * `prefix` is already constrained to `[a-z0-9-]` by the request schema; it is
   * re-checked here so a non-route caller can't escape the directory.
   */
  async saveInboundImage(input: {
    dataUrl: string;
    prefix?: string;
  }): Promise<{ path: string; url: string }> {
    const prefix =
      input.prefix !== undefined && /^[a-z0-9-]+$/.test(input.prefix)
        ? input.prefix
        : "canvas";
    const filePath = await this.writeInboundImage(
      input.dataUrl,
      prefix,
      "invalid image data",
    );
    return {
      path: filePath,
      url: `/api/v1/media/state-file?path=${encodeURIComponent(filePath)}`,
    };
  }

  private async validateMediaReference(
    ref: string,
    mediaRoot: string,
  ): Promise<void> {
    const resolved = path.resolve(ref);
    const relative = path.relative(mediaRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new InvalidMediaReferenceError(
        `reference image is outside the media directory: ${ref}`,
      );
    }
    try {
      await access(resolved);
    } catch {
      throw new InvalidMediaReferenceError(
        `reference image does not exist: ${ref}`,
      );
    }
  }

  private async validateAndBuildResult(
    reply: string,
    kind: MediaKind,
    mediaRoot: string,
    count: number | undefined,
    logLabel: string,
  ): Promise<GenerateMediaResult> {
    const candidates = extractMediaPaths(reply, kind);
    return this.validateAndBuildPaths(candidates, mediaRoot, count, logLabel);
  }

  private async validateAndBuildPaths(
    candidates: readonly string[],
    mediaRoot: string,
    count: number | undefined,
    logLabel: string,
  ): Promise<GenerateMediaResult> {
    const capped =
      count !== undefined ? candidates.slice(0, count) : candidates;

    const validItems: GeneratedMediaItem[] = [];
    const seenPaths = new Set<string>();
    for (const candidate of capped) {
      const resolved = path.resolve(candidate);
      const relative = path.relative(mediaRoot, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        // Skip paths outside media dir (don't throw — ≥1 valid path rule).
        continue;
      }
      if (seenPaths.has(resolved)) {
        // Skip duplicate path.
        continue;
      }
      try {
        await access(resolved);
        seenPaths.add(resolved);
        validItems.push({
          path: resolved,
          url: `/api/v1/media/state-file?path=${encodeURIComponent(resolved)}`,
        });
      } catch {
        // File doesn't exist; skip.
      }
    }

    if (validItems.length === 0) {
      if (candidates.length === 0) {
        throw new ImageGenerationFailedError(
          "generation finished but no media path was found in the reply",
        );
      }
      throw new ImageGenerationFailedError(
        "generated path is outside the media directory",
      );
    }

    // validItems.length > 0 is guaranteed by the check above.
    const first = validItems[0] as GeneratedMediaItem;
    logger.info(
      { kind: logLabel, count: validItems.length, path: first.path },
      "media generation: ready",
    );

    return {
      path: first.path,
      url: first.url,
      items: validItems,
    };
  }

  private async awaitLaneReply(
    botId: string,
    sessionKey: string,
    kind: MediaKind,
  ): Promise<string> {
    return this.awaitLaneReplyWithTimeout(
      botId,
      sessionKey,
      this.timeoutMsByKind[kind],
    );
  }

  private async awaitLaneReplyWithTimeout(
    botId: string,
    sessionKey: string,
    timeoutMs: number,
    /** When true, return the reply even if empty (caller checks for empty). */
    allowEmptyReply = false,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entry = await this.deps.readSessionEntry(botId, sessionKey);
      if (entry?.status === "done") {
        const reply = entry.sessionFile
          ? await this.deps.readAssistantReply(entry.sessionFile)
          : null;
        if (allowEmptyReply) {
          // Return whatever the agent replied (including empty/whitespace).
          return reply ?? "";
        }
        if (reply?.trim()) {
          return reply.trim();
        }
        // A turn can end on a bare tool call; the lane may still run a
        // queued follow-up turn — keep polling until the deadline.
      }
      if (entry?.status === "failed") {
        throw new ImageGenerationFailedError("generation session failed");
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new ImageGenerationFailedError(
      `generation timed out after ${timeoutMs}ms`,
    );
  }
}
