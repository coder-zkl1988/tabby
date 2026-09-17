/**
 * canvas-generation.ts
 *
 * UI-free generation seam. All later generation flows (prompt panel T4, Config
 * node T5, batch T6) extend this module — keep it clean and typed.
 *
 * Imports: sdk.gen (API calls) + canvas-store (state) only.
 */

import {
  postApiV1MediaDescribeImage,
  postApiV1MediaEnhanceImage,
  postApiV1MediaGenerateAudio,
  postApiV1MediaGenerateText,
} from "../../../lib/api/sdk.gen";
import {
  submitImageGenerationJob,
  waitForImageGenerationJob,
} from "../media/image-generation-jobs";
import {
  submitVideoGenerationJob,
  waitForVideoGenerationJob,
} from "../media/video-generation-jobs";
import { attachBatchChildren } from "./canvas-batch";
import type { CanvasNodeMetadata } from "./canvas-store";
import { getCanvasState, setNodeTask, updateNode } from "./canvas-store";
import {
  MAX_TEXT_ALTERNATIVES,
  attachTextAlternatives,
} from "./canvas-text-alternatives";
import type { VideoAspectRatio } from "./video-generation-params";

/** The image branch of a node's persisted retry payload. */
type ImageRetry = Extract<
  NonNullable<NonNullable<CanvasNodeMetadata["task"]>["retry"]>,
  { kind: "image" }
>;

// ── Image ──────────────────────────────────────────────────────

/**
 * Kick off an image generation into `nodeId`.
 *
 * 1. Sets the node's task to `generating` (with retry params).
 * 2. Calls the generate-image SDK endpoint.
 * 3. On success: writes `content` + `title` to the node, clears the task.
 * 4. On failure/throw: sets task to `error` with retry payload.
 * 5. If the node was deleted before the response arrives, does nothing.
 *
 * Returns `true` on success, `false` on failure.
 */
export async function generateImageIntoNode(
  nodeId: string,
  prompt: string,
  opts?: {
    referenceImages?: string[];
    count?: number;
    sourceImage?: string;
    maskDataUrl?: string;
    model?: string;
    quality?: "auto" | "high" | "medium" | "low";
    aspectRatio?: string;
    size?: string;
    transparentBackground?: boolean;
  },
): Promise<boolean> {
  // The retry payload is persisted with the node, so a retry — even after an
  // app restart — reproduces the generation with the same parameters instead of
  // silently falling back to defaults.
  const retry = {
    kind: "image" as const,
    prompt,
    ...(opts?.referenceImages !== undefined
      ? { referenceImages: opts.referenceImages }
      : {}),
    ...(opts?.count !== undefined ? { count: opts.count } : {}),
    ...(opts?.sourceImage !== undefined
      ? { sourceImage: opts.sourceImage }
      : {}),
    ...(opts?.maskDataUrl !== undefined
      ? { maskDataUrl: opts.maskDataUrl }
      : {}),
    ...(opts?.model !== undefined ? { model: opts.model } : {}),
    ...(opts?.quality !== undefined ? { quality: opts.quality } : {}),
    ...(opts?.aspectRatio !== undefined
      ? { aspectRatio: opts.aspectRatio }
      : {}),
    ...(opts?.size !== undefined ? { size: opts.size } : {}),
    ...(opts?.transparentBackground !== undefined
      ? { transparentBackground: opts.transparentBackground }
      : {}),
  };

  setNodeTask(nodeId, { status: "generating", retry });

  try {
    // Submit first, record the job id on the node, THEN wait: a reload in the
    // middle of a run resumes the poll instead of losing it.
    const jobId = await submitImageGenerationJob({
      prompt,
      ...(opts?.referenceImages !== undefined
        ? { referenceImages: opts.referenceImages }
        : {}),
      ...(opts?.count !== undefined ? { count: opts.count } : {}),
      ...(opts?.sourceImage !== undefined
        ? { sourceImage: opts.sourceImage }
        : {}),
      ...(opts?.maskDataUrl !== undefined
        ? { maskDataUrl: opts.maskDataUrl }
        : {}),
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(opts?.quality !== undefined ? { quality: opts.quality } : {}),
      ...(opts?.aspectRatio !== undefined
        ? { aspectRatio: opts.aspectRatio }
        : {}),
      ...(opts?.size !== undefined ? { size: opts.size } : {}),
      ...(opts?.transparentBackground !== undefined
        ? { transparentBackground: opts.transparentBackground }
        : {}),
    });
    if (!getCanvasState().nodes.some((n) => n.id === nodeId)) return false;
    setNodeTask(nodeId, {
      status: "generating",
      retry,
      job: { kind: "image", jobId },
    });

    const data = await waitForImageGenerationJob(jobId);

    // Check if the node still exists (may have been deleted during the async call).
    const stillExists = getCanvasState().nodes.some((n) => n.id === nodeId);
    if (!stillExists) return false;

    applyImageJobResult(nodeId, data, prompt, opts?.count ?? 1, retry);
    return true;
  } catch (error) {
    // Check node existence before writing error state.
    const stillExists = getCanvasState().nodes.some((n) => n.id === nodeId);
    if (!stillExists) return false;

    setNodeTask(nodeId, {
      status: "error",
      error: readMediaErrorMessage(error, "生成失败，请重试"),
      retry,
    });
    return false;
  }
}

function readMediaErrorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim() !== ""
  ) {
    return error.message.trim().slice(0, 160);
  }
  return fallback;
}

/**
 * Write a finished image job onto its node.
 *
 * Shared by the live path and the post-reload resume, so a run that finished
 * while the app was closed lands exactly like one that finished in front of you
 * — batch fan-out, failed placeholders and all.
 *
 * T6: batch fan-out is image-only. attachBatchChildren owns root content and
 * child creation for multi-item results; the single-item path is preserved. The
 * lane can return FEWER pictures than requested; the shortfall becomes failed
 * placeholders whose retry regenerates exactly one (count omitted).
 */
function applyImageJobResult(
  nodeId: string,
  data: { url: string; items?: ReadonlyArray<{ url: string }> },
  prompt: string,
  requested: number,
  retry: ImageRetry,
): void {
  updateNode(nodeId, { title: prompt.slice(0, 30) });
  const items = data.items ?? [];
  if (items.length > 1 || (requested > 1 && items.length < requested)) {
    const { count: _dropped, ...singleRetry } = retry;
    attachBatchChildren(nodeId, items, { requested, retry: singleRetry });
  } else {
    updateNode(nodeId, { metadata: { content: data.url } });
  }
  setNodeTask(nodeId, null);
}

// ── Video ──────────────────────────────────────────────────────

/**
 * Kick off a video generation into `nodeId`.
 * Lifecycle mirrors generateImageIntoNode: generating → content=url + clear / error+retry.
 * Returns `true` on success, `false` on failure.
 */
// ── Text ───────────────────────────────────────────────────────

/**
 * Generate (or rewrite) text into a text `nodeId`. On success writes the
 * result to `metadata.content` (TextNodeContent renders it). Lifecycle mirrors
 * generateImageIntoNode: generating → content + clear / error+retry.
 */
export async function generateTextIntoNode(
  nodeId: string,
  prompt: string,
  opts?: { sourceText?: string; model?: string; count?: number },
): Promise<boolean> {
  const retry = {
    kind: "text" as const,
    prompt,
    ...(opts?.sourceText !== undefined ? { sourceText: opts.sourceText } : {}),
    ...(opts?.model !== undefined ? { model: opts.model } : {}),
    ...(opts?.count !== undefined ? { count: opts.count } : {}),
  };

  // Alternatives are independent samples, so they are independent requests —
  // the backend gives each call its own utility-lane session anyway. Fanning
  // out here (rather than adding a count to the endpoint) also means one
  // failed sample doesn't take the others down with it.
  const requested = Math.min(
    Math.max(1, Math.floor(opts?.count ?? 1)),
    MAX_TEXT_ALTERNATIVES,
  );

  setNodeTask(nodeId, { status: "generating", retry });

  const body = {
    prompt,
    ...(opts?.sourceText !== undefined ? { sourceText: opts.sourceText } : {}),
    ...(opts?.model !== undefined ? { model: opts.model } : {}),
  };

  const settled = await Promise.allSettled(
    Array.from({ length: requested }, () =>
      postApiV1MediaGenerateText({ body }),
    ),
  );

  const stillExists = getCanvasState().nodes.some((n) => n.id === nodeId);
  if (!stillExists) return false;

  const texts: string[] = [];
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    const { data, error } = outcome.value;
    if (!data || error) continue;
    texts.push(data.text);
  }

  if (texts.length === 0) {
    setNodeTask(nodeId, {
      status: "error",
      error: "生成失败，请重试",
      retry,
    });
    return false;
  }

  updateNode(nodeId, { title: prompt.slice(0, 30) });
  attachTextAlternatives(nodeId, texts, requested);
  setNodeTask(nodeId, null);
  return true;
}

// ── Video ──────────────────────────────────────────────────────

export async function generateVideoIntoNode(
  nodeId: string,
  prompt: string,
  opts?: {
    durationSeconds?: number;
    resolution?: "480p" | "720p" | "1080p";
    model?: string;
    aspectRatio?: VideoAspectRatio;
    numFrames?: number;
    frameRate?: number;
    numInferenceSteps?: number;
    negativePrompt?: string;
    seed?: number;
    generateAudio?: boolean;
    watermark?: boolean;
  },
): Promise<boolean> {
  const retry = {
    kind: "video" as const,
    prompt,
    ...(opts?.durationSeconds !== undefined
      ? { durationSeconds: opts.durationSeconds }
      : {}),
    ...(opts?.resolution !== undefined ? { resolution: opts.resolution } : {}),
    ...(opts?.model !== undefined ? { model: opts.model } : {}),
    ...(opts?.aspectRatio !== undefined
      ? { aspectRatio: opts.aspectRatio }
      : {}),
    ...(opts?.numFrames !== undefined ? { numFrames: opts.numFrames } : {}),
    ...(opts?.frameRate !== undefined ? { frameRate: opts.frameRate } : {}),
    ...(opts?.numInferenceSteps !== undefined
      ? { numInferenceSteps: opts.numInferenceSteps }
      : {}),
    ...(opts?.negativePrompt !== undefined
      ? { negativePrompt: opts.negativePrompt }
      : {}),
    ...(opts?.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts?.generateAudio !== undefined
      ? { generateAudio: opts.generateAudio }
      : {}),
    ...(opts?.watermark !== undefined ? { watermark: opts.watermark } : {}),
  };

  setNodeTask(nodeId, { status: "generating", retry });

  try {
    // Video runs for minutes, so it goes through the controller job queue and
    // its id is persisted — a reload resumes the poll.
    const jobId = await submitVideoGenerationJob({
      prompt,
      ...(opts?.durationSeconds !== undefined
        ? { durationSeconds: opts.durationSeconds }
        : {}),
      ...(opts?.resolution !== undefined
        ? { resolution: opts.resolution }
        : {}),
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(opts?.aspectRatio !== undefined
        ? { aspectRatio: opts.aspectRatio }
        : {}),
      ...(opts?.numFrames !== undefined ? { numFrames: opts.numFrames } : {}),
      ...(opts?.frameRate !== undefined ? { frameRate: opts.frameRate } : {}),
      ...(opts?.numInferenceSteps !== undefined
        ? { numInferenceSteps: opts.numInferenceSteps }
        : {}),
      ...(opts?.negativePrompt !== undefined
        ? { negativePrompt: opts.negativePrompt }
        : {}),
      ...(opts?.seed !== undefined ? { seed: opts.seed } : {}),
      ...(opts?.generateAudio !== undefined
        ? { generateAudio: opts.generateAudio }
        : {}),
      ...(opts?.watermark !== undefined ? { watermark: opts.watermark } : {}),
    });
    if (!getCanvasState().nodes.some((n) => n.id === nodeId)) return false;
    setNodeTask(nodeId, {
      status: "generating",
      retry,
      job: { kind: "video", jobId },
    });

    const data = await waitForVideoGenerationJob(jobId);

    const stillExists = getCanvasState().nodes.some((n) => n.id === nodeId);
    if (!stillExists) return false;

    // Video and audio stay single-result (no batch fan-out).
    updateNode(nodeId, {
      title: prompt.slice(0, 30),
      metadata: { content: data.url },
    });
    setNodeTask(nodeId, null);
    return true;
  } catch {
    const stillExists = getCanvasState().nodes.some((n) => n.id === nodeId);
    if (!stillExists) return false;

    setNodeTask(nodeId, {
      status: "error",
      error: "生成失败，请重试",
      retry,
    });
    return false;
  }
}

// ── Audio ──────────────────────────────────────────────────────

/**
 * Kick off an audio generation into `nodeId`.
 * Lifecycle mirrors generateImageIntoNode: generating → content=url + clear / error+retry.
 * Returns `true` on success, `false` on failure.
 */
export async function generateAudioIntoNode(
  nodeId: string,
  prompt: string,
  opts?: {
    voice?: string;
    speed?: number;
    model?: string;
    format?: "mp3" | "wav" | "m4a" | "ogg" | "flac";
    instructions?: string;
  },
): Promise<boolean> {
  const retry = {
    kind: "audio" as const,
    prompt,
    ...(opts?.voice !== undefined ? { voice: opts.voice } : {}),
    ...(opts?.speed !== undefined ? { speed: opts.speed } : {}),
    ...(opts?.model !== undefined ? { model: opts.model } : {}),
    ...(opts?.format !== undefined ? { format: opts.format } : {}),
    ...(opts?.instructions !== undefined
      ? { instructions: opts.instructions }
      : {}),
  };

  setNodeTask(nodeId, { status: "generating", retry });

  try {
    const { data, error } = await postApiV1MediaGenerateAudio({
      body: {
        prompt,
        ...(opts?.voice !== undefined ? { voice: opts.voice } : {}),
        ...(opts?.speed !== undefined ? { speed: opts.speed } : {}),
        ...(opts?.model !== undefined ? { model: opts.model } : {}),
        ...(opts?.format !== undefined ? { format: opts.format } : {}),
        ...(opts?.instructions !== undefined
          ? { instructions: opts.instructions }
          : {}),
      },
    });

    const stillExists = getCanvasState().nodes.some((n) => n.id === nodeId);
    if (!stillExists) return false;

    if (!data || error) {
      setNodeTask(nodeId, {
        status: "error",
        error: "生成失败，请重试",
        retry,
      });
      return false;
    }

    // Audio stays single-result (no batch fan-out).
    updateNode(nodeId, {
      title: prompt.slice(0, 30),
      metadata: { content: data.url },
    });
    setNodeTask(nodeId, null);
    return true;
  } catch {
    const stillExists = getCanvasState().nodes.some((n) => n.id === nodeId);
    if (!stillExists) return false;

    setNodeTask(nodeId, {
      status: "error",
      error: "生成失败，请重试",
      retry,
    });
    return false;
  }
}

// ── Enhance ────────────────────────────────────────────────────

type EnhanceInput = {
  sourceImage: string;
  operation: "super-resolve" | "multi-angle";
  targetLongEdge?: 1024 | 2048 | 4096;
  horizontalDeg?: number;
  pitchDeg?: number;
  distance?: number;
  wideAngle?: boolean;
  prompt?: string;
};

/**
 * Kick off an image enhancement (super-resolve or multi-angle) into `nodeId`.
 * Lifecycle mirrors generateImageIntoNode: generating → content=url + clear / error+retry.
 * Returns `true` on success, `false` on failure.
 */
export async function enhanceImageIntoNode(
  nodeId: string,
  input: EnhanceInput,
): Promise<boolean> {
  const retry = { kind: "enhance" as const, ...input };

  setNodeTask(nodeId, { status: "generating", retry });

  try {
    const { data, error } = await postApiV1MediaEnhanceImage({
      body: {
        sourceImage: input.sourceImage,
        operation: input.operation,
        ...(input.targetLongEdge !== undefined
          ? { targetLongEdge: input.targetLongEdge }
          : {}),
        ...(input.horizontalDeg !== undefined
          ? { horizontalDeg: input.horizontalDeg }
          : {}),
        ...(input.pitchDeg !== undefined ? { pitchDeg: input.pitchDeg } : {}),
        ...(input.distance !== undefined ? { distance: input.distance } : {}),
        ...(input.wideAngle !== undefined
          ? { wideAngle: input.wideAngle }
          : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      },
    });

    const stillExists = getCanvasState().nodes.some((n) => n.id === nodeId);
    if (!stillExists) return false;

    if (!data || error) {
      setNodeTask(nodeId, {
        status: "error",
        error: "生成失败，请重试",
        retry,
      });
      return false;
    }

    updateNode(nodeId, { metadata: { content: data.url } });
    setNodeTask(nodeId, null);
    return true;
  } catch {
    const stillExists = getCanvasState().nodes.some((n) => n.id === nodeId);
    if (!stillExists) return false;

    setNodeTask(nodeId, {
      status: "error",
      error: "生成失败，请重试",
      retry,
    });
    return false;
  }
}

// ── Describe ───────────────────────────────────────────────────

/**
 * Describe an image source to get a text-to-image prompt.
 * Plain call (no node/task lifecycle). Returns trimmed prompt or null on any failure.
 */
export async function describeImageSource(
  sourceImage: string,
): Promise<string | null> {
  try {
    const { data, error } = await postApiV1MediaDescribeImage({
      body: { sourceImage },
    });
    if (!data || error) return null;
    const trimmed = data.prompt.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

// ── Retry ──────────────────────────────────────────────────────

/**
 * Fire-and-forget retry: reads the node's `task.retry` and re-runs the
 * matching generation. No-op if the node has no retry payload or doesn't exist.
 */
export function retryNodeTask(nodeId: string): void {
  const node = getCanvasState().nodes.find((n) => n.id === nodeId);
  const retry = node?.metadata.task?.retry;
  if (!retry) return;
  if (retry.kind === "image") {
    void generateImageIntoNode(nodeId, retry.prompt, {
      referenceImages: retry.referenceImages,
      count: retry.count,
      sourceImage: retry.sourceImage,
      maskDataUrl: retry.maskDataUrl,
      model: retry.model,
      quality: retry.quality,
      aspectRatio: retry.aspectRatio,
      size: retry.size,
      transparentBackground: retry.transparentBackground,
    });
  } else if (retry.kind === "video") {
    void generateVideoIntoNode(nodeId, retry.prompt, {
      durationSeconds: retry.durationSeconds,
      resolution: retry.resolution,
      model: retry.model,
      aspectRatio: retry.aspectRatio,
      numFrames: retry.numFrames,
      frameRate: retry.frameRate,
      numInferenceSteps: retry.numInferenceSteps,
      negativePrompt: retry.negativePrompt,
      seed: retry.seed,
      generateAudio: retry.generateAudio,
      watermark: retry.watermark,
    });
  } else if (retry.kind === "audio") {
    void generateAudioIntoNode(nodeId, retry.prompt, {
      voice: retry.voice,
      speed: retry.speed,
      model: retry.model,
      format: retry.format,
      instructions: retry.instructions,
    });
  } else if (retry.kind === "text") {
    void generateTextIntoNode(nodeId, retry.prompt, {
      sourceText: retry.sourceText,
      model: retry.model,
      count: retry.count,
    });
  } else if (retry.kind === "enhance") {
    void enhanceImageIntoNode(nodeId, {
      sourceImage: retry.sourceImage,
      operation: retry.operation,
      targetLongEdge: retry.targetLongEdge,
      horizontalDeg: retry.horizontalDeg,
      pitchDeg: retry.pitchDeg,
      distance: retry.distance,
      wideAngle: retry.wideAngle,
      prompt: retry.prompt,
    });
  }
}

// ── Resume after a reload ──────────────────────────────────────

/**
 * Re-attach to a controller job that was still running when the page went away.
 *
 * `normalizeInterruptedTasks` deliberately leaves job-backed tasks `generating`
 * on hydrate; this is the other half of that bargain. If the controller no
 * longer knows the job — it restarted, or the 30-minute retention lapsed — the
 * poll fails and the node lands in `error` with a retry, which is the honest
 * outcome rather than a spinner that never resolves.
 */
export async function resumeGenerationJob(nodeId: string): Promise<boolean> {
  const task = getCanvasState().nodes.find((n) => n.id === nodeId)?.metadata
    .task;
  const job = task?.job;
  if (!task || task.status !== "generating" || !job) return false;
  const retry = task.retry;

  try {
    if (job.kind === "image") {
      const data = await waitForImageGenerationJob(job.jobId);
      if (!getCanvasState().nodes.some((n) => n.id === nodeId)) return false;
      // A job-backed image task always carries an image retry payload; the
      // fallback keeps the applier total if a hand-written board lacks one.
      const imageRetry: ImageRetry =
        retry?.kind === "image" ? retry : { kind: "image", prompt: "" };
      applyImageJobResult(
        nodeId,
        data,
        imageRetry.prompt,
        imageRetry.count ?? 1,
        imageRetry,
      );
      return true;
    }

    const data = await waitForVideoGenerationJob(job.jobId);
    if (!getCanvasState().nodes.some((n) => n.id === nodeId)) return false;
    updateNode(nodeId, { metadata: { content: data.url } });
    setNodeTask(nodeId, null);
    return true;
  } catch (error) {
    if (!getCanvasState().nodes.some((n) => n.id === nodeId)) return false;
    setNodeTask(nodeId, {
      status: "error",
      error: error instanceof Error ? error.message : "生成失败，请重试",
      ...(retry ? { retry } : {}),
    });
    return false;
  }
}

/**
 * Resume every job-backed generation on the current board. Call once after
 * hydration; nodes without a job reference are untouched.
 */
export function resumeGenerationJobs(): void {
  for (const node of getCanvasState().nodes) {
    const task = node.metadata.task;
    if (task?.status === "generating" && task.job) {
      void resumeGenerationJob(node.id);
    }
  }
}
