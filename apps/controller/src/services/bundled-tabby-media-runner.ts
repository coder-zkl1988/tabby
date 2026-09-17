import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

export type TabbyImageGenerationInput = {
  botId: string;
  prompt: string;
  count: number;
  model?: string;
  quality?: "auto" | "high" | "medium" | "low";
  aspectRatio?: string;
  size?: string;
  transparentBackground?: boolean;
  timeoutMs: number;
};

export type TabbyVideoGenerationInput = {
  botId: string;
  prompt: string;
  model?: string;
  durationSeconds?: number;
  resolution?: "480p" | "720p" | "1080p";
  aspectRatio?: string;
  numFrames?: number;
  frameRate?: number;
  numInferenceSteps?: number;
  negativePrompt?: string;
  seed?: number;
  timeoutMs: number;
};

export type TabbyMediaRunner = {
  generateImage(input: TabbyImageGenerationInput): Promise<string[]>;
  generateVideo(input: TabbyVideoGenerationInput): Promise<string>;
};

export type RunTrustedScript = (input: {
  scriptPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}) => Promise<void>;

const TABBY_IMAGE_MAX_ATTEMPTS = 2;
const TABBY_IMAGE_RETRY_DELAY_MS = 1_500;
const TABBY_IMAGE_RETRYABLE_GATEWAY_STATUS =
  /tabby-image gateway \((502|503|504|52[0-7])\)/i;

export function isRetryableTabbyImageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    TABBY_IMAGE_RETRYABLE_GATEWAY_STATUS.test(message) ||
    /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED)\b/i.test(message) ||
    /\bfetch failed\b/i.test(message)
  );
}

export function readableTabbyImageError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(TABBY_IMAGE_RETRYABLE_GATEWAY_STATUS)?.[1];
  if (status === "504" || status === "522" || status === "524") {
    return new Error("tabby-image 中转站响应超时，已自动重试，请稍后再试");
  }
  if (status !== undefined) {
    return new Error("tabby-image 中转站暂时不可用，已自动重试，请稍后再试");
  }
  if (
    /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED)\b/i.test(message) ||
    /\bfetch failed\b/i.test(message)
  ) {
    return new Error("tabby-image 网络连接失败，已自动重试，请稍后再试");
  }
  return error instanceof Error ? error : new Error(message);
}

const defaultRunTrustedScript: RunTrustedScript = async (input) => {
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [input.scriptPath, ...input.args],
      {
        cwd: input.cwd,
        env: input.env,
        maxBuffer: 1024 * 1024,
        timeout: input.timeoutMs,
      },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = stderr.trim();
          reject(
            new Error(
              detail.length > 0
                ? detail.slice(0, 2_000)
                : "bundled media skill exited unsuccessfully",
            ),
          );
          return;
        }
        resolve();
      },
    );
  });
};

function pushOptionalArg(
  args: string[],
  flag: string,
  value: string | number | undefined,
): void {
  if (value !== undefined && value !== "") {
    args.push(flag, String(value));
  }
}

export function buildImageSkillArgs(input: {
  prompt: string;
  filename: string;
  model?: string;
  quality?: "auto" | "high" | "medium" | "low";
  aspectRatio?: string;
  size?: string;
  transparentBackground?: boolean;
}): string[] {
  const args = ["--prompt", input.prompt, "--filename", input.filename];
  pushOptionalArg(args, "--model", input.model);
  pushOptionalArg(args, "--quality", input.quality);
  pushOptionalArg(args, "--ratio", input.aspectRatio);
  pushOptionalArg(args, "--size", input.size);
  if (input.transparentBackground) {
    args.push("--transparent-background");
  }
  return args;
}

export function buildVideoSkillArgs(input: {
  prompt: string;
  filename: string;
  model?: string;
  durationSeconds?: number;
  resolution?: "480p" | "720p" | "1080p";
  aspectRatio?: string;
  numFrames?: number;
  frameRate?: number;
  numInferenceSteps?: number;
  negativePrompt?: string;
  seed?: number;
  timeoutMs: number;
}): string[] {
  const args = ["--prompt", input.prompt, "--filename", input.filename];
  pushOptionalArg(args, "--model", input.model);
  pushOptionalArg(args, "--duration-seconds", input.durationSeconds);
  pushOptionalArg(args, "--resolution", input.resolution);
  pushOptionalArg(args, "--aspect-ratio", input.aspectRatio);
  pushOptionalArg(args, "--num-frames", input.numFrames);
  pushOptionalArg(args, "--frame-rate", input.frameRate);
  pushOptionalArg(args, "--num-inference-steps", input.numInferenceSteps);
  pushOptionalArg(args, "--negative-prompt", input.negativePrompt);
  pushOptionalArg(args, "--seed", input.seed);
  args.push("--timeout-ms", String(input.timeoutMs));
  return args;
}

export class BundledTabbyMediaRunner implements TabbyMediaRunner {
  constructor(
    private readonly options: {
      staticSkillsDir: string;
      openclawStateDir: string;
      genId: () => string;
      runTrustedScript?: RunTrustedScript;
      imageRetryDelayMs?: number;
    },
  ) {}

  async generateImage(input: TabbyImageGenerationInput): Promise<string[]> {
    const paths: string[] = [];
    let lastError: unknown;
    for (let index = 0; index < input.count; index += 1) {
      const filename = this.outputPath(
        input.botId,
        "tabby-image",
        `${this.options.genId()}.png`,
      );
      const args = buildImageSkillArgs({
        prompt: input.prompt,
        filename,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.quality !== undefined ? { quality: input.quality } : {}),
        ...(input.aspectRatio !== undefined
          ? { aspectRatio: input.aspectRatio }
          : {}),
        ...(input.size !== undefined ? { size: input.size } : {}),
        ...(input.transparentBackground !== undefined
          ? { transparentBackground: input.transparentBackground }
          : {}),
      });
      try {
        await this.runImageWithRetry(args, input.timeoutMs);
        await access(filename);
        paths.push(filename);
      } catch (error) {
        // Return the images already produced instead of discarding them: a
        // flaky relay makes every extra image an independent coin flip, and
        // each failure costs both retries' worth of wall time. Callers persist
        // what came back and top up the remainder on the next run.
        lastError = error;
        break;
      }
    }
    if (paths.length === 0) {
      throw lastError;
    }
    return paths;
  }

  async generateVideo(input: TabbyVideoGenerationInput): Promise<string> {
    const filename = this.outputPath(
      input.botId,
      "tabby-video",
      `${this.options.genId()}.mp4`,
    );
    await this.run(
      "tabby-video",
      "generate-video.js",
      buildVideoSkillArgs({
        prompt: input.prompt,
        filename,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.durationSeconds !== undefined
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
        timeoutMs: input.timeoutMs,
      }),
      input.timeoutMs + 5_000,
    );
    await access(filename);
    return filename;
  }

  private outputPath(
    botId: string,
    skillName: "tabby-image" | "tabby-video",
    filename: string,
  ): string {
    return path.join(
      this.options.openclawStateDir,
      "media",
      "outbound",
      path.basename(botId),
      skillName,
      filename,
    );
  }

  private async run(
    skillName: "tabby-image" | "tabby-video",
    scriptName: string,
    args: string[],
    timeoutMs: number,
  ): Promise<void> {
    const scriptPath = path.join(
      this.options.staticSkillsDir,
      skillName,
      "scripts",
      scriptName,
    );
    await access(scriptPath);
    const filenameIndex = args.indexOf("--filename");
    const outputPath =
      filenameIndex >= 0
        ? args[filenameIndex + 1]
        : this.options.openclawStateDir;
    await mkdir(path.dirname(outputPath ?? this.options.openclawStateDir), {
      recursive: true,
    });
    await (this.options.runTrustedScript ?? defaultRunTrustedScript)({
      scriptPath,
      args,
      cwd: this.options.openclawStateDir,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: this.options.openclawStateDir,
      },
      timeoutMs,
    });
  }

  private async runImageWithRetry(
    args: string[],
    timeoutMs: number,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= TABBY_IMAGE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.run("tabby-image", "generate-image.js", args, timeoutMs);
        return;
      } catch (error) {
        lastError = error;
        if (
          attempt === TABBY_IMAGE_MAX_ATTEMPTS ||
          !isRetryableTabbyImageError(error)
        ) {
          throw readableTabbyImageError(error);
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            this.options.imageRetryDelayMs ?? TABBY_IMAGE_RETRY_DELAY_MS,
          ),
        );
      }
    }
    throw readableTabbyImageError(lastError);
  }
}
