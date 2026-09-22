import type { ScheduleResponse } from "@nexu/shared";
import { describe, expect, it, vi } from "vitest";
import type { SessionsRuntime } from "../src/runtime/sessions-runtime.js";
import type {
  CronRunsResponse,
  OpenClawCronGateway,
} from "../src/services/openclaw-cron-gateway.js";
import type { OpenClawSyncService } from "../src/services/openclaw-sync-service.js";
import { ScheduleService } from "../src/services/schedule-service.js";
import type { NexuConfigStore } from "../src/store/nexu-config-store.js";

function scheduleFixture(): ScheduleResponse {
  return {
    id: "schedule-1",
    botId: "bot-1",
    name: "Daily report",
    cron: "0 9 * * *",
    timezone: "Asia/Shanghai",
    prompt: "Summarize the project",
    enabled: true,
    source: "ui",
    onlyNotifyOnChange: false,
    failureAlertEnabled: false,
    failureAlertAfter: 3,
    externalId: "job-1",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
}

function runsFixture(sessionKey?: string): CronRunsResponse {
  return {
    entries: [
      {
        ts: 1000,
        jobId: "job-1",
        action: "finished",
        status: "ok",
        summary: "done",
        runAtMs: 1000,
        ...(sessionKey ? { sessionKey } : {}),
      },
    ],
    total: 1,
    offset: 0,
    limit: 20,
    hasMore: false,
    nextOffset: null,
  };
}

function buildService(options: {
  schedule?: ScheduleResponse | null;
  runs?: CronRunsResponse;
  transcript?: unknown;
}) {
  const getRunTranscriptMessages = vi.fn(async () => options.transcript);
  const service = new ScheduleService(
    {
      getConfig: vi.fn(async () => ({
        schedules: options.schedule === undefined ? [scheduleFixture()] : [],
        bots: [],
      })),
    } as unknown as NexuConfigStore,
    {
      onEvent: vi.fn(() => () => undefined),
      getRuns: vi.fn(async () => options.runs ?? runsFixture()),
    } as unknown as OpenClawCronGateway,
    { syncAll: vi.fn() } as unknown as OpenClawSyncService,
    { getRunTranscriptMessages } as unknown as SessionsRuntime,
  );
  return { service, getRunTranscriptMessages };
}

describe("ScheduleService.getRunTranscript", () => {
  it("returns the run transcript for a matching isolated run key", async () => {
    const messages = [
      {
        id: "m1",
        role: "user" as const,
        content: "check messages",
        timestamp: null,
        createdAt: null,
      },
    ];
    const { service, getRunTranscriptMessages } = buildService({
      runs: runsFixture("agent:bot-1:cron:job-1:run:abc-123"),
      transcript: messages,
    });

    const result = await service.getRunTranscript("schedule-1", 1000);
    expect(getRunTranscriptMessages).toHaveBeenCalledWith(
      "bot-1",
      "abc-123",
      undefined,
      "agent:bot-1:cron:job-1:run:abc-123",
    );
    expect(result).toEqual({
      messages,
      sessionKey: "agent:bot-1:cron:job-1:run:abc-123",
    });
  });

  it("returns null when the run has no session key (legacy gateway)", async () => {
    const { service, getRunTranscriptMessages } = buildService({
      runs: runsFixture(),
    });

    expect(await service.getRunTranscript("schedule-1", 1000)).toBeNull();
    expect(getRunTranscriptMessages).not.toHaveBeenCalled();
  });

  it("returns null when the session key names another bot", async () => {
    const { service, getRunTranscriptMessages } = buildService({
      runs: runsFixture("agent:other-bot:cron:job-1:run:abc-123"),
    });

    expect(await service.getRunTranscript("schedule-1", 1000)).toBeNull();
    expect(getRunTranscriptMessages).not.toHaveBeenCalled();
  });

  it("returns null when the session key is malformed", async () => {
    const { service, getRunTranscriptMessages } = buildService({
      runs: runsFixture("agent:bot-1:schedule-schedule-1"),
    });

    expect(await service.getRunTranscript("schedule-1", 1000)).toBeNull();
    expect(getRunTranscriptMessages).not.toHaveBeenCalled();
  });

  it("returns null when the transcript is archived or missing", async () => {
    const { service } = buildService({
      runs: runsFixture("agent:bot-1:cron:job-1:run:abc-123"),
      transcript: null,
    });

    expect(await service.getRunTranscript("schedule-1", 1000)).toBeNull();
  });

  it("returns null when the run ts is unknown", async () => {
    const { service } = buildService({
      runs: runsFixture("agent:bot-1:cron:job-1:run:abc-123"),
    });

    expect(await service.getRunTranscript("schedule-1", 9999)).toBeNull();
  });
});
