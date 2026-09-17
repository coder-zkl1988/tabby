import type { GenerateImageRequest, GenerateImageResponse } from "@nexu/shared";
import {
  getApiV1MediaImageJobsByJobId,
  postApiV1MediaImageJobs,
} from "../../../lib/api/sdk.gen";

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export async function generateImageViaJob(
  input: GenerateImageRequest,
  options?: {
    signal?: AbortSignal;
    pollIntervalMs?: number;
  },
): Promise<GenerateImageResponse> {
  throwIfAborted(options?.signal);
  const jobId = await submitImageGenerationJob(input);
  return waitForImageGenerationJob(jobId, options);
}

/**
 * Submit the job and return its id without waiting.
 *
 * The canvas persists that id on the node, so a reload can resume the poll
 * rather than losing a run that is still going on the controller.
 */
export async function submitImageGenerationJob(
  input: GenerateImageRequest,
): Promise<string> {
  const { data, error } = await postApiV1MediaImageJobs({ body: input });
  if (!data || error) {
    throw new Error(readJobError(error, "图片生成任务提交失败"));
  }
  return data.jobId;
}

export async function waitForImageGenerationJob(
  jobId: string,
  options?: {
    signal?: AbortSignal;
    pollIntervalMs?: number;
  },
): Promise<GenerateImageResponse> {
  const pollIntervalMs = Math.max(
    0,
    options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );

  while (true) {
    throwIfAborted(options?.signal);
    const { data, error } = await getApiV1MediaImageJobsByJobId({
      path: { jobId },
    });
    if (!data || error) {
      throw new Error(readJobError(error, "无法查询图片生成状态"));
    }

    if (data.status === "succeeded") {
      if (!data.result) throw new Error("图片生成任务未返回结果");
      return data.result;
    }
    if (data.status === "failed") {
      throw new Error(data.error || "图片生成失败，请重试");
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }
}

function readJobError(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim() !== ""
  ) {
    return error.message.trim().slice(0, 240);
  }
  return fallback;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("图片生成已取消");
}
