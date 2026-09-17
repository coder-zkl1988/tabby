import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger.js";
import {
  ImageGenerationFailedError,
  InvalidMediaReferenceError,
} from "./media-generation-service.js";

const DEFAULT_MAX_ACTIVE_JOBS = 8;
const DEFAULT_TERMINAL_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_RETAINED_JOBS = 100;

/**
 * Shape every media result shares — enough for the service to hand callers a
 * defensive copy without knowing whether it holds images or videos.
 */
type MediaJobResult = { items: ReadonlyArray<{ path: string; url: string }> };

/** Job record, generic over the result payload. */
type JobRecord<TResult> = {
  jobId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: TResult;
  error?: string;
};

type QueuedJob<TInput> = {
  jobId: string;
  input: TInput;
};

export class MediaGenerationQueueFullError extends Error {
  constructor(label: string) {
    super(`${label}任务较多，请稍后再试`);
    this.name = "MediaGenerationQueueFullError";
  }
}

/**
 * Controller-owned async job queue for a slow media channel.
 *
 * Generic over input/result so image and video share one queue implementation —
 * the only channel-specific pieces are the `run` callback and the `label` used
 * in logs and the queue-full message.
 */
export class MediaGenerationJobService<TInput, TResult extends MediaJobResult> {
  private readonly jobs = new Map<string, JobRecord<TResult>>();
  private readonly queue: QueuedJob<TInput>[] = [];
  private readonly run_: (input: TInput) => Promise<TResult>;
  private readonly label: string;
  private readonly genId: () => string;
  private readonly now: () => number;
  private readonly maxActiveJobs: number;
  private readonly terminalTtlMs: number;
  private readonly maxRetainedJobs: number;
  private activeJobCount = 0;
  private draining = false;

  constructor(options: {
    run: (input: TInput) => Promise<TResult>;
    /** Human label for logs and the queue-full message, e.g. "图片生成". */
    label: string;
    genId?: () => string;
    now?: () => number;
    maxActiveJobs?: number;
    terminalTtlMs?: number;
    maxRetainedJobs?: number;
  }) {
    this.run_ = options.run;
    this.label = options.label;
    this.genId = options.genId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.maxActiveJobs = options.maxActiveJobs ?? DEFAULT_MAX_ACTIVE_JOBS;
    this.terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS;
    this.maxRetainedJobs = options.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS;
  }

  submit(input: TInput): JobRecord<TResult> {
    this.pruneTerminalJobs();
    if (this.activeJobCount >= this.maxActiveJobs) {
      throw new MediaGenerationQueueFullError(this.label);
    }

    const jobId = this.genId();
    const job: JobRecord<TResult> = {
      jobId,
      status: "queued",
      createdAt: this.toIso(this.now()),
    };
    this.jobs.set(jobId, job);
    this.queue.push({ jobId, input });
    this.activeJobCount += 1;
    this.scheduleDrain();
    return this.snapshot(job);
  }

  get(jobId: string): JobRecord<TResult> | null {
    this.pruneTerminalJobs();
    const job = this.jobs.get(jobId);
    return job ? this.snapshot(job) : null;
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const queued = this.queue.shift();
        if (!queued) continue;
        await this.run(queued);
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) this.scheduleDrain();
    }
  }

  private async run(queued: QueuedJob<TInput>): Promise<void> {
    const job = this.jobs.get(queued.jobId);
    if (!job) {
      this.activeJobCount = Math.max(0, this.activeJobCount - 1);
      return;
    }

    job.status = "running";
    job.startedAt = this.toIso(this.now());
    logger.info({ jobId: job.jobId, kind: this.label }, "media job started");

    try {
      job.result = await this.run_(queued.input);
      job.status = "succeeded";
      logger.info(
        { jobId: job.jobId, kind: this.label },
        "media job succeeded",
      );
    } catch (error) {
      job.status = "failed";
      job.error = this.publicErrorMessage(error);
      if (
        !(error instanceof ImageGenerationFailedError) &&
        !(error instanceof InvalidMediaReferenceError)
      ) {
        logger.error(
          { err: error, jobId: job.jobId, kind: this.label },
          "media job failed unexpectedly",
        );
      } else {
        logger.warn(
          { jobId: job.jobId, kind: this.label, error: job.error },
          "media job failed",
        );
      }
    } finally {
      job.completedAt = this.toIso(this.now());
      this.activeJobCount = Math.max(0, this.activeJobCount - 1);
      this.pruneTerminalJobs();
    }
  }

  private publicErrorMessage(error: unknown): string {
    if (
      error instanceof ImageGenerationFailedError ||
      error instanceof InvalidMediaReferenceError
    ) {
      return error.message.slice(0, 240);
    }
    return "生成失败，请稍后重试";
  }

  private pruneTerminalJobs(): void {
    const cutoff = this.now() - this.terminalTtlMs;
    for (const [jobId, job] of this.jobs) {
      if (
        job.completedAt !== undefined &&
        Date.parse(job.completedAt) <= cutoff
      ) {
        this.jobs.delete(jobId);
      }
    }

    if (this.jobs.size <= this.maxRetainedJobs) return;
    for (const [jobId, job] of this.jobs) {
      if (job.status === "succeeded" || job.status === "failed") {
        this.jobs.delete(jobId);
        if (this.jobs.size <= this.maxRetainedJobs) break;
      }
    }
  }

  private snapshot(job: JobRecord<TResult>): JobRecord<TResult> {
    return {
      ...job,
      ...(job.result
        ? {
            result: {
              ...job.result,
              items: job.result.items.map((item) => ({ ...item })),
            },
          }
        : {}),
    };
  }

  private toIso(timestamp: number): string {
    return new Date(timestamp).toISOString();
  }
}
