/**
 * config-node-logic.ts
 *
 * Pure plan builder for the config generation node (W2.4).
 *
 * Reads the config node's metadata.config + upstream resources, assembles a
 * typed plan, then dispatches to the matching generation seam. Per-mode
 * generation params (model/quality/aspect/size/…) are best-effort hints.
 */

import {
  generateAudioIntoNode,
  generateImageIntoNode,
  generateTextIntoNode,
  generateVideoIntoNode,
} from "./canvas-generation";
import { addNode, connectNodes, getCanvasState } from "./canvas-store";
import {
  labelUpstreamTextBlocks,
  resolveImagePixelSize,
  usableReferencePaths,
} from "./prompt-panel-utils";
import { collectUpstream } from "./resource-references";
import {
  type VideoAspectRatio,
  isVideoAspectRatio,
  isVideoResolution,
  resolveCanvasVideoNumFrames,
  resolveVideoFrameRate,
} from "./video-generation-params";

// ── Plan types ─────────────────────────────────────────────────

export type ConfigGenerationPlan =
  | {
      kind: "image";
      prompt: string;
      referenceImages: string[];
      count?: number;
      model?: string;
      quality?: "auto" | "high" | "medium" | "low";
      aspectRatio?: string;
      size?: string;
    }
  | {
      kind: "video";
      prompt: string;
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
    }
  | {
      kind: "audio";
      prompt: string;
      voice?: string;
      speed?: number;
      model?: string;
      format?: "mp3" | "wav" | "m4a" | "ogg" | "flac";
      instructions?: string;
    }
  | {
      kind: "text";
      prompt: string;
      model?: string;
      /** How many alternatives to generate (1-4). */
      count?: number;
    };

type PlanError = { error: "no-config" | "no-prompt" };

// ── buildConfigGenerationPlan ──────────────────────────────────

/**
 * Build a typed generation plan from the config node's current state.
 *
 * - Reads `metadata.config` for mode/params.
 * - Reads upstream resources: prompts joined with `"\n\n"` as 【文本N】-labeled
 *   blocks (trimmed items), images filtered through `usableReferencePaths`.
 * - Returns `{ error: "no-config" }` if `metadata.config` is absent.
 * - Returns `{ error: "no-prompt" }` if upstream produces no non-empty prompt.
 */
export function buildConfigGenerationPlan(
  nodeId: string,
): ConfigGenerationPlan | PlanError {
  const node = getCanvasState().nodes.find((n) => n.id === nodeId);
  if (!node?.metadata.config) return { error: "no-config" };

  const cfg = node.metadata.config;
  const upstream = collectUpstream(nodeId);

  // Prompt = the composer's base prompt (if any) followed by the trimmed,
  // non-empty upstream text items as 【文本N】-labeled blocks, joined with a
  // double newline. Same helper as the prompt panel so a given text node
  // carries the same number on both paths.
  const composed = cfg.composedPrompt?.trim();
  const prompt = [composed, ...labelUpstreamTextBlocks(upstream.prompts)]
    .filter((p): p is string => p !== undefined && p.length > 0)
    .join("\n\n");

  if (prompt.length === 0) return { error: "no-prompt" };

  if (cfg.mode === "image") {
    const referenceImages = usableReferencePaths(upstream.images);
    // Same fixed table as the prompt panel: a tier plus an aspect ratio resolves
    // to concrete pixels, a tier on its own is sent as-is.
    const pixelSize = resolveImagePixelSize(
      cfg.size ?? "",
      cfg.aspectRatio ?? "",
    );
    return {
      kind: "image",
      prompt,
      referenceImages,
      ...(cfg.count !== undefined ? { count: cfg.count } : {}),
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      ...(cfg.quality !== undefined ? { quality: cfg.quality } : {}),
      ...(cfg.aspectRatio !== undefined
        ? { aspectRatio: cfg.aspectRatio }
        : {}),
      ...(cfg.size !== undefined ? { size: pixelSize ?? cfg.size } : {}),
    };
  }

  if (cfg.mode === "video") {
    const frameRate = resolveVideoFrameRate(cfg.frameRate);
    const numFrames = resolveCanvasVideoNumFrames({
      numFrames: cfg.numFrames,
      durationSeconds: cfg.durationSeconds,
      frameRate,
    });
    const negativePrompt = cfg.negativePrompt?.trim().slice(0, 2_000);
    const usesTabbyVideo =
      cfg.model === undefined ||
      cfg.model === "tabby-video" ||
      cfg.model === "tabby-video-free";
    return {
      kind: "video",
      prompt,
      numFrames,
      frameRate,
      ...(isVideoResolution(cfg.resolution)
        ? { resolution: cfg.resolution }
        : {}),
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      ...(isVideoAspectRatio(cfg.aspectRatio)
        ? { aspectRatio: cfg.aspectRatio }
        : {}),
      ...(negativePrompt !== undefined && negativePrompt.length > 0
        ? { negativePrompt }
        : {}),
      ...(cfg.numInferenceSteps !== undefined &&
      Number.isSafeInteger(cfg.numInferenceSteps) &&
      cfg.numInferenceSteps > 0
        ? { numInferenceSteps: cfg.numInferenceSteps }
        : {}),
      ...(cfg.seed !== undefined && Number.isSafeInteger(cfg.seed)
        ? { seed: cfg.seed }
        : {}),
      ...(!usesTabbyVideo && cfg.generateAudio !== undefined
        ? { generateAudio: cfg.generateAudio }
        : {}),
      ...(!usesTabbyVideo && cfg.watermark !== undefined
        ? { watermark: cfg.watermark }
        : {}),
    };
  }

  if (cfg.mode === "text") {
    return {
      kind: "text",
      prompt,
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      ...(cfg.textCount !== undefined ? { count: cfg.textCount } : {}),
    };
  }

  // audio
  return {
    kind: "audio",
    prompt,
    ...(cfg.voice !== undefined ? { voice: cfg.voice } : {}),
    ...(cfg.speed !== undefined ? { speed: cfg.speed } : {}),
    ...(cfg.model !== undefined ? { model: cfg.model } : {}),
    ...(cfg.format !== undefined ? { format: cfg.format } : {}),
    ...(cfg.instructions !== undefined
      ? { instructions: cfg.instructions }
      : {}),
  };
}

// ── runConfigGeneration ────────────────────────────────────────

/**
 * Build the plan, create a downstream result node, connect config→result,
 * then dispatch the matching generation seam into the result node.
 *
 * Returns the seam's promise on success, or null on plan error (no-config /
 * no-prompt).
 *
 * Result node position: config.x + config.width + 60, config.y.
 *
 * NOTE: concurrent 生成 clicks create separate result nodes (acceptable v1).
 */
export function runConfigGeneration(
  configNodeId: string,
): Promise<boolean> | null {
  const plan = buildConfigGenerationPlan(configNodeId);
  if ("error" in plan) return null;

  const configNode = getCanvasState().nodes.find((n) => n.id === configNodeId);
  if (!configNode) return null;

  const resultPosition = {
    x: configNode.position.x + configNode.size.width + 60,
    y: configNode.position.y,
  };

  const resultNode = addNode({
    type: plan.kind,
    title: "生成结果",
    position: resultPosition,
  });

  connectNodes(configNodeId, resultNode.id);

  if (plan.kind === "image") {
    return generateImageIntoNode(resultNode.id, plan.prompt, {
      referenceImages: plan.referenceImages,
      ...(plan.count !== undefined ? { count: plan.count } : {}),
      ...(plan.model !== undefined ? { model: plan.model } : {}),
      ...(plan.quality !== undefined ? { quality: plan.quality } : {}),
      ...(plan.aspectRatio !== undefined
        ? { aspectRatio: plan.aspectRatio }
        : {}),
      ...(plan.size !== undefined ? { size: plan.size } : {}),
    });
  }

  if (plan.kind === "video") {
    return generateVideoIntoNode(resultNode.id, plan.prompt, {
      ...(plan.durationSeconds !== undefined
        ? { durationSeconds: plan.durationSeconds }
        : {}),
      ...(plan.resolution !== undefined ? { resolution: plan.resolution } : {}),
      ...(plan.model !== undefined ? { model: plan.model } : {}),
      ...(plan.aspectRatio !== undefined
        ? { aspectRatio: plan.aspectRatio }
        : {}),
      ...(plan.numFrames !== undefined ? { numFrames: plan.numFrames } : {}),
      ...(plan.frameRate !== undefined ? { frameRate: plan.frameRate } : {}),
      ...(plan.numInferenceSteps !== undefined
        ? { numInferenceSteps: plan.numInferenceSteps }
        : {}),
      ...(plan.negativePrompt !== undefined
        ? { negativePrompt: plan.negativePrompt }
        : {}),
      ...(plan.seed !== undefined ? { seed: plan.seed } : {}),
      ...(plan.generateAudio !== undefined
        ? { generateAudio: plan.generateAudio }
        : {}),
      ...(plan.watermark !== undefined ? { watermark: plan.watermark } : {}),
    });
  }

  if (plan.kind === "text") {
    return generateTextIntoNode(resultNode.id, plan.prompt, {
      ...(plan.model !== undefined ? { model: plan.model } : {}),
      ...(plan.count !== undefined ? { count: plan.count } : {}),
    });
  }

  // audio
  return generateAudioIntoNode(resultNode.id, plan.prompt, {
    ...(plan.voice !== undefined ? { voice: plan.voice } : {}),
    ...(plan.speed !== undefined ? { speed: plan.speed } : {}),
    ...(plan.model !== undefined ? { model: plan.model } : {}),
    ...(plan.format !== undefined ? { format: plan.format } : {}),
    ...(plan.instructions !== undefined
      ? { instructions: plan.instructions }
      : {}),
  });
}
