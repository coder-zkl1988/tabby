import { z } from "zod";

/**
 * Prompt-to-image generation for the canvas workbench (design doc
 * 2026-07-03-infinite-canvas-sidebar.md, S7). The controller drives the
 * OpenClaw `image_generate` agent tool over a dedicated utility subagent
 * lane and returns a URL servable by GET /api/v1/media/state-file.
 *
 * W2.5-2.6: extended with reference images, multi-count, video and audio
 * channels (UNAVAILABLE-first — channels ship before backend skills land).
 */

export const generatedMediaItemSchema = z.object({
  /** Servable URL (relative to the controller origin). */
  url: z.string(),
  /** Absolute path of the generated file inside the OpenClaw media dir. */
  path: z.string(),
});

export const generateImageRequestSchema = z
  .object({
    prompt: z.string().min(1).max(2_000),
    /**
     * Optional reference images to guide generation. Paths must resolve under
     * the OpenClaw media dir. Up to 4 references. If the active backend does
     * not support references the block is silently ignored by the agent.
     */
    referenceImages: z.array(z.string().min(1)).max(4).optional(),
    /**
     * Number of images to generate. Defaults to 1. Up to 12 (agent-loop
     * driven — high counts are slow). Passed as a hint.
     */
    count: z.number().int().min(1).max(12).optional(),
    /**
     * Preferred generation model — a best-effort hint. The utility lane honors
     * it only if the active image tool/skill supports model selection.
     */
    model: z.string().max(120).optional(),
    /** Output quality hint (auto/high/medium/low). Best-effort. */
    quality: z.enum(["auto", "high", "medium", "low"]).optional(),
    /** Aspect-ratio hint, e.g. "1:1", "16:9", "3:4". Best-effort. */
    aspectRatio: z.string().max(16).optional(),
    /** Output size hint, e.g. "1024x1024", "2K", "4K". Best-effort. */
    size: z.string().max(32).optional(),
    /** Generate with a transparent (alpha) background. Best-effort hint. */
    transparentBackground: z.boolean().optional(),
    /**
     * Source image for inpaint / img2img. Servable absolute path under the
     * OpenClaw media dir. When provided the agent edits this image rather
     * than generating from scratch.
     */
    sourceImage: z.string().min(1).optional(),
    /**
     * Mask data URL (data:image/...) marking the editable region. White
     * pixels = editable, black pixels = keep unchanged. Max 8 MB. Requires
     * sourceImage to be present.
     */
    maskDataUrl: z.string().startsWith("data:image/").max(8_000_000).optional(),
  })
  .refine(
    (v) => !(v.maskDataUrl !== undefined && v.sourceImage === undefined),
    { message: "maskDataUrl requires sourceImage", path: ["maskDataUrl"] },
  );

export const generateImageResponseSchema = z.object({
  /** Servable URL of the first generated file (back-compat with S7). */
  url: z.string(),
  /** Absolute path of the first generated file (back-compat with S7). */
  path: z.string(),
  /** All generated items (≥1). url/path duplicate items[0]. */
  items: z.array(generatedMediaItemSchema).min(1),
});

export const imageGenerationJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);

/**
 * Controller-owned asynchronous image-generation job. The submission route
 * returns this shape immediately; clients poll the same resource until it
 * reaches a terminal status.
 */
export const imageGenerationJobSchema = z.object({
  jobId: z.string().uuid(),
  status: imageGenerationJobStatusSchema,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  result: generateImageResponseSchema.optional(),
  error: z.string().optional(),
});

export const generateVideoRequestSchema = z
  .object({
    prompt: z.string().min(1).max(2_000),
    /** Legacy clip duration; new clients send numFrames + frameRate. */
    durationSeconds: z.number().int().min(1).max(60).optional(),
    /** Optional output resolution hint. */
    resolution: z.enum(["480p", "720p", "1080p"]).optional(),
    /** Preferred generation model — best-effort hint. */
    model: z.string().max(120).optional(),
    /** Aspect-ratio hint, e.g. "16:9", "9:16", "1:1". Best-effort. */
    aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional(),
    /** Frame count accepted by Agnes Video: <=441 and 8n+1. */
    numFrames: z
      .number()
      .int()
      .min(1)
      .max(441)
      .refine((value) => (value - 1) % 8 === 0, "must follow the 8n+1 rule")
      .optional(),
    /** Output frame rate accepted by Agnes Video. */
    frameRate: z.number().min(1).max(60).optional(),
    /** Optional model inference step count. */
    numInferenceSteps: z.number().int().positive().optional(),
    /** Content that the video model should avoid. */
    negativePrompt: z.string().max(2_000).optional(),
    /** Optional deterministic generation seed. */
    seed: z.number().int().safe().optional(),
    /** Ask the backend to also generate an audio track. Best-effort. */
    generateAudio: z.boolean().optional(),
    /** Ask the backend to add a watermark. Best-effort. */
    watermark: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.numFrames !== undefined && value.durationSeconds !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["durationSeconds"],
        message: "durationSeconds and numFrames are mutually exclusive",
      });
    }

    if (value.durationSeconds !== undefined) {
      const frameRate = value.frameRate ?? 24;
      const nearestStep = Math.round(
        (value.durationSeconds * frameRate - 1) / 8,
      );
      if (nearestStep > 55) {
        ctx.addIssue({
          code: "custom",
          path: ["durationSeconds"],
          message: "duration and frameRate require more than 441 frames",
        });
      }
    }
  });

export const generateVideoResponseSchema = z.object({
  url: z.string(),
  path: z.string(),
  items: z.array(generatedMediaItemSchema).min(1),
});

/**
 * Controller-owned asynchronous video-generation job — same lifecycle as the
 * image one. Video runs long enough that a page reload would otherwise orphan
 * it, so the canvas persists the job id and resumes polling after a refresh.
 */
export const videoGenerationJobSchema = z.object({
  jobId: z.string().uuid(),
  status: imageGenerationJobStatusSchema,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  result: generateVideoResponseSchema.optional(),
  error: z.string().optional(),
});

export const generateAudioRequestSchema = z.object({
  prompt: z.string().min(1).max(2_000),
  /** Optional voice identifier passed as a hint to the TTS backend. */
  voice: z.string().max(100).optional(),
  /** Optional playback speed multiplier (0.5–2). */
  speed: z.number().min(0.5).max(2).optional(),
  /** Preferred generation model — best-effort hint. */
  model: z.string().max(120).optional(),
  /** Output format hint. Best-effort. */
  format: z.enum(["mp3", "wav", "m4a", "ogg", "flac"]).optional(),
  /** Extra voice/style instructions for the TTS backend. Best-effort. */
  instructions: z.string().max(1_000).optional(),
});

export const generateAudioResponseSchema = z.object({
  url: z.string(),
  path: z.string(),
  items: z.array(generatedMediaItemSchema).min(1),
});

/**
 * Enhance-image channel: super-resolve (upscale) or multi-angle (re-render
 * from a different camera angle). UNAVAILABLE-first — ships before backend
 * skills land.
 */
export const enhanceImageRequestSchema = z.object({
  /** Source image to enhance. Absolute path under the OpenClaw media dir. */
  sourceImage: z.string().min(1),
  /** Operation to perform. */
  operation: z.enum(["super-resolve", "multi-angle"]),
  /**
   * For super-resolve: the target long-edge pixel count. Defaults to 2048.
   */
  targetLongEdge: z
    .union([z.literal(1024), z.literal(2048), z.literal(4096)])
    .optional(),
  /** For multi-angle: horizontal (yaw) rotation in degrees. */
  horizontalDeg: z.number().min(-60).max(60).optional(),
  /** For multi-angle: pitch (tilt) rotation in degrees. */
  pitchDeg: z.number().min(-45).max(45).optional(),
  /** For multi-angle: distance factor (1–10). */
  distance: z.number().min(1).max(10).optional(),
  /** For multi-angle: apply wide-angle lens effect. */
  wideAngle: z.boolean().optional(),
  /** Optional extra guidance prompt for either operation. */
  prompt: z.string().max(2_000).optional(),
});

export const enhanceImageResponseSchema = z.object({
  url: z.string(),
  path: z.string(),
  items: z.array(generatedMediaItemSchema).min(1),
});

/**
 * Describe-image channel: reverse-prompt (generate a text-to-image prompt
 * that describes the given image). May work today with vision-capable models.
 */
export const describeImageRequestSchema = z.object({
  /** Source image to describe. Absolute path under the OpenClaw media dir. */
  sourceImage: z.string().min(1),
});

export const describeImageResponseSchema = z.object({
  /** The text-to-image generation prompt that would recreate the image. */
  prompt: z.string(),
});

/**
 * Save a browser-drawn image (data URL) into the OpenClaw inbound media dir so
 * it can be used as a generation reference.
 *
 * Reference images must be absolute paths under the media dir — a data URL is
 * rejected — so anything composed on the canvas (today: the mask annotation)
 * has to land on disk first.
 */
export const saveInboundImageRequestSchema = z.object({
  /** `data:image/png;base64,...`. Capped so a stray upload can't fill the dir. */
  dataUrl: z.string().min(1).max(24_000_000),
  /** Filename prefix, e.g. "mask-annotation". Sanitized server-side. */
  prefix: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
});

export const saveInboundImageResponseSchema = z.object({
  /** Absolute path under the media dir — what `referenceImages` takes. */
  path: z.string(),
  /** Servable URL for rendering it on the canvas. */
  url: z.string(),
});

/**
 * Generate-text channel: write new text, or rewrite/transform existing text,
 * via the utility lane. Returns the resulting text (no media file). May work
 * today with any chat-capable model.
 */
export const generateTextRequestSchema = z.object({
  /** The instruction / prompt. */
  prompt: z.string().min(1).max(4_000),
  /** Optional existing text to rewrite/transform (rewrite mode). */
  sourceText: z.string().max(8_000).optional(),
  /** Preferred model — best-effort hint. */
  model: z.string().max(120).optional(),
});

export const generateTextResponseSchema = z.object({
  /** The generated / rewritten text. */
  text: z.string(),
});

export type SaveInboundImageRequest = z.infer<
  typeof saveInboundImageRequestSchema
>;
export type SaveInboundImageResponse = z.infer<
  typeof saveInboundImageResponseSchema
>;
export type GenerateTextRequest = z.infer<typeof generateTextRequestSchema>;
export type GenerateTextResponse = z.infer<typeof generateTextResponseSchema>;
export type GeneratedMediaItem = z.infer<typeof generatedMediaItemSchema>;
export type GenerateImageRequest = z.infer<typeof generateImageRequestSchema>;
export type GenerateImageResponse = z.infer<typeof generateImageResponseSchema>;
export type ImageGenerationJobStatus = z.infer<
  typeof imageGenerationJobStatusSchema
>;
export type ImageGenerationJob = z.infer<typeof imageGenerationJobSchema>;
export type GenerateVideoRequest = z.infer<typeof generateVideoRequestSchema>;
export type GenerateVideoResponse = z.infer<typeof generateVideoResponseSchema>;
export type VideoGenerationJob = z.infer<typeof videoGenerationJobSchema>;
export type GenerateAudioRequest = z.infer<typeof generateAudioRequestSchema>;
export type GenerateAudioResponse = z.infer<typeof generateAudioResponseSchema>;
export type EnhanceImageRequest = z.infer<typeof enhanceImageRequestSchema>;
export type EnhanceImageResponse = z.infer<typeof enhanceImageResponseSchema>;
export type DescribeImageRequest = z.infer<typeof describeImageRequestSchema>;
export type DescribeImageResponse = z.infer<typeof describeImageResponseSchema>;
