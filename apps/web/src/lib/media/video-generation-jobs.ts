import type { GenerateVideoRequest, GenerateVideoResponse } from "@nexu/shared";
import {
  getApiV1MediaVideoJobsByJobId,
  postApiV1MediaVideoJobs,
} from "../../../lib/api/sdk.gen";

/** Video runs for minutes; a 1s poll would be pure noise. */
const DEFAULT_POLL_INTERVAL_MS = 3_000;

/** Thrown when the controller no longer knows the job (restart, or TTL). */
export class VideoJobMissingError extends Error {
  constructor() {
    super("视频生成任务已失效，请重新生成");
    this.name = "VideoJobMissingError";
  }
}

/**
 * Submit a video generation job and return its id without waiting.
 *
 * The canvas persists the id on the node so a page reload resumes the poll
 * instead of orphaning a run that is still going on the controller.
 */
export async function submitVideoGenerationJob(
  input: GenerateVideoRequest,
): Promise<string> {
  const { data, error } = await postApiV1MediaVideoJobs({ body: input });
  if (!data || error) {
    throw new Error(readJobError(error, "视频生成任务提交失败"));
  }
  return data.jobId;
}

export async function waitForVideoGenerationJob(
  jobId: string,
  options?: { signal?: AbortSignal; pollIntervalMs?: number },
): Promise<GenerateVideoResponse> {
  const pollIntervalMs = Math.max(
    0,
    options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );

  while (true) {
    throwIfAborted(options?.signal);
    const { data, error, response } = await getApiV1MediaVideoJobsByJobId({
      path: { jobId },
    });
    if (response?.status === 404) {
      throw new VideoJobMissingError();
    }
    if (!data || error) {
      throw new Error(readJobError(error, "无法查询视频生成状态"));
    }

    if (data.status === "succeeded") {
      if (!data.result) throw new Error("视频生成任务未返回结果");
      return data.result;
    }
    if (data.status === "failed") {
      throw new Error(data.error || "视频生成失败，请重试");
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
  if (signal?.aborted) throw new Error("视频生成已取消");
}
