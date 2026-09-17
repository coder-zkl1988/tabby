import type { GenerateImageResponse } from "@nexu/shared";
import { describe, expect, it, vi } from "vitest";
import {
  MediaGenerationJobService,
  MediaGenerationQueueFullError,
} from "../src/services/media-generation-job-service.js";
import { ImageGenerationFailedError } from "../src/services/media-generation-service.js";

const firstResult: GenerateImageResponse = {
  path: "/state/media/first.png",
  url: "/api/v1/media/state-file?path=first.png",
  items: [
    {
      path: "/state/media/first.png",
      url: "/api/v1/media/state-file?path=first.png",
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("MediaGenerationJobService", () => {
  it("runs submitted jobs serially and exposes terminal results", async () => {
    const first = deferred<GenerateImageResponse>();
    const second = deferred<GenerateImageResponse>();
    const generateImage = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const service = new MediaGenerationJobService({
      label: "图片生成",
      run: generateImage,
      genId: () => ids.shift() ?? "33333333-3333-4333-8333-333333333333",
    });

    const firstJob = service.submit({ prompt: "first" });
    const secondJob = service.submit({ prompt: "second" });

    await vi.waitFor(() => {
      expect(service.get(firstJob.jobId)?.status).toBe("running");
    });
    expect(service.get(secondJob.jobId)?.status).toBe("queued");
    expect(generateImage).toHaveBeenCalledTimes(1);

    first.resolve(firstResult);
    await vi.waitFor(() => {
      expect(service.get(firstJob.jobId)?.status).toBe("succeeded");
      expect(service.get(secondJob.jobId)?.status).toBe("running");
    });
    expect(service.get(firstJob.jobId)?.result).toEqual(firstResult);
    expect(generateImage).toHaveBeenCalledTimes(2);

    second.resolve(firstResult);
    await vi.waitFor(() => {
      expect(service.get(secondJob.jobId)?.status).toBe("succeeded");
    });
  });

  it("stores a safe user-facing failure instead of rejecting the queue", async () => {
    const service = new MediaGenerationJobService({
      label: "图片生成",
      run: async () => {
        throw new ImageGenerationFailedError("图像服务响应超时，请稍后重试");
      },
      genId: () => "44444444-4444-4444-8444-444444444444",
    });

    const job = service.submit({ prompt: "slow image" });
    await vi.waitFor(() => {
      expect(service.get(job.jobId)?.status).toBe("failed");
    });
    expect(service.get(job.jobId)?.error).toBe("图像服务响应超时，请稍后重试");
  });

  it("bounds queued and running work", () => {
    const pending = deferred<GenerateImageResponse>();
    const service = new MediaGenerationJobService({
      label: "图片生成",
      run: () => pending.promise,
      genId: () => "55555555-5555-4555-8555-555555555555",
      maxActiveJobs: 1,
    });

    service.submit({ prompt: "first" });
    expect(() => service.submit({ prompt: "second" })).toThrow(
      MediaGenerationQueueFullError,
    );
    pending.resolve(firstResult);
  });
});
