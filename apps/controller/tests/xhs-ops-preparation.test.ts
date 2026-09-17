import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DeviceExecuteTaskBody,
  DeviceInfo,
  TaskResult,
} from "@nexu/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPreparationRequest,
  buildPreparationVerificationRequest,
  interpretPreparationResult,
} from "../src/services/xhs-ops-preparation.js";
import {
  XHS_PACKAGE,
  XHS_TASK_POLICY,
  XhsOpsRunService,
} from "../src/services/xhs-ops-run-service.js";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";

const dirs: string[] = [];
const NOW = new Date(2026, 8, 8, 12).getTime();
const profile = {
  summary: "北京亲子家庭",
  base: { ageRange: "25–35", genderRatio: "女70%男30%", regions: ["北京"] },
  verticalInterests: ["亲子出游"],
  generalInterests: ["咖啡", "摄影"],
};
const plan = {
  keywords: [{ keyword: "亲子", count: 1 }],
  homeFeedCount: 1,
  dwellSecMin: 11,
  dwellSecMax: 20,
  interaction: {
    like: { enabled: false, dailyCap: 0, ratioPercent: 0 },
    collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
    follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
    comment: { enabled: false },
  },
};

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function receipt(
  status = "ready",
  code = "ready",
  profileVerified = true,
): TaskResult {
  return {
    taskId: "owned-preparation-task",
    success: status === "ready",
    message: `PREPARATION_JSON:${JSON.stringify({ v: 1, status, code, profileVerified })}`,
  };
}

function browse(
  anomaly?: string,
  mode: "search" | "home" = "search",
): TaskResult {
  return {
    taskId: "browse-task",
    success: true,
    message: `RECORD_JSON:${JSON.stringify({ mode, keyword: mode === "search" ? "亲子" : null, planned: 1, browsed: 1, refreshCount: mode === "home" ? 1 : 0, posts: [{ title: "测试内容", dwellSeconds: 12, commentsRead: 0, commentsComplete: true, actions: [] }], interactions: { like: 0, collect: 0, follow: 0 }, anomalies: anomaly ? [{ type: anomaly, detail: "已停止" }] : [] })}`,
  };
}

function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(
  preparation: () => Promise<TaskResult> = async () => receipt(),
  browseResult?: TaskResult,
) {
  const dir = mkdtempSync(join(tmpdir(), "xhs-preparation-"));
  dirs.push(dir);
  const file = join(dir, "state.json");
  const store = new XhsOpsStore(file, {
    now: () => new Date(NOW).toISOString(),
  });
  const avatar = join(dir, "avatar.png");
  const cover = join(dir, "cover.png");
  writeFileSync(avatar, "avatar");
  writeFileSync(cover, "cover");
  const createdProject = await store.createProject({
    name: "准备检查回归",
    business: { industry: "亲子", product: "周末活动" },
    audience: {
      ageRange: "25–35",
      genderRatio: "女70%男30%",
      regions: ["北京"],
    },
  });
  const project = await store.confirmProfile(createdProject.id, {
    profile,
    expectedUpdatedAt: createdProject.updatedAt,
  });
  const createdAccount = await store.createAccount({
    projectId: project.id,
    label: "测试人设",
    positioning: "记录周末亲子出游",
    persona: {
      age: "31岁",
      gender: "女",
      region: "北京",
      occupation: "产品经理",
      lifeStatus: "新手妈妈",
    },
    personaTags: { vertical: ["亲子出游"], general: ["咖啡", "摄影"] },
    interestPool: {
      core: ["亲子出游"],
      extended: ["周边游"],
      general: ["咖啡", "摄影"],
    },
    platformAccountId: "test-xhs-account",
    deviceId: "device-1",
    profileDraft: {
      nickname: "测试昵称",
      bio: "兴趣分享与日常记录",
      gender: "女",
      birthday: "1995-01-01",
      region: "北京",
      interestTags: ["亲子出游", "咖啡"],
      avatarCandidates: [avatar],
      coverCandidates: [cover],
      avatarPath: avatar,
      coverPath: cover,
    },
  });
  const [reviewed] = await store.confirmPersonas(project.id, {
    accounts: [
      {
        accountId: createdAccount.id,
        expectedUpdatedAt: createdAccount.updatedAt,
      },
    ],
    expectedUpdatedAt: project.updatedAt,
    distributionReviewed: true,
    reviewNote: "已核对测试人设",
  });
  if (!reviewed) throw new Error("missing reviewed account fixture");
  const confirmed = await store.confirmProfileDraft(createdAccount.id);
  if (!confirmed) throw new Error("missing confirmed profile fixture");
  const account = await store.updateAccount(
    confirmed.id,
    {},
    {
      profileApplyResult: {
        expectedProfileDraft: confirmed.profileDraft,
        expectedPlatformAccountId: confirmed.platformAccountId,
        appliedAt: new Date(NOW).toISOString(),
        applyStatus: "applied",
        applyResult: "fixture verified",
        verifiedAt: new Date(NOW).toISOString(),
        verifiedAccountId: confirmed.platformAccountId,
        verificationTaskId: "fixture-verification",
      },
    },
  );
  if (!account) throw new Error("missing verified account fixture");
  const calls: DeviceExecuteTaskBody[] = [];
  const cancelled: string[] = [];
  const entered = deferred();
  const clock = { now: NOW };
  const deviceControl = {
    getDevice: async () =>
      ({
        deviceId: "device-1",
        status: "idle",
        lastSeen: clock.now,
      }) as DeviceInfo,
    executeTask: async (_id: string, body: DeviceExecuteTaskBody) => {
      calls.push(body);
      if (body.taskPolicy?.operationClass === "account.login") {
        entered.release();
        return { result: await preparation() };
      }
      clock.now += 15_000;
      return {
        result:
          browseResult ??
          browse(
            undefined,
            body.task.includes("首页推荐流") ? "home" : "search",
          ),
      };
    },
    cancelTask: async (_id: string, body: { taskId: string }) => {
      cancelled.push(body.taskId);
      return { cancelled: true };
    },
  };
  const service = new XhsOpsRunService({
    store,
    deviceControl,
    options: { now: () => clock.now, idlePollIntervalMs: 1 },
  });
  const create = () =>
    service.createRun({ projectId: project.id, accountId: account.id, plan });
  return {
    file,
    store,
    service,
    calls,
    cancelled,
    entered,
    create,
    deviceControl,
    clock,
  };
}

describe("养号启动准备", () => {
  it("verifies installation/login once before all browse chunks, without changing quotas or browse policy", async () => {
    const f = await fixture();
    const run = await f.create();
    await f.service.startRun(run.id);
    await f.service.waitForRun(run.id);
    expect(f.calls.map((c) => c.taskPolicy?.operationClass)).toEqual([
      "account.login",
      "app.use.xhs",
      "app.use.xhs",
    ]);
    expect(
      f.calls.slice(1).every((c) => c.taskPolicy === XHS_TASK_POLICY),
    ).toBe(true);
    expect(await f.store.getRun(run.id)).toMatchObject({
      status: "completed",
      preparation: { status: "ready", reasonCode: "ready" },
      summary: { plannedTotal: 2, browsedTotal: 2 },
    });
  });

  it.each([
    { taskId: "t", success: true, message: "已经登录" },
    {
      ...receipt(),
      message:
        'PREPARATION_JSON:{"v":1,"status":"ready","code":"ready","profileVerified":false}',
    },
    { ...receipt(), success: false },
    {
      ...receipt(),
      message: 'PREPARATION_JSON:{"v":1,"status":"ready","code":"ready"}',
    },
    { ...receipt(), message: "PREPARATION_JSON:{bad json}" },
  ])(
    "requires a successful, valid personal-homepage receipt (%#)",
    async (result) => {
      const f = await fixture(async () => result);
      const run = await f.create();
      await f.service.startRun(run.id);
      await f.service.waitForRun(run.id);
      expect(f.calls).toHaveLength(result.success ? 2 : 1);
      expect(await f.store.getRun(run.id)).toMatchObject({
        status: "failed",
        preparation: { status: "failed", reasonCode: "invalid_result" },
        summary: { browsedTotal: 0 },
      });
    },
  );

  it("rechecks a missing receipt once without replaying installation or login", async () => {
    let attempt = 0;
    const f = await fixture(async () =>
      ++attempt === 1
        ? { taskId: "first-check", success: true, message: "个人主页已打开" }
        : receipt(),
    );
    const run = await f.create();
    await f.service.startRun(run.id);
    await f.service.waitForRun(run.id);
    expect(f.calls).toHaveLength(4);
    expect(f.calls[1]).toEqual(
      buildPreparationVerificationRequest(XHS_PACKAGE, "test-xhs-account"),
    );
    expect(f.calls[1]?.taskPolicy?.allowedActions).not.toContain("TYPE");
    expect(f.calls[1]?.taskPolicy?.allowedAppRoles).toEqual([
      "target_app",
      "system_dialog",
    ]);
    expect((await f.store.getRun(run.id))?.status).toBe("completed");
  });

  it("keeps preparation open when login dispatch transport fails", async () => {
    const f = await fixture(async () => {
      throw new Error("transport closed after dispatch");
    });
    const run = await f.create();
    await f.service.startRun(run.id);
    await f.service.waitForRun(run.id);
    expect(await f.store.getRun(run.id)).toMatchObject({
      status: "running",
      preparation: {
        status: "running",
        reasonCode: "dispatch_failed",
        completedAt: null,
      },
      chunks: [{ status: "skipped" }, { status: "skipped" }],
    });
    const retry = await f.create();
    await expect(f.service.startRun(retry.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("停止未确认"),
    });
  });

  it("keeps a browse chunk open when task dispatch transport fails", async () => {
    const f = await fixture();
    const run = await f.create();
    const originalExecuteTask = f.deviceControl.executeTask;
    f.deviceControl.executeTask = async (_deviceId, body) => {
      if (body.taskPolicy?.operationClass === "app.use.xhs") {
        throw new Error("transport closed after dispatch");
      }
      return originalExecuteTask(_deviceId, body);
    };
    await f.service.startRun(run.id);
    await f.service.waitForRun(run.id);
    expect(await f.store.getRun(run.id)).toMatchObject({
      status: "running",
      preparation: { status: "ready" },
      chunks: [{ status: "running", completedAt: null }, { status: "skipped" }],
    });
  });

  it("keeps a browse CALL_USER task running until cancellation is confirmed, then stops the remaining chunks", async () => {
    const f = await fixture(undefined, {
      ...browse(),
      needsInteraction: true,
      success: false,
    });
    const entered = deferred();
    const stopped = deferred();
    f.deviceControl.cancelTask = async (_id, body) => {
      f.cancelled.push(body.taskId);
      entered.release();
      await stopped.promise;
      return { cancelled: true };
    };
    const run = await f.create();
    await f.service.startRun(run.id);
    await entered.promise;
    expect(await f.store.getRun(run.id)).toMatchObject({
      status: "running",
      chunks: [
        { status: "running", taskId: "browse-task" },
        { status: "pending" },
      ],
    });
    expect(f.calls).toHaveLength(2);
    stopped.release();
    await f.service.waitForRun(run.id);
    expect(f.cancelled).toEqual(["browse-task"]);
    expect(f.calls).toHaveLength(2);
    expect(await f.store.getRun(run.id)).toMatchObject({
      status: "failed",
      error: "手机需要人工处理，已确认停止，后续养号任务已暂停",
      chunks: [{ status: "failed" }, { status: "skipped" }],
    });
  });

  it("records a confirmed phone cancellation as cancelled without starting the next chunk", async () => {
    const f = await fixture(undefined, {
      ...browse(),
      success: false,
      status: "aborted",
      errorCode: "USER_CANCELLED",
    });
    const run = await f.create();
    await f.service.startRun(run.id);
    await f.service.waitForRun(run.id);
    expect(f.calls).toHaveLength(2);
    expect(await f.store.getRun(run.id)).toMatchObject({
      status: "cancelled",
      chunks: [{ status: "cancelled" }, { status: "cancelled" }],
    });
  });

  it("stops the device queue on human intervention and never persists raw login output", async () => {
    const gate = deferred();
    const canary = "PRIVATE-LOGIN-CONTENT";
    const f = await fixture(async () => {
      await gate.promise;
      return {
        ...receipt("blocked", "phone_required", false),
        message: `${canary}\n${receipt("blocked", "phone_required", false).message}`,
        finalScreenshot: canary,
      };
    });
    const first = await f.create();
    const next = await f.create();
    await f.service.startRun(first.id);
    await f.entered.promise;
    expect((await f.store.getRun(first.id))?.preparation?.status).toBe(
      "running",
    );
    await f.service.startRun(next.id);
    gate.release();
    await f.service.waitForRun(first.id);
    expect(f.calls).toHaveLength(1);
    expect((await f.store.getRun(first.id))?.preparation).toMatchObject({
      status: "blocked",
      reasonCode: "phone_required",
    });
    expect((await f.store.getRun(next.id))?.status).toBe("cancelled");
    expect(readFileSync(f.file, "utf8")).not.toContain(canary);
  });

  it("cancels only the owned CALL_USER task so its human-wait timer cannot resume login", async () => {
    const f = await fixture(async () => ({
      ...receipt(),
      needsInteraction: true,
    }));
    const run = await f.create();
    await f.service.startRun(run.id);
    await f.service.waitForRun(run.id);
    expect(f.cancelled).toEqual(["owned-preparation-task"]);
    expect(f.calls).toHaveLength(1);
    expect(await f.store.getRun(run.id)).toMatchObject({
      preparation: {
        status: "blocked",
        reasonCode: "verification_required",
        completedAt: expect.any(String),
      },
    });
  });

  it("fails closed when cancellation of a CALL_USER task is not acknowledged", async () => {
    const f = await fixture(async () => ({
      ...receipt(),
      needsInteraction: true,
    }));
    f.deviceControl.cancelTask = async () => ({ cancelled: false });
    const run = await f.create();
    await f.service.startRun(run.id);
    await f.service.waitForRun(run.id);
    expect(f.calls).toHaveLength(1);
    expect(await f.store.getRun(run.id)).toMatchObject({
      status: "running",
      preparation: {
        status: "running",
        reasonCode: "dispatch_failed",
        taskId: "owned-preparation-task",
        completedAt: null,
      },
    });
    const next = await f.create();
    const fresh = new XhsOpsRunService({
      store: new XhsOpsStore(f.file),
      deviceControl: f.deviceControl,
      options: { now: () => f.clock.now, idlePollIntervalMs: 1 },
    });
    await fresh.recoverInterruptedRuns();
    await expect(fresh.startRun(next.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("停止未确认"),
    });
    expect(f.calls).toHaveLength(1);
  });

  it.each(["account_restricted", "rate_limited"])(
    "retains %s across CALL_USER and failed cancellation",
    async (code) => {
      const f = await fixture(async () => ({
        ...receipt("blocked", code, false),
        needsInteraction: true,
      }));
      const run = await f.create();
      f.deviceControl.cancelTask = async (_deviceId, body) => {
        // Ownership is durable before making the cancellation RPC.
        expect((await f.store.getRun(run.id))?.preparation).toMatchObject({
          status: "running",
          taskId: body.taskId,
          reasonCode: code,
        });
        throw new Error("unacknowledged cancellation");
      };
      await f.service.startRun(run.id);
      await f.service.waitForRun(run.id);
      expect((await f.store.getRun(run.id))?.preparation).toMatchObject({
        status: "running",
        reasonCode: code,
        taskId: "owned-preparation-task",
      });
      const next = await f.create();
      await expect(f.service.startRun(next.id)).rejects.toMatchObject({
        status: 409,
      });
      expect(f.calls).toHaveLength(1);
    },
  );

  it.each([
    "ABORT: login verification failed",
    "尚未确认登录成功",
    "[桌面校验] 结果不一致",
    "[回执] 各应用生效点击: =1",
    "[回执] 各应用生效点击: com.xingin.xhs=2\nABORT: failed",
  ])("rejects a ready receipt followed by unexpected output: %s", (tail) => {
    expect(
      interpretPreparationResult({
        ...receipt(),
        message: `${receipt().message}\n${tail}`,
      }),
    ).toMatchObject({ status: "failed", reasonCode: "invalid_result" });
  });

  it("accepts the exact machine action receipt appended by the phone", () => {
    expect(
      interpretPreparationResult({
        ...receipt(),
        message: `${receipt().message}\n[回执] 各应用生效点击: com.xingin.xhs=2, com.xiaomi.market=1\n`,
      }).status,
    ).toBe("ready");
  });

  it("does not continue browsing after cancellation during preparation", async () => {
    const gate = deferred();
    const f = await fixture(async () => {
      await gate.promise;
      return receipt();
    });
    const run = await f.create();
    await f.service.startRun(run.id);
    await f.entered.promise;
    await f.service.cancelRun(run.id);
    gate.release();
    await f.service.waitForRun(run.id);
    expect(f.calls).toHaveLength(1);
    expect(f.cancelled).toEqual([]);
    expect(await f.store.getRun(run.id)).toMatchObject({
      status: "cancelled",
      preparation: { status: "cancelled" },
    });
  });

  it.each(["account_restricted", "rate_limited"])(
    "persists %s during preparation as a day lock, even across restart",
    async (code) => {
      const f = await fixture(async () => receipt("blocked", code, false));
      const first = await f.create();
      await f.service.startRun(first.id);
      await f.service.waitForRun(first.id);
      const next = await f.create();
      const fresh = new XhsOpsRunService({
        store: new XhsOpsStore(f.file),
        deviceControl: f.deviceControl,
        options: { now: () => f.clock.now },
      });
      await expect(fresh.startRun(next.id)).rejects.toMatchObject({
        status: 409,
      });
      expect(f.calls).toHaveLength(1);
      f.clock.now += 24 * 60 * 60_000;
      await fresh.startRun(next.id);
      await fresh.waitForRun(next.id);
      expect(f.calls).toHaveLength(2);
    },
  );

  it("does not lose a restriction result when cancellation races its completion", async () => {
    const gate = deferred();
    const f = await fixture(async () => {
      await gate.promise;
      return receipt("blocked", "rate_limited", false);
    });
    const first = await f.create();
    await f.service.startRun(first.id);
    await f.entered.promise;
    await f.service.cancelRun(first.id);
    gate.release();
    await f.service.waitForRun(first.id);
    const next = await f.create();
    await expect(f.service.startRun(next.id)).rejects.toMatchObject({
      status: 409,
    });
    expect((await f.store.getRun(first.id))?.preparation).toMatchObject({
      status: "cancelled",
      reasonCode: "rate_limited",
    });
  });

  it("can prepare after a historical missing-login result, but does not re-login when browsing loses login", async () => {
    const f = await fixture(async () => receipt(), browse("login_required"));
    const old = await f.create();
    await f.store.updateRun(old.id, (r) => ({
      ...r,
      status: "failed",
      chunks: r.chunks.map((c) => ({
        ...c,
        status: "failed",
        anomalies: [{ type: "login_required", detail: "未登录" }],
      })),
    }));
    const run = await f.create();
    await f.service.startRun(run.id);
    await f.service.waitForRun(run.id);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.taskPolicy?.operationClass).toBe("account.login");
    expect(await f.store.getRun(run.id)).toMatchObject({
      status: "failed",
      chunks: [{ status: "completed" }, { status: "skipped" }],
    });
  });

  it.each(["running", "cancelled", "completed"] as const)(
    "closes leftover preparation in a %s run after restart without replay",
    async (status) => {
      const f = await fixture();
      const run = await f.create();
      await f.store.updateRun(run.id, (r) => ({
        ...r,
        status,
        preparation: {
          status: "running",
          reasonCode: null,
          reason: null,
          taskId: null,
          startedAt: new Date(NOW).toISOString(),
          completedAt: null,
        },
      }));
      await f.service.recoverInterruptedRuns();
      expect((await f.store.getRun(run.id))?.preparation).toMatchObject({
        status: "interrupted",
        reasonCode: "interrupted",
      });
      expect(f.calls).toEqual([]);
    },
  );

  it("cancels an owned interaction left by a crash and preserves its day lock", async () => {
    const f = await fixture();
    const run = await f.create();
    await f.store.updateRun(run.id, (r) => ({
      ...r,
      status: "running",
      preparation: {
        status: "running",
        reasonCode: "rate_limited",
        reason: "操作频繁",
        taskId: "owned-interaction",
        startedAt: new Date(NOW).toISOString(),
        completedAt: null,
      },
    }));
    await f.service.recoverInterruptedRuns();
    expect(f.cancelled).toEqual(["owned-interaction"]);
    expect(f.calls).toEqual([]);
    expect((await f.store.getRun(run.id))?.preparation).toMatchObject({
      status: "interrupted",
      reasonCode: "rate_limited",
    });
    const next = await f.create();
    await expect(f.service.startRun(next.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("stops a persisted browse interaction on restart without replaying it", async () => {
    const f = await fixture();
    const run = await f.create();
    await f.store.updateRun(run.id, (current) => ({
      ...current,
      status: "running",
      chunks: current.chunks.map((chunk, index) =>
        index === 0
          ? { ...chunk, status: "running", taskId: "owned-browse-interaction" }
          : chunk,
      ),
    }));
    await f.service.recoverInterruptedRuns();
    expect(f.cancelled).toEqual(["owned-browse-interaction"]);
    expect(f.calls).toEqual([]);
    expect((await f.store.getRun(run.id))?.status).toBe("interrupted");
  });

  it.each(["preparation", "chunk"] as const)(
    "keeps an unconfirmed recovered %s task isolated even when the device reports idle",
    async (source) => {
      const f = await fixture();
      const run = await f.create();
      await f.store.updateRun(run.id, (current) => ({
        ...current,
        status: "running",
        preparation:
          source === "preparation"
            ? {
                status: "running",
                reasonCode: null,
                reason: null,
                taskId: "unconfirmed-preparation",
                startedAt: new Date(NOW).toISOString(),
                completedAt: null,
              }
            : current.preparation,
        chunks:
          source === "chunk"
            ? current.chunks.map((chunk, index) =>
                index === 0
                  ? {
                      ...chunk,
                      status: "running",
                      taskId: "unconfirmed-chunk",
                      startedAt: new Date(NOW).toISOString(),
                    }
                  : chunk,
              )
            : current.chunks,
      }));
      f.deviceControl.cancelTask = async () => ({ cancelled: false });

      await f.service.recoverInterruptedRuns();

      const recovered = await f.store.getRun(run.id);
      expect(recovered?.status).toBe("running");
      if (source === "preparation") {
        expect(recovered?.preparation).toMatchObject({
          status: "running",
          taskId: "unconfirmed-preparation",
        });
      } else {
        expect(recovered?.chunks[0]).toMatchObject({
          status: "running",
          taskId: "unconfirmed-chunk",
        });
      }
      const next = await f.create();
      await expect(f.service.startRun(next.id)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("停止未确认"),
      });
      expect(f.calls).toEqual([]);

      f.deviceControl.cancelTask = async () => ({ cancelled: true });
      await f.service.recoverInterruptedRuns();
      expect((await f.store.getRun(run.id))?.status).toBe("interrupted");
      await f.service.startRun(next.id);
      await f.service.waitForRun(next.id);
      expect((await f.store.getRun(next.id))?.status).toBe("completed");
    },
  );

  it("keeps a phone-reported safety reason when CALL_USER stops a browse run", async () => {
    const f = await fixture(undefined, {
      ...browse("rate_limited"),
      success: false,
      needsInteraction: true,
    });
    const run = await f.create();
    await f.service.startRun(run.id);
    await f.service.waitForRun(run.id);

    expect(await f.store.getRun(run.id)).toMatchObject({
      status: "failed",
      error: "安全停机：手机报告 rate_limited（已停止）",
      chunks: [{ status: "failed" }, { status: "skipped" }],
    });
  });

  it("persists an unconfirmed browse CALL_USER task across controller restart", async () => {
    const f = await fixture(undefined, {
      ...browse(),
      success: false,
      needsInteraction: true,
    });
    f.deviceControl.cancelTask = async () => ({ cancelled: false });
    const run = await f.create();
    await f.service.startRun(run.id);
    await f.service.waitForRun(run.id);

    expect(await f.store.getRun(run.id)).toMatchObject({
      status: "running",
      chunks: [
        { status: "running", taskId: "browse-task" },
        { status: "skipped" },
      ],
    });
    const next = await f.create();
    const fresh = new XhsOpsRunService({
      store: new XhsOpsStore(f.file),
      deviceControl: f.deviceControl,
      options: { now: () => f.clock.now, idlePollIntervalMs: 1 },
    });
    await fresh.recoverInterruptedRuns();
    await expect(fresh.startRun(next.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("停止未确认"),
    });
    expect(f.calls).toHaveLength(2);
  });

  it("does not leak a dispatch error into preparation or run history", async () => {
    const canary = "SECRET-ERROR-PAYLOAD";
    const f = await fixture(async () => {
      throw new Error(canary);
    });
    const run = await f.create();
    await f.service.startRun(run.id);
    await f.service.waitForRun(run.id);
    expect(readFileSync(f.file, "utf8")).not.toContain(canary);
    expect((await f.store.getRun(run.id))?.preparation?.reasonCode).toBe(
      "dispatch_failed",
    );
  });

  it("grants store/SMS access only to preparation and keeps browsers and interactions excluded", () => {
    const prep = buildPreparationRequest(XHS_PACKAGE);
    expect(prep.allowedApps).toEqual([XHS_PACKAGE]);
    expect(prep.taskPolicy?.allowedAppRoles).toEqual([
      "target_app",
      "official_store",
      "system_installer",
      "default_sms",
      "system_dialog",
    ]);
    expect(prep.taskPolicy?.confirmationPolicy).toEqual({
      login: "required",
      publish: "forbidden",
      comment: "forbidden",
      payment: "forbidden",
    });
    expect(prep.taskPolicy?.allowBrowserDownload).toBe(false);
    expect(XHS_TASK_POLICY.allowedAppRoles).not.toContain("official_store");
    expect(XHS_TASK_POLICY.allowedAppRoles).not.toContain("default_sms");
    expect(
      interpretPreparationResult({
        ...receipt(),
        message: `${receipt().message}\nPREPARATION_JSON:{"v":1,"status":"blocked","code":"phone_required","profileVerified":false}`,
      }).status,
    ).toBe("blocked");
  });
});
