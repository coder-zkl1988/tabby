import fs from "node:fs";
import path from "node:path";

const TABBY_IMAGE_MODEL = "tabby-image";
// Tier ids from earlier builds, still found in saved canvas nodes, XHS settings
// and old sessions. The relay now serves one image model, so they all map to it.
const LEGACY_IMAGE_MODEL_IDS = new Set([
  "tabby-image-pro",
  "tabby-image-flash",
  "tabby-image-free",
]);
const GPT_IMAGE_SIZE_TIERS = new Map([
  ["1K", 1024],
  ["2K", 2048],
  ["3K", 3072],
  ["4K", 3840],
]);
const IMAGE_RATIOS = new Set([
  "1:1",
  "3:4",
  "4:3",
  "16:9",
  "9:16",
  "2:3",
  "3:2",
  "21:9",
]);
const GPT_IMAGE_QUALITIES = new Set(["auto", "high", "medium", "low"]);

/**
 * Read and parse the OpenClaw config compiled by the Nexu controller.
 * Throws if OPENCLAW_STATE_DIR is unset or the file is missing/unparsable.
 */
export function readOpenclawConfig(stateDir) {
  if (!stateDir) {
    throw new Error(
      "ENV_MISSING: OPENCLAW_STATE_DIR is not set. This script must run inside an OpenClaw skill execution.",
    );
  }
  const configPath = path.join(stateDir, "openclaw.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`CONFIG_MISSING: ${configPath} does not exist.`);
  }
  const raw = fs.readFileSync(configPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `CONFIG_INVALID: failed to parse ${configPath}: ${err.message}`,
    );
  }
}

/**
 * Pick the tabby-image credential and model id out of an already-parsed
 * openclaw.json config object. A legacy tier id resolves to tabby-image.
 */
export function resolveLinkCredential(config, requestedModel) {
  const link = config?.models?.providers?.link;
  if (!link || typeof link.apiKey !== "string" || link.apiKey.length === 0) {
    throw new Error(
      "NOT_LOGGED_IN: No Tabby cloud credential found. Log into your official Tabby account in the desktop app, then try again.",
    );
  }
  if (typeof link.baseUrl !== "string" || link.baseUrl.length === 0) {
    throw new Error(
      "NOT_LOGGED_IN: No Tabby cloud credential found. Log into your official Tabby account in the desktop app, then try again.",
    );
  }

  if (
    requestedModel !== undefined &&
    requestedModel !== TABBY_IMAGE_MODEL &&
    !LEGACY_IMAGE_MODEL_IDS.has(requestedModel)
  ) {
    throw new Error(
      `INVALID_IMAGE_MODEL: ${requestedModel}. Use ${TABBY_IMAGE_MODEL}.`,
    );
  }

  const availableIds = new Set((link.models || []).map((m) => m.id));
  if (!availableIds.has(TABBY_IMAGE_MODEL)) {
    throw new Error(
      `NO_IMAGE_MODEL: Your Tabby account does not have access to ${TABBY_IMAGE_MODEL}.`,
    );
  }

  return {
    baseUrl: link.baseUrl,
    apiKey: link.apiKey,
    model: TABBY_IMAGE_MODEL,
  };
}

/** Build the OpenAI-compatible generations endpoint from the configured relay. */
export function buildImageGenerationsUrl(baseUrl) {
  const normalized = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!normalized) {
    throw new Error("BASE_URL_MISSING: Image relay baseUrl is not configured.");
  }
  return `${normalized.replace(/\/+$/, "")}/images/generations`;
}

function validateRatio(ratio) {
  if (ratio !== undefined && !IMAGE_RATIOS.has(ratio)) {
    throw new Error(
      `INVALID_RATIO: ${ratio}. Supported ratios: ${[...IMAGE_RATIOS].join(", ")}.`,
    );
  }
}

function ratioParts(ratio) {
  const [width, height] = (ratio ?? "1:1").split(":").map(Number);
  return { width, height };
}

function roundToMultipleOf16(value) {
  return Math.max(16, Math.round(value / 16) * 16);
}

function validateExactGptImageSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) {
    throw new Error(
      `INVALID_SIZE: ${size}. Use auto, 1K/2K/3K/4K, or WIDTHxHEIGHT.`,
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const aspect = width / height;
  if (
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    aspect < 1 / 3 ||
    aspect > 3 ||
    longEdge > 3840 ||
    shortEdge > 2160
  ) {
    throw new Error(
      `INVALID_SIZE: ${size}. GPT-image-2 requires dimensions divisible by 16, an aspect ratio between 1:3 and 3:1, and at most 3840x2160 (or portrait equivalent).`,
    );
  }
  return size;
}

function sizeForTier(tier, ratio) {
  const requestedLongEdge = GPT_IMAGE_SIZE_TIERS.get(tier);
  if (requestedLongEdge === undefined) {
    throw new Error(`INVALID_SIZE: unsupported GPT-image-2 tier ${tier}.`);
  }
  const { width: ratioWidth, height: ratioHeight } = ratioParts(ratio);
  const landscape = ratioWidth >= ratioHeight;
  const aspect = landscape
    ? ratioWidth / ratioHeight
    : ratioHeight / ratioWidth;
  const longEdge = roundToMultipleOf16(
    Math.min(requestedLongEdge, 3840, 2160 * aspect),
  );
  const shortEdge = roundToMultipleOf16(longEdge / aspect);
  const width = landscape ? longEdge : shortEdge;
  const height = landscape ? shortEdge : longEdge;
  return `${roundToMultipleOf16(width)}x${roundToMultipleOf16(height)}`;
}

function resolveGptImageSize(size, ratio) {
  validateRatio(ratio);
  if (size === "auto") return size;
  if (size !== undefined && GPT_IMAGE_SIZE_TIERS.has(size)) {
    return sizeForTier(size, ratio);
  }
  if (size !== undefined) {
    return validateExactGptImageSize(size);
  }
  if (ratio === undefined || ratio === "1:1") return "1024x1024";
  const { width, height } = ratioParts(ratio);
  const landscape = width >= height;
  const longEdge = 1536;
  const shortEdge = roundToMultipleOf16(
    longEdge / (landscape ? width / height : height / width),
  );
  return landscape ? `${longEdge}x${shortEdge}` : `${shortEdge}x${longEdge}`;
}

/**
 * Build the relay URL and request body. tabby-image follows GPT Image
 * generations.
 */
export function buildImageGenerationRequest({
  baseUrl,
  model,
  prompt,
  size,
  ratio,
  quality,
  transparentBackground = false,
}) {
  const url = buildImageGenerationsUrl(baseUrl);
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("PROMPT_MISSING: Image prompt is required.");
  }

  if (model === TABBY_IMAGE_MODEL) {
    if (quality !== undefined && !GPT_IMAGE_QUALITIES.has(quality)) {
      throw new Error(
        `INVALID_QUALITY: ${quality}. Supported qualities: auto, high, medium, low.`,
      );
    }
    const body = {
      model,
      prompt,
      n: 1,
      size: resolveGptImageSize(size, ratio),
    };
    if (quality !== undefined) {
      body.quality = quality;
    }
    if (transparentBackground) {
      body.background = "transparent";
    }
    return { url, body };
  }

  throw new Error(`INVALID_IMAGE_MODEL: ${model}. Use ${TABBY_IMAGE_MODEL}.`);
}

/**
 * Extract the generated image from an OpenAI-compatible images/generations
 * response body. Returns a base64 payload or a URL to download.
 */
export function parseImageResponse(body) {
  const entry = body?.data?.[0];
  if (
    entry &&
    typeof entry.b64_json === "string" &&
    entry.b64_json.length > 0
  ) {
    return { kind: "b64", data: entry.b64_json };
  }
  if (entry && typeof entry.url === "string" && entry.url.length > 0) {
    return { kind: "url", data: entry.url };
  }
  throw new Error(
    `BAD_RESPONSE: Gateway response did not contain an image. Body: ${JSON.stringify(body).slice(0, 200)}`,
  );
}

/**
 * Compute the absolute output path for a generated image, following the
 * same $OPENCLAW_STATE_DIR/media/outbound/{slugid}/{skillName}/{filename}
 * convention used by the nano-banana skill.
 */
export function resolveOutputPath({ stateDir, cwd, filename, skillName }) {
  if (path.isAbsolute(filename)) {
    return filename;
  }
  return path.join(
    stateDir,
    "media",
    "outbound",
    path.basename(cwd),
    skillName,
    filename,
  );
}
