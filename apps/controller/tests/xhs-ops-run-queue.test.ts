import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DeviceExecuteTaskBody,
  DeviceInfo,
  XhsOpsAccount,
  XhsOpsProject,
} from "@nexu/shared";
import { afterAll, describe, expect, it } from "vitest";
import {
  XhsOpsRunService,
  interpretTaskResult,
} from "../src/services/xhs-ops-run-service.js";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";

const tempDir = mkdtempSync(join(tmpdir(), "xhs-ops-queue-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

const PLAN = {
  keywords: [{ keyword: "亲子酒店", count: 1 }],
  homeFeedCount: 0,
  dwellSecMin: 11,
  dwellSecMax: 20,
  interaction: {
    like: { enabled: false, dailyCap: 0, ratioPercent: 0 },
    collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
    follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
    comment: { enabled: false },
  },
};

const avatarPath = join(tempDir, "avatar.png");
const coverPath = join(tempDir, "cover.png");
writeFileSync(avatarPath, "avatar");
writeFileSync(coverPath, "cover");

const READY_PROFILE = {
  nickname: "测试账号",
  bio: "天秤座 INFJ｜测试简介",
  gender: "女" as const,
  birthday: "1990-01-01",
  region: "上海",
  interestTags: ["亲子", "旅行"],
  avatarCandidates: [avatarPath],
  coverCandidates: [coverPath],
  avatarPath,
  coverPath,
};

const PROJECT_PROFILE = {
  summary: "关注亲子出行与家庭消费的城市家长",
  base: { ageRange: "25-40", genderRatio: "女性为主", regions: ["上海"] },
  verticalInterests: ["亲子旅行"],
  generalInterests: ["摄影", "咖啡"],
};

async function createReadyProject(
  store: XhsOpsStore,
  name: string,
): Promise<XhsOpsProject> {
  const created = await store.createProject({
    name,
    business: { industry: "文旅", product: "亲子酒店" },
    audience: {
      ageRange: "25-40",
      genderRatio: "女性为主",
      regions: ["上海"],
    },
  });
  return store.confirmProfile(created.id, {
    profile: PROJECT_PROFILE,
    expectedUpdatedAt: created.updatedAt,
  });
}

async function createAccount(
  store: XhsOpsStore,
  project: XhsOpsProject,
  label: string,
  deviceId: string,
): Promise<XhsOpsAccount> {
  return store.createAccount({
    projectId: project.id,
    label,
    positioning: "分享真实亲子旅行体验",
    persona: {
      age: "32",
      gender: "女",
      region: "上海",
      occupation: `产品经理-${label}`,
      lifeStatus: "育有一名学龄前儿童",
    },
    personaTags: {
      vertical: ["亲子旅行"],
      general: ["摄影", "咖啡"],
    },
    interestPool: {
      core: ["亲子酒店"],
      extended: ["周末遛娃"],
      general: ["摄影"],
    },
    platformAccountId: `platform-${label}`,
    deviceId,
    deviceName: deviceId,
    profileDraft: READY_PROFILE,
  });
}

async function confirmAccount(
  store: XhsOpsStore,
  project: XhsOpsProject,
  account: XhsOpsAccount,
): Promise<XhsOpsAccount> {
  const [personaConfirmed] = await store.confirmPersonas(project.id, {
    accounts: [{ accountId: account.id, expectedUpdatedAt: account.updatedAt }],
    expectedUpdatedAt: project.updatedAt,
    distributionReviewed: true,
    reviewNote: "测试确认人设分布",
  });
  if (!personaConfirmed) throw new Error("persona confirmation failed");
  const draftConfirmed = await store.confirmProfileDraft(account.id);
  if (!draftConfirmed) throw new Error("profile draft confirmation failed");
  const appliedAt = "2026-09-09T10:00:00.000Z";
  const applied = await store.updateAccount(
    account.id,
    {},
    {
      profileApplyResult: {
        expectedProfileDraft: draftConfirmed.profileDraft,
        expectedPlatformAccountId: draftConfirmed.platformAccountId,
        appliedAt,
        applyStatus: "applied",
        applyResult: "测试资料已应用并核验",
        verifiedAt: appliedAt,
        verifiedAccountId: draftConfirmed.platformAccountId,
        verificationTaskId: `verify-${account.id}`,
      },
    },
  );
  if (!applied) throw new Error("profile apply result failed");
  return applied;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function taskResult(message: string) {
  return { result: { taskId: "t", success: true, message } };
}

function preparationResult() {
  return {
    result: {
      taskId: "prep",
      success: true,
      message:
        'PREPARATION_JSON:{"v":1,"status":"ready","code":"ready","profileVerified":true}',
    },
  };
}

const DONE_MESSAGE =
  '完成\nRECORD_JSON:{"v":1,"mode":"search","keyword":"亲子酒店","planned":1,"browsed":1,"skipped":0,"refreshCount":0,"interactions":{"like":0,"collect":0,"follow":0},"anomalies":[],"posts":[{"title":"亲子酒店体验","author":"测试作者","action":"none","commentsRead":0,"dwellSeconds":11,"commentsComplete":true}],"observation":"ok"}';

async function until(pred: () => Promise<boolean> | boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
}

describe("XhsOpsRunService device queue (P2-4 同一手机串行)", () => {
  it("reuses the same planned or running dispatch only when requested", async () => {
    const store = new XhsOpsStore(join(tempDir, "reuse-active.json"));
    const project = await createReadyProject(store, "复用任务");
    const account = await confirmAccount(
      store,
      project,
      await createAccount(store, project, "复用账号", "dev-reuse"),
    );
    const service = new XhsOpsRunService({
      store,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async () => {
          throw new Error("unused");
        },
        cancelTask: async () => {},
      },
    });
    const input = {
      projectId: project.id,
      accountId: account.id,
      plan: PLAN,
      reuseActive: true,
    };

    const [first, concurrent] = await Promise.all([
      service.createRun(input),
      service.createRun(input),
    ]);
    expect(concurrent.id).toBe(first.id);
    expect(await store.listRuns({ accountId: account.id })).toHaveLength(1);

    await store.updateRun(first.id, (run) => ({
      ...run,
      status: "running",
    }));
    expect((await service.createRun(input)).id).toBe(first.id);

    const explicitQueue = await service.createRun({
      ...input,
      reuseActive: false,
    });
    expect(explicitQueue.id).not.toBe(first.id);
    expect(await store.listRuns({ accountId: account.id })).toHaveLength(2);
  });

  it("second run on the same phone waits in the queue and starts after the first drains", async () => {
    const store = new XhsOpsStore(join(tempDir, "q1.json"));
    const project = await createReadyProject(store, "队列");
    const mk = async (label: string, deviceId: string) => {
      return confirmAccount(
        store,
        project,
        await createAccount(store, project, label, deviceId),
      );
    };
    const a = await mk("A", "dev-1");
    const b = a;
    const c = await mk("C-other-phone", "dev-2");

    const gates: Array<ReturnType<typeof deferred<DeviceExecuteTaskBody>>> = [];
    const executed: string[] = [];
    let clock = Date.now();
    const service = new XhsOpsRunService({
      store,
      deviceControl: {
        getDevice: async (id: string) =>
          ({
            deviceId: id,
            status: "idle",
            lastSeen: Date.now(),
          }) as DeviceInfo,
        executeTask: async (deviceId: string, body: DeviceExecuteTaskBody) => {
          if (body.taskPolicy?.operationClass === "account.login") {
            return preparationResult();
          }
          executed.push(deviceId);
          const gate = deferred<DeviceExecuteTaskBody>();
          gates.push(gate);
          await gate.promise;
          clock += 11_000;
          return taskResult(DONE_MESSAGE);
        },
        cancelTask: async () => {},
      },
      options: { idlePollIntervalMs: 5, now: () => clock },
    });

    const runA = await service.createRun({
      projectId: project.id,
      accountId: a.id,
      plan: PLAN,
    });
    const runB = await service.createRun({
      projectId: project.id,
      accountId: b.id,
      plan: PLAN,
    });
    const runC = await service.createRun({
      projectId: project.id,
      accountId: c.id,
      plan: PLAN,
    });

    const startedA = await service.startRun(runA.id);
    expect(startedA.status).toBe("running");
    const startedB = await service.startRun(runB.id);
    expect(startedB.status).toBe("planned");
    expect(startedB.queuedBehindRunId).toBe(runA.id);
    expect(service.queuedRunIds("dev-1")).toEqual([runB.id]);
    // 另一部手机不受影响
    const startedC = await service.startRun(runC.id);
    expect(startedC.status).toBe("running");

    // 再次 start 一个排队中的 run 不会重复入队
    await expect(service.startRun(runB.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(service.queuedRunIds("dev-1")).toEqual([runB.id]);

    await until(() => executed.filter((d) => d === "dev-1").length === 1);
    gates[0]?.resolve({} as DeviceExecuteTaskBody); // A 的手机任务结束
    await service.waitForRun(runA.id);
    await until(
      async () => (await store.getRun(runB.id))?.status === "running",
    );
    const b2 = await store.getRun(runB.id);
    expect(b2?.queuedBehindRunId).toBeNull();
    expect(service.queuedRunIds("dev-1")).toEqual([]);

    // 收尾：放行剩余任务
    await until(() => gates.length >= 3);
    for (const g of gates) g.resolve({} as DeviceExecuteTaskBody);
    await service.waitForRun(runB.id);
    await service.waitForRun(runC.id);
    expect((await store.getRun(runB.id))?.status).toBe("completed");
  });

  it("a queued run can be cancelled without touching the phone, and recovery cancels interrupted queues", async () => {
    const store = new XhsOpsStore(join(tempDir, "q2.json"));
    const project = await createReadyProject(store, "队列取消");
    const a = await confirmAccount(
      store,
      project,
      await createAccount(store, project, "A", "dev-1"),
    );
    const b = a;
    const gate = deferred<void>();
    let cancelCalls = 0;
    let clock = Date.now();
    const service = new XhsOpsRunService({
      store,
      deviceControl: {
        getDevice: async (id: string) =>
          ({
            deviceId: id,
            status: "idle",
            lastSeen: Date.now(),
          }) as DeviceInfo,
        executeTask: async (_deviceId, body) => {
          if (body.taskPolicy?.operationClass === "account.login") {
            return preparationResult();
          }
          await gate.promise;
          clock += 11_000;
          return taskResult(DONE_MESSAGE);
        },
        cancelTask: async () => {
          cancelCalls += 1;
        },
      },
      options: { idlePollIntervalMs: 5, now: () => clock },
    });
    const runA = await service.createRun({
      projectId: project.id,
      accountId: a.id,
      plan: PLAN,
    });
    const runB = await service.createRun({
      projectId: project.id,
      accountId: b.id,
      plan: PLAN,
    });
    await service.startRun(runA.id);
    await service.startRun(runB.id);
    const cancelled = await service.cancelRun(runB.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.queuedBehindRunId).toBeNull();
    expect(cancelCalls).toBe(0);
    expect(service.queuedRunIds("dev-1")).toEqual([]);

    // 模拟上一进程留下的排队标记
    await store.updateRun(runB.id, (cur) => ({
      ...cur,
      status: "planned",
      queuedBehindRunId: runA.id,
    }));
    const fresh = new XhsOpsRunService({
      store,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async () => taskResult(""),
        cancelTask: async () => {},
      },
    });
    await fresh.recoverInterruptedRuns();
    expect((await store.getRun(runB.id))?.queuedBehindRunId).toBeNull();
    expect((await store.getRun(runB.id))?.status).toBe("cancelled");

    gate.resolve();
    await service.waitForRun(runA.id);
  });

  it("requires confirmation at create time and rechecks it before start", async () => {
    const store = new XhsOpsStore(join(tempDir, "profile-gate.json"));
    const project = await createReadyProject(store, "资料门禁");
    const account = await createAccount(
      store,
      project,
      "待确认账号",
      "dev-profile-gate",
    );
    let deviceChecks = 0;
    const service = new XhsOpsRunService({
      store,
      deviceControl: {
        getDevice: async () => {
          deviceChecks += 1;
          return null;
        },
        executeTask: async () => {
          throw new Error("unused");
        },
        cancelTask: async () => {},
      },
    });
    const input = {
      projectId: project.id,
      accountId: account.id,
      plan: PLAN,
    };

    await expect(service.createRun(input)).rejects.toMatchObject({
      status: 409,
    });
    const confirmed = await confirmAccount(store, project, account);
    expect(confirmed.profileDraft.verifiedAt).not.toBeNull();

    await expect(
      service.createRun({
        ...input,
        plan: { ...PLAN, dwellSecMin: 10 },
      }),
    ).rejects.toMatchObject({ status: 409 });

    const legacy = await service.createRun(input);
    await store.updateRun(legacy.id, (current) => ({
      ...current,
      plan: { ...current.plan, dwellSecMin: 10 },
    }));
    await expect(service.startRun(legacy.id)).rejects.toMatchObject({
      status: 409,
    });

    const run = await service.createRun(input);
    await store.updateAccount(account.id, {
      profileDraft: {
        ...confirmed?.profileDraft,
        bio: "编辑后的简介",
      },
    });
    await expect(service.startRun(run.id)).rejects.toMatchObject({
      status: 409,
    });

    const edited = await store.getAccount(account.id);
    if (!edited) throw new Error("account missing after edit");
    await confirmAccount(store, project, edited);
    const assertDeviceBinding = store.assertDeviceBinding.bind(store);
    store.assertDeviceBinding = async (accountId, deviceId) => {
      const current = await store.getAccount(accountId);
      await store.updateAccount(accountId, {
        profileDraft: {
          ...current?.profileDraft,
          nickname: "并发编辑昵称",
        },
      });
      return assertDeviceBinding(accountId, deviceId);
    };
    await expect(service.createRun(input)).rejects.toMatchObject({
      status: 409,
    });
    expect(deviceChecks).toBe(0);
  });
});

describe("interpretTaskResult evidence validation", () => {
  const quota = {
    like: { enabled: false, max: 0 },
    collect: { enabled: false, max: 0 },
    follow: { enabled: false, max: 0 },
  };
  const expected = {
    mode: "search" as const,
    keyword: "亲子酒店",
    plannedCount: 1,
    dwellSecMin: 11,
    elapsedMs: 12_000,
    quota,
  };

  it("rejects a missing structured record instead of marking fallback progress complete", () => {
    const outcome = interpretTaskResult(
      { taskId: "missing", success: true, message: "已浏览 1 / 1" },
      expected,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      browsed: 1,
      stopRun: true,
      error: "手机未返回可核验的结构化记录",
    });
  });

  it("keeps partial progress but fails contradictory phone evidence", () => {
    const outcome = interpretTaskResult(
      {
        taskId: "contradictory",
        success: true,
        message:
          'RECORD_JSON:{"v":1,"mode":"search","keyword":"亲子酒店","planned":1,"browsed":1,"skipped":0,"refreshCount":0,"interactions":{"like":1,"collect":0,"follow":0},"anomalies":[],"posts":[{"title":"亲子酒店体验","author":"作者","action":"like","commentsRead":1,"dwellSeconds":20,"commentsComplete":false}],"observation":"done"}',
      },
      expected,
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.browsed).toBe(1);
    expect(outcome.posts).toHaveLength(1);
    expect(outcome.stopRun).toBe(true);
    expect(outcome.error).toContain("结构化记录校验失败");
  });

  it("accepts a complete record whose phone timings fit the host elapsed time", () => {
    const outcome = interpretTaskResult(
      { taskId: "valid", success: true, message: DONE_MESSAGE },
      expected,
    );

    expect(outcome).toMatchObject({
      status: "completed",
      browsed: 1,
      refreshCount: 0,
      error: null,
    });
  });

  it("rejects a home record that does not prove periodic refreshes", () => {
    const posts = Array.from({ length: 5 }, (_, index) => ({
      title: `首页帖子 ${index + 1}`,
      author: `作者 ${index + 1}`,
      action: "none",
      commentsRead: 0,
      dwellSeconds: 11,
      commentsComplete: true,
    }));
    const outcome = interpretTaskResult(
      {
        taskId: "home-no-refresh",
        success: true,
        message: `RECORD_JSON:${JSON.stringify({
          v: 1,
          mode: "home",
          keyword: null,
          planned: 5,
          browsed: 5,
          skipped: 0,
          refreshCount: 0,
          interactions: { like: 0, collect: 0, follow: 0 },
          anomalies: [],
          posts,
          observation: "done",
        })}`,
      },
      {
        ...expected,
        mode: "home",
        keyword: null,
        plannedCount: 5,
        elapsedMs: 60_000,
      },
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("首页刷新次数不足");
  });
});
