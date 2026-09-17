import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  XhsOpsPlanSuggestion,
  XhsOpsRun,
  XhsOpsRunCreate,
} from "@nexu/shared";
import { afterAll, describe, expect, it } from "vitest";
import { XhsOpsError } from "../src/services/xhs-ops-run-service.js";
import {
  XhsOpsScheduler,
  isScheduleDue,
  localClock,
} from "../src/services/xhs-ops-scheduler.js";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";

const tempDir = mkdtempSync(join(tmpdir(), "xhs-ops-scheduler-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

// 2026-09-05 10:00 local
const AT_TEN = new Date(2026, 8, 5, 10, 0).getTime();
const AT_NINE = new Date(2026, 8, 5, 9, 59).getTime();

function suggestion(
  accountId: string,
  label: string,
  segment: XhsOpsPlanSuggestion["segment"] = null,
  keywords = [{ keyword: "亲子酒店", count: 3 }],
): XhsOpsPlanSuggestion {
  return {
    accountId,
    accountLabel: label,
    keywords,
    homeFeedCount: 2,
    dwellSecMin: 10,
    dwellSecMax: 20,
    interaction: {
      like: { enabled: false, dailyCap: 0, ratioPercent: 0 },
      collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
      follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
      comment: { enabled: false },
    },
    rationale: [],
    segment,
  };
}

function fakeRunService(plans: XhsOpsPlanSuggestion[]) {
  const created: XhsOpsRunCreate[] = [];
  const started: string[] = [];
  let n = 0;
  const service = {
    suggestPlans: async () => plans,
    createRun: async (
      input: XhsOpsRunCreate,
      options?: { onCreated?: () => void },
    ) => {
      created.push(input);
      n += 1;
      options?.onCreated?.();
      return {
        id: `run-${n}`,
        status: "planned",
        deviceId: "dev-1",
      } as XhsOpsRun;
    },
    startRun: async (runId: string) => {
      started.push(runId);
      // 第一个直接跑，之后的视作被设备队列排队（planned + queuedBehindRunId）
      const first = started.length === 1;
      return {
        id: runId,
        status: first ? "running" : "planned",
        queuedBehindRunId: first ? null : started[0],
      } as XhsOpsRun;
    },
  };
  return { service, created, started };
}

describe("XhsOpsScheduler (P2-4 每日自动执行)", () => {
  it("isScheduleDue: enabled + time reached + not fired today", () => {
    const base = {
      schedule: {
        enabled: true,
        time: "10:00",
        lastTriggeredDate: null,
        lastResult: null,
      },
    } as never;
    expect(localClock(new Date(AT_TEN))).toBe("10:00");
    expect(isScheduleDue(base, new Date(AT_TEN))).toBe(true);
    expect(isScheduleDue(base, new Date(AT_NINE))).toBe(false);
    expect(
      isScheduleDue(
        {
          schedule: {
            enabled: true,
            time: "10:00",
            lastTriggeredDate: "2026-09-05",
            lastResult: null,
          },
        } as never,
        new Date(AT_TEN),
      ),
    ).toBe(false);
    expect(
      isScheduleDue(
        {
          schedule: {
            enabled: false,
            time: "10:00",
            lastTriggeredDate: null,
            lastResult: null,
          },
        } as never,
        new Date(AT_TEN),
      ),
    ).toBe(false);
  });

  it("tick fires due projects once per day, creating and starting one run per suggestion", async () => {
    const store = new XhsOpsStore(join(tempDir, "a.json"));
    const project = await store.createProject({
      name: "定时项目",
      schedule: {
        enabled: true,
        time: "10:00",
        lastTriggeredDate: null,
        lastResult: null,
      },
    });
    await store.createProject({ name: "未启用" }); // default schedule: disabled
    const emptyPlan = suggestion("c", "空池", null, []);
    emptyPlan.homeFeedCount = 0;
    const { service, created, started } = fakeRunService([
      suggestion("a", "豆豆妈", { index: 1, count: 2 }),
      suggestion("a", "豆豆妈", { index: 2, count: 2 }),
      suggestion("b", "桃子爸"),
      emptyPlan,
    ]);
    let now = AT_NINE;
    const scheduler = new XhsOpsScheduler({
      store,
      runService: service,
      now: () => now,
    });

    expect(await scheduler.tick()).toEqual([]); // 09:59 还没到
    now = AT_TEN;
    const fired = await scheduler.tick();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      projectId: project.id,
      planned: 4,
      created: 3,
      started: 1,
      queued: 2,
    });
    expect(fired[0]?.skipped[0]).toContain("空池");
    expect(created.map((c) => c.segment)).toEqual([
      { index: 1, count: 2 },
      { index: 2, count: 2 },
      null,
    ]);
    expect(created.every((input) => input.reuseActive === true)).toBe(true);
    expect(created[0]?.plan.homeFeedCount).toBe(0 + 2);
    expect(started).toEqual(["run-1", "run-2", "run-3"]);

    const after = await store.getProject(project.id);
    expect(after?.schedule.lastTriggeredDate).toBe("2026-09-05");
    expect(after?.schedule.lastResult).toContain(
      "1 个开始、2 个排队、1 个未派发",
    );
    expect(after?.schedule.lastResult).toContain("定时");

    // 同一天不再触发
    now = AT_TEN + 5 * 60_000;
    expect(await scheduler.tick()).toEqual([]);
    expect(created).toHaveLength(3);
  });

  it("manual trigger ignores enabled/time but still stamps the day; unknown project is 404", async () => {
    const store = new XhsOpsStore(join(tempDir, "b.json"));
    const project = await store.createProject({ name: "手动" });
    const { service, created } = fakeRunService([suggestion("a", "豆豆妈")]);
    const scheduler = new XhsOpsScheduler({
      store,
      runService: service,
      now: () => AT_NINE,
    });
    const result = await scheduler.triggerProject(project.id);
    expect(result).toMatchObject({ created: 1, started: 1, queued: 0 });
    expect(created).toHaveLength(1);
    const after = await store.getProject(project.id);
    expect(after?.schedule.enabled).toBe(false);
    expect(after?.schedule.lastTriggeredDate).toBe("2026-09-05");
    expect(after?.schedule.lastResult).toContain("手动");
    await expect(scheduler.triggerProject("nope")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("resumes a persisted unqueued planned run without recreating completed dispatches", async () => {
    const store = new XhsOpsStore(join(tempDir, "resume.json"));
    const project = await store.createProject({
      name: "可恢复定时",
      schedule: {
        enabled: true,
        time: "10:00",
        lastTriggeredDate: null,
        lastResult: null,
      },
    });
    const plans = [
      suggestion("a", "豆豆妈", { index: 1, count: 2 }),
      suggestion("a", "豆豆妈", { index: 2, count: 2 }),
    ];
    const createdInputs: XhsOpsRunCreate[] = [];
    const startAttempts: string[] = [];
    let failSecondStart = true;
    const service = {
      suggestPlans: async () => plans,
      createRun: async (
        input: XhsOpsRunCreate,
        options?: { onCreated?: () => void },
      ) => {
        createdInputs.push(input);
        return store.createRun(
          {
            projectId: input.projectId,
            accountId: input.accountId,
            deviceId: "dev-1",
            accountLabel: "豆豆妈",
            date: input.date ?? "2026-09-05",
            status: "planned",
            plan: input.plan,
            segment: input.segment ?? null,
            queuedBehindRunId: null,
            chunks: [],
            summary: {
              plannedTotal: 0,
              browsedTotal: 0,
              searchBrowsed: 0,
              homeBrowsed: 0,
              interactions: { like: 0, collect: 0, follow: 0, comment: 0 },
              anomalyCount: 0,
              durationMs: null,
            },
            notes: "",
            error: null,
            startedAt: null,
            completedAt: null,
          },
          { onCreated: options?.onCreated },
        );
      },
      startRun: async (runId: string) => {
        startAttempts.push(runId);
        const run = await store.getRun(runId);
        if (run?.segment?.index === 2 && failSecondStart) {
          failSecondStart = false;
          throw new Error("simulated restart window");
        }
        const started = await store.updateRun(runId, (current) => ({
          ...current,
          status: "running",
        }));
        if (!started) throw new Error("missing run");
        return started;
      },
    };
    const firstScheduler = new XhsOpsScheduler({
      store,
      runService: service,
      now: () => AT_TEN,
    });

    const first = await firstScheduler.triggerProject(project.id, {
      reason: "schedule",
    });
    expect(first).toMatchObject({ created: 2, started: 1 });
    expect(first.skipped).toHaveLength(1);
    expect(
      (await store.getProject(project.id))?.schedule.lastTriggeredDate,
    ).toBeNull();

    const restartedScheduler = new XhsOpsScheduler({
      store,
      runService: service,
      now: () => AT_TEN + 60_000,
    });
    const resumed = await restartedScheduler.triggerProject(project.id, {
      reason: "schedule",
    });

    expect(resumed).toMatchObject({ created: 0, started: 1, queued: 0 });
    expect(resumed.skipped).toEqual([]);
    expect(createdInputs).toHaveLength(2);
    expect(startAttempts).toHaveLength(3);
    expect(
      (await store.getProject(project.id))?.schedule.lastTriggeredDate,
    ).toBe("2026-09-05");
  });

  it("accepts a start conflict when the run became active concurrently", async () => {
    const store = new XhsOpsStore(join(tempDir, "start-race.json"));
    const project = await store.createProject({ name: "启动竞态" });
    const plan = suggestion("account-a", "豆豆妈");
    const persisted = await store.createRun({
      projectId: project.id,
      accountId: plan.accountId,
      deviceId: "dev-1",
      accountLabel: plan.accountLabel,
      date: "2026-09-05",
      status: "planned",
      plan: {
        keywords: plan.keywords,
        homeFeedCount: plan.homeFeedCount,
        dwellSecMin: plan.dwellSecMin,
        dwellSecMax: plan.dwellSecMax,
        interaction: plan.interaction,
      },
      segment: null,
      queuedBehindRunId: null,
      chunks: [],
      summary: {
        plannedTotal: 0,
        browsedTotal: 0,
        searchBrowsed: 0,
        homeBrowsed: 0,
        interactions: { like: 0, collect: 0, follow: 0, comment: 0 },
        anomalyCount: 0,
        durationMs: null,
      },
      notes: "",
      error: null,
      startedAt: null,
      completedAt: null,
    });
    const scheduler = new XhsOpsScheduler({
      store,
      runService: {
        suggestPlans: async () => [plan],
        createRun: async () => {
          throw new Error("must not create");
        },
        startRun: async (runId) => {
          await store.updateRun(runId, (run) => ({
            ...run,
            status: "running",
          }));
          throw new XhsOpsError(409, "运行已在进行中");
        },
      },
      now: () => AT_TEN,
    });

    const result = await scheduler.triggerProject(project.id, {
      reason: "schedule",
    });
    expect(result).toMatchObject({ started: 1, queued: 0, skipped: [] });
    expect((await store.getRun(persisted.id))?.status).toBe("running");
  });

  it("does not start again when atomic creation reuses a running dispatch", async () => {
    const store = new XhsOpsStore(join(tempDir, "create-race.json"));
    const project = await store.createProject({ name: "建单竞态" });
    const plan = suggestion("account-a", "豆豆妈");
    let startAttempts = 0;
    const scheduler = new XhsOpsScheduler({
      store,
      runService: {
        suggestPlans: async () => [plan],
        createRun: async (input) =>
          ({
            id: "reused-running",
            projectId: project.id,
            accountId: input.accountId,
            segment: input.segment ?? null,
            status: "running",
          }) as XhsOpsRun,
        startRun: async () => {
          startAttempts += 1;
          throw new Error("must not start");
        },
      },
      now: () => AT_TEN,
    });

    const result = await scheduler.triggerProject(project.id, {
      reason: "schedule",
    });
    expect(result).toMatchObject({
      created: 0,
      started: 1,
      queued: 0,
      skipped: [],
    });
    expect(startAttempts).toBe(0);
  });

  it("does not automatically resend running or terminal runs with the same daily dispatch key", async () => {
    const store = new XhsOpsStore(join(tempDir, "terminal.json"));
    const project = await store.createProject({ name: "终态去重" });
    const statuses = [
      "running",
      "completed",
      "failed",
      "interrupted",
      "cancelled",
    ] as const;
    const plans = statuses.map((status, index) =>
      suggestion(`account-${index}`, status),
    );
    for (const [index, status] of statuses.entries()) {
      const plan = plans[index];
      if (!plan) continue;
      const seed = {
        projectId: project.id,
        accountId: plan.accountId,
        deviceId: `dev-${index}`,
        accountLabel: plan.accountLabel,
        date: "2026-09-05",
        status,
        plan: {
          keywords: plan.keywords,
          homeFeedCount: plan.homeFeedCount,
          dwellSecMin: plan.dwellSecMin,
          dwellSecMax: plan.dwellSecMax,
          interaction: plan.interaction,
        },
        segment: null,
        queuedBehindRunId: null,
        chunks: [],
        summary: {
          plannedTotal: 0,
          browsedTotal: 0,
          searchBrowsed: 0,
          homeBrowsed: 0,
          interactions: { like: 0, collect: 0, follow: 0, comment: 0 },
          anomalyCount: 0,
          durationMs: null,
        },
        notes: "",
        error: null,
        startedAt: null,
        completedAt: null,
      };
      if (index === 0) {
        await store.createRun({ ...seed, status: "planned" });
      }
      await store.createRun({ ...seed, status });
    }
    const created: XhsOpsRunCreate[] = [];
    const started: string[] = [];
    const scheduler = new XhsOpsScheduler({
      store,
      runService: {
        suggestPlans: async () => plans,
        createRun: async (input) => {
          created.push(input);
          throw new Error("must not create");
        },
        startRun: async (runId) => {
          started.push(runId);
          throw new Error("must not start");
        },
      },
      now: () => AT_TEN,
    });

    const result = await scheduler.triggerProject(project.id, {
      reason: "schedule",
    });

    expect(result).toMatchObject({ created: 0, started: 0, queued: 0 });
    expect(result.skipped).toEqual([]);
    expect(created).toEqual([]);
    expect(started).toEqual([]);
    expect(
      (await store.getProject(project.id))?.schedule.lastTriggeredDate,
    ).toBe("2026-09-05");
  });

  it("resumes multiple persisted planned runs in segment order", async () => {
    const store = new XhsOpsStore(join(tempDir, "segment-order.json"));
    const project = await store.createProject({ name: "分段顺序" });
    for (const segmentIndex of [1, 2]) {
      const plan = suggestion("account-a", "豆豆妈", {
        index: segmentIndex,
        count: 2,
      });
      await store.createRun({
        projectId: project.id,
        accountId: plan.accountId,
        deviceId: "dev-1",
        accountLabel: plan.accountLabel,
        date: "2026-09-05",
        status: "planned",
        plan: {
          keywords: plan.keywords,
          homeFeedCount: plan.homeFeedCount,
          dwellSecMin: plan.dwellSecMin,
          dwellSecMax: plan.dwellSecMax,
          interaction: plan.interaction,
        },
        segment: plan.segment,
        queuedBehindRunId: null,
        chunks: [],
        summary: {
          plannedTotal: 0,
          browsedTotal: 0,
          searchBrowsed: 0,
          homeBrowsed: 0,
          interactions: { like: 0, collect: 0, follow: 0, comment: 0 },
          anomalyCount: 0,
          durationMs: null,
        },
        notes: "",
        error: null,
        startedAt: null,
        completedAt: null,
      });
    }
    const startedSegments: number[] = [];
    const scheduler = new XhsOpsScheduler({
      store,
      runService: {
        suggestPlans: async () => [],
        createRun: async () => {
          throw new Error("must not create");
        },
        startRun: async (runId) => {
          const run = await store.getRun(runId);
          if (!run) throw new Error("missing run");
          startedSegments.push(run.segment?.index ?? 0);
          return { ...run, status: "running" };
        },
      },
      now: () => AT_TEN,
    });

    await scheduler.triggerProject(project.id, { reason: "schedule" });

    expect(startedSegments).toEqual([1, 2]);
  });

  it("retries a persisted planned run rejected with 409 unless it becomes active or queued", async () => {
    const store = new XhsOpsStore(join(tempDir, "rejected-planned.json"));
    const project = await store.createProject({
      name: "安全拒绝",
      schedule: {
        enabled: true,
        time: "10:00",
        lastTriggeredDate: null,
        lastResult: null,
      },
    });
    const plan = suggestion("account-a", "豆豆妈", { index: 1, count: 2 });
    const blockedNextPlan = suggestion("account-a", "豆豆妈", {
      index: 2,
      count: 2,
    });
    await store.createRun({
      projectId: project.id,
      accountId: plan.accountId,
      deviceId: "dev-1",
      accountLabel: plan.accountLabel,
      date: "2026-09-05",
      status: "planned",
      plan: {
        keywords: plan.keywords,
        homeFeedCount: plan.homeFeedCount,
        dwellSecMin: plan.dwellSecMin,
        dwellSecMax: plan.dwellSecMax,
        interaction: plan.interaction,
      },
      segment: null,
      queuedBehindRunId: null,
      chunks: [],
      summary: {
        plannedTotal: 0,
        browsedTotal: 0,
        searchBrowsed: 0,
        homeBrowsed: 0,
        interactions: { like: 0, collect: 0, follow: 0, comment: 0 },
        anomalyCount: 0,
        durationMs: null,
      },
      notes: "",
      error: null,
      startedAt: null,
      completedAt: null,
    });
    let startAttempts = 0;
    const scheduler = new XhsOpsScheduler({
      store,
      runService: {
        suggestPlans: async () => [blockedNextPlan],
        createRun: async () => {
          throw new Error("must not create");
        },
        startRun: async () => {
          startAttempts += 1;
          throw new XhsOpsError(409, "前一分段尚未成功完成");
        },
      },
      now: () => AT_TEN,
    });

    const first = await scheduler.tick();
    const second = await scheduler.tick();

    expect(first).toHaveLength(1);
    expect(first[0]?.skipped[0]).toContain("前一分段尚未成功完成");
    expect(second).toHaveLength(1);
    expect(startAttempts).toBe(2);
    expect(
      (await store.getProject(project.id))?.schedule.lastTriggeredDate,
    ).toBeNull();
  });
});
