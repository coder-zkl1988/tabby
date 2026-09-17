#!/usr/bin/env node

/**
 * Generate an image using the official Tabby Image model (GPT-image-2),
 * served through the user's own Tabby cloud login credential — no
 * separate API key setup required.
 *
 * Usage:
 *   node generate-image.js --prompt "a cat on mars" --filename output.png
 *   node generate-image.js --prompt "a cat on mars" --filename output.png --size 1024x1536
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  buildImageGenerationRequest,
  parseImageResponse,
  readOpenclawConfig,
  resolveLinkCredential,
  resolveOutputPath,
} from "./lib.js";

const SKILL_NAME = "tabby-image";

function printHelp() {
  console.log(`Usage: node generate-image.js --prompt "desc" --filename "out.png" [options]

Options:
  -p, --prompt                  Image description (required)
  -f, --filename                Output filename (required)
      --model                   tabby-image-pro or tabby-image-flash
      --size                    GPT: auto/1K/2K/3K/4K or WIDTHxHEIGHT;
                                Agnes: 1K/2K/3K/4K or WIDTHxHEIGHT
      --ratio                   1:1, 3:4, 4:3, 16:9, 9:16, 2:3, 3:2, 21:9
      --quality                 GPT: auto, high, medium, low (ignored by Agnes)
      --transparent-background GPT transparent background (ignored by Agnes)
  -h, --help                    Show this help`);
}

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      prompt: { type: "string", short: "p" },
      filename: { type: "string", short: "f" },
      model: { type: "string" },
      size: { type: "string" },
      ratio: { type: "string" },
      quality: { type: "string" },
      "transparent-background": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }
  if (!values.prompt) {
    console.error("Error: --prompt is required");
    process.exit(1);
  }
  if (!values.filename) {
    console.error("Error: --filename is required");
    process.exit(1);
  }

  return {
    prompt: values.prompt,
    filename: values.filename,
    model: values.model,
    size: values.size,
    ratio: values.ratio,
    quality: values.quality,
    transparentBackground: values["transparent-background"] === true,
  };
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download generated image (${res.status}): ${url}`,
    );
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function main() {
  const args = parseCliArgs();

  let credential;
  let request;
  try {
    const config = readOpenclawConfig(process.env.OPENCLAW_STATE_DIR);
    credential = resolveLinkCredential(
      config,
      process.env.OPENCLAW_STATE_DIR,
      args.model,
    );
    request = buildImageGenerationRequest({
      baseUrl: credential.baseUrl,
      model: credential.model,
      prompt: args.prompt,
      size: args.size,
      ratio: args.ratio,
      quality: args.quality,
      transparentBackground: args.transparentBackground,
    });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  console.log(
    `Generating image with model=${credential.model} size=${request.body.size}...`,
  );

  const res = await fetch(request.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request.body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Error from tabby-image gateway (${res.status}): ${text}`);
    process.exit(1);
  }

  let image;
  try {
    const body = await res.json();
    image = parseImageResponse(body);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const imageBytes =
    image.kind === "b64"
      ? Buffer.from(image.data, "base64")
      : await downloadImage(image.data);

  const stateDir =
    process.env.OPENCLAW_STATE_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || "~", ".openclaw");
  const outputPath = resolveOutputPath({
    stateDir,
    cwd: process.cwd(),
    filename: args.filename,
    skillName: SKILL_NAME,
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, imageBytes);

  const stat = fs.statSync(outputPath);
  console.log(`Image saved: ${outputPath} (${Math.round(stat.size / 1024)}KB)`);
  console.log(`MEDIA: ${outputPath}`);
}

// Without this, a transport-level throw (e.g. TypeError: fetch failed) becomes an
// unhandled top-level rejection and Node dumps a stack trace to stderr, which the
// controller then surfaces verbatim as the failure reason.
try {
  await main();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
