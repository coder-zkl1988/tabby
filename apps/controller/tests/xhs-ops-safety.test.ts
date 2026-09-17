import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceExecuteTaskBody, TaskResult } from "@nexu/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  XhsOpsRunService,
  interpretCommentTaskResult,
} from "../src/services/xhs-ops-run-service.js";
import { XHS_OPS_MAX_RUNS, XhsOpsStore } from "../src/store/xhs-ops-store.js";

const directories: string[] = [];
const NOW = new Date(2026, 8, 7, 12).getTime();
const TEXT = "这个安排很贴心";
const interaction = {
  like: { enabled: true, dailyCap: 1, ratioPercent: 100 },
  collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
  follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
  comment: { enabled: true, dailyCap: 2 },
};
const plan = {
  keywords: [{ keyword: "亲子酒店", count: 3 }],
  homeFeedCount: 0,
  dwellSecMin: 11,
  dwellSecMax: 20,
  interaction,
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function result(like = 0, anomaly?: string): TaskResult {
  return {
    taskId: "test-task",
    success: true,
    message: `RECORD_JSON:${JSON.stringify({
      mode: "search",
      keyword: "亲子酒店",
      planned: 3,
      browsed: 3,
      skipped: 0,
      refreshCount: 0,
      interactions: { like, collect: 0, follow: 0 },
      anomalies: anomaly ? [{ type: anomaly, detail: "test" }] : [],
      posts: [1, 2, 3].map((index) => ({
        title: `亲子酒店体验 ${index}`,
        author: `作者 ${index}`,
        action: like > 0 && index === 1 ? "like" : "none",
        commentsRead: 0,
        dwellSeconds: 11,
        commentsComplete: true,
      })),
      observation: "done",
    })}`,
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
  execute?: (body: DeviceExecuteTaskBody) => Promise<TaskResult>,
) {
  const directory = mkdtempSync(join(tmpdir(), "xhs-safety-"));
  directories.push(directory);
  const file = join(directory, "state.json");
  const store = new XhsOpsStore(file, {
    now: () => new Date(NOW).toISOString(),
  });
  const avatarPath = join(directory, "avatar.png");
  const coverPath = join(directory, "cover.png");
  writeFileSync(avatarPath, "avatar");
  writeFileSync(coverPath, "cover");
  const createdProject = await store.createProject({
    name: "review regression",
    business: { industry: "文旅", product: "亲子酒店" },
    audience: {
      ageRange: "25-40",
      genderRatio: "女性为主",
      regions: ["上海"],
    },
  });
  const project = await store.confirmProfile(createdProject.id, {
    profile: {
      summary: "关注亲子出行与家庭消费的城市家长",
      base: {
        ageRange: "25-40",
        genderRatio: "女性为主",
        regions: ["上海"],
      },
      verticalInterests: ["亲子旅行"],
      generalInterests: ["摄影", "咖啡"],
    },
    expectedUpdatedAt: createdProject.updatedAt,
  });
  const account = await store.createAccount({
    projectId: project.id,
    label: "测试账号",
    positioning: "分享真实亲子旅行体验",
    persona: {
      age: "32",
      gender: "女",
      region: "上海",
      occupation: "产品经理",
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
    platformAccountId: "platform-test-account",
    deviceId: "phone-1",
    interaction,
    profileDraft: {
      nickname: "测试账号",
      bio: "天秤座 INFJ｜测试简介",
      gender: "女",
      birthday: "1990-01-01",
      region: "上海",
      interestTags: ["亲子", "旅行"],
      avatarCandidates: [avatarPath],
      coverCandidates: [coverPath],
      avatarPath,
      coverPath,
    },
  });
  const [personaConfirmed] = await store.confirmPersonas(project.id, {
    accounts: [{ accountId: account.id, expectedUpdatedAt: account.updatedAt }],
    expectedUpdatedAt: project.updatedAt,
    distributionReviewed: true,
    reviewNote: "测试确认人设分布",
  });
  if (!personaConfirmed) throw new Error("persona confirmation failed");
  const draftConfirmed = await store.confirmProfileDraft(account.id);
  if (!draftConfirmed) throw new Error("profile draft confirmation failed");
  const appliedAt = new Date(NOW - 60_000).toISOString();
  const readyAccount = await store.updateAccount(
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
        verificationTaskId: "verify-test-account",
      },
    },
  );
  if (!readyAccount) throw new Error("profile apply result failed");
  const calls: DeviceExecuteTaskBody[] = [];
  const cancellations: string[] = [];
  const clock = { now: NOW };
  const service = new XhsOpsRunService({
    store,
    deviceControl: {
      getDevice: async (deviceId) =>
        ({ deviceId, status: "idle", lastSeen: clock.now }) as never,
      executeTask: async (_id, body) => {
        if (body.taskPolicy?.operationClass === "account.login") {
          return {
            result: {
              taskId: "prep",
              success: true,
              message:
                'PREPARATION_JSON:{"v":1,"status":"ready","code":"ready","profileVerified":true}',
            },
          };
        }
        calls.push(body);
        const taskResult = execute ? await execute(body) : result();
        if (body.taskPolicy?.operationClass !== "social.comment") {
          clock.now += 33_000;
        }
        return { result: taskResult };
      },
      cancelTask: async (_id, body) => {
        cancellations.push(body.taskId);
      },
    },
    options: { now: () => clock.now, idlePollIntervalMs: 1 },
  });
  const create = () =>
    service.createRun({ projectId: project.id, accountId: account.id, plan });
  const approve = async () => {
    const browse = await create();
    await store.updateRun(browse.id, (run) => ({
      ...run,
      status: "completed",
      completedAt: new Date(NOW - 1_200_000).toISOString(),
      summary: { ...run.summary, browsedTotal: 16 },
    }));
    return store.createComment({
      projectId: project.id,
      accountId: account.id,
      deviceId: account.deviceId,
      sourceRunId: browse.id,
      sourceChunkIndex: 0,
      sourcePostIndex: 0,
      post: { title: "周末亲子酒店", author: "作者", summary: "亲子活动" },
      candidates: [TEXT],
      text: TEXT,
      status: "approved",
      reviewedAt: new Date(NOW).toISOString(),
      reviewNote: "",
      sentRunId: null,
      sentAt: null,
      sendResult: null,
    });
  };
  return {
    store,
    file,
    service,
    project,
    account: readyAccount,
    calls,
    create,
    approve,
    clock,
    cancellations,
  };
}

describe("xhs ops review safety regressions", () => {
  it("keeps today's quota and safety evidence when history reaches its limit", async () => {
    const f = await fixture();
    const evidence = await f.create();
    await f.store.updateRun(evidence.id, (r) => ({
      ...r,
      status: "failed",
      chunks: r.chunks.map((c) => ({
        ...c,
        status: "failed",
        startedAt: new Date(NOW).toISOString(),
        interactions: { like: 1, collect: 0, follow: 0 },
        anomalies: [{ type: "rate_limited", detail: "test" }],
      })),
    }));
    let latest = evidence;
    for (let i = 1; i < XHS_OPS_MAX_RUNS; i++) latest = await f.create();
    await expect(f.create()).rejects.toMatchObject({ status: 409 });
    expect(await f.store.getRun(evidence.id)).not.toBeNull();
    await expect(f.store.deleteProject(f.project.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(f.service.startRun(latest.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(f.calls).toHaveLength(0);
  }, 15_000);

  it("reserves unknown interaction usage after cancellation and a controller restart", async () => {
    const f = await fixture();
    const a = await f.create();
    await f.store.updateRun(a.id, (r) => ({
      ...r,
      status: "cancelled",
      startedAt: new Date(NOW).toISOString(),
      chunks: r.chunks.map((c) => ({
        ...c,
        status: "running",
        startedAt: new Date(NOW).toISOString(),
      })),
    }));
    await f.service.recoverInterruptedRuns();
    expect((await f.store.getRun(a.id))?.chunks[0]?.status).toBe("failed");
    const b = await f.create();
    await f.service.startRun(b.id);
    await f.service.waitForRun(b.id);
    expect(f.calls[0]?.task).toContain("点赞 关，本次最多 0 次");
  });
  it.each(["completed", "running"] as const)(
    "recovers queued work according to its %s predecessor",
    async (status) => {
      const f = await fixture();
      const a = await f.create();
      const b = await f.create();
      await f.store.updateRun(a.id, (r) => ({ ...r, status }));
      await f.store.updateRun(b.id, (r) => ({ ...r, queuedBehindRunId: a.id }));
      await f.service.recoverInterruptedRuns();
      await f.service.waitForRun(b.id);
      expect(f.calls).toHaveLength(status === "completed" ? 1 : 0);
      expect((await f.store.getRun(b.id))?.status).toBe(
        status === "completed" ? "completed" : "cancelled",
      );
    },
  );
  it("allows a new day's quota even for a plan created the previous day", async () => {
    const f = await fixture(async () => result(1));
    const a = await f.create();
    await f.service.startRun(a.id);
    await f.service.waitForRun(a.id);
    const b = await f.create();
    f.clock.now += 24 * 60 * 60_000;
    await f.service.startRun(b.id);
    await f.service.waitForRun(b.id);
    expect(f.calls[1]?.task).toContain("点赞 开，本次最多 1 次");
  });

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "does not start a later segment after a %s predecessor",
    async (status) => {
      const f = await fixture();
      const a = await f.service.createRun({
        projectId: f.project.id,
        accountId: f.account.id,
        plan,
        segment: { index: 1, count: 2 },
      });
      await f.store.updateRun(a.id, (r) => ({ ...r, status }));
      const b = await f.service.createRun({
        projectId: f.project.id,
        accountId: f.account.id,
        plan,
        segment: { index: 2, count: 2 },
      });
      await expect(f.service.startRun(b.id)).rejects.toMatchObject({
        status: 409,
      });
      expect(f.calls).toHaveLength(0);
    },
  );

  it.each(["switch", "text", "expired"])(
    "rechecks %s before dispatching claimed comments",
    async (changed) => {
      const f = await fixture();
      const draft = await f.approve();
      const run = await f.service.createCommentRun({
        projectId: f.project.id,
        accountId: f.account.id,
      });
      if (changed === "switch")
        await f.store.updateAccount(f.account.id, {
          interaction: {
            ...interaction,
            comment: { enabled: false, dailyCap: 2 },
          },
        });
      if (changed === "text")
        await f.store.updateComment(draft.id, (d) => ({
          ...d,
          text: "内容已经变化",
        }));
      if (changed === "expired") f.clock.now += 24 * 60 * 60_000;
      await expect(f.service.startRun(run.id)).rejects.toMatchObject({
        status: 409,
      });
      expect(f.calls).toHaveLength(0);
      expect(await f.store.getComment(draft.id)).toMatchObject({
        status: "approved",
        sentRunId: null,
      });
    },
  );

  it("does not release or retry an attempted comment after controller restart", async () => {
    const f = await fixture();
    const draft = await f.approve();
    const run = await f.service.createCommentRun({
      projectId: f.project.id,
      accountId: f.account.id,
    });
    await f.store.updateRun(run.id, (r) => ({
      ...r,
      status: "running",
      startedAt: new Date(NOW).toISOString(),
      chunks: r.chunks.map((c) => ({
        ...c,
        status: "running",
        startedAt: new Date(NOW).toISOString(),
      })),
    }));
    await f.service.recoverInterruptedRuns();
    expect(await f.store.getComment(draft.id)).toMatchObject({
      status: "failed",
      sentRunId: run.id,
      sendResult: expect.stringContaining("待核验"),
    });
    await expect(
      f.service.createCommentRun({
        projectId: f.project.id,
        accountId: f.account.id,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.calls).toHaveLength(0);
  });

  it("keeps a claimed comment reserved after an uncertain dispatch", async () => {
    const f = await fixture(async (body) => {
      if (body.task.includes("小红书评论任务")) {
        throw new Error("transport closed after dispatch");
      }
      return result();
    });
    const draft = await f.approve();
    const run = await f.service.createCommentRun({
      projectId: f.project.id,
      accountId: f.account.id,
    });

    await f.service.startRun(run.id);
    await f.service.waitForRun(run.id);

    expect(await f.store.getRun(run.id)).toMatchObject({
      status: "running",
      chunks: [{ status: "running", taskId: null }],
    });
    expect(await f.store.getComment(draft.id)).toMatchObject({
      status: "approved",
      sentRunId: run.id,
    });
    await expect(
      f.service.createCommentRun({
        projectId: f.project.id,
        accountId: f.account.id,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("releases a never-started comment claim on recovery", async () => {
    const f = await fixture();
    const draft = await f.approve();
    const run = await f.service.createCommentRun({
      projectId: f.project.id,
      accountId: f.account.id,
    });
    await f.service.recoverInterruptedRuns();
    expect(await f.store.getRun(run.id)).toMatchObject({ status: "cancelled" });
    expect(await f.store.getComment(draft.id)).toMatchObject({
      status: "approved",
      sentRunId: null,
    });
  });

  it("cancelling the active run stops queued work", async () => {
    const gate = deferred();
    const dispatched = deferred();
    const f = await fixture(async () => {
      dispatched.release();
      await gate.promise;
      return result();
    });
    const a = await f.create();
    const b = await f.create();
    await f.service.startRun(a.id);
    await dispatched.promise;
    await f.service.startRun(b.id);
    const cancelling = await f.service.cancelRun(a.id);
    expect(cancelling.status).toBe("running");
    expect(cancelling.error).toContain("取消请求已提交");
    expect(f.cancellations).toHaveLength(0);
    gate.release();
    await f.service.waitForRun(a.id);
    expect(f.calls).toHaveLength(1);
    expect(await f.store.getRun(b.id)).toMatchObject({
      status: "cancelled",
      queuedBehindRunId: null,
    });
  });
  it("rejects unreviewed comments through the generic run entry", async () => {
    const f = await fixture();
    await expect(
      f.service.createRun({
        projectId: f.project.id,
        accountId: f.account.id,
        plan: {
          ...plan,
          kind: "comment",
          keywords: [],
          comments: [
            {
              draftId: "nonexistent",
              postTitle: "任意帖子",
              postAuthor: "",
              text: TEXT,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.calls).toHaveLength(0);
  });

  it("serializes simultaneous starts on one phone and rejects duplicate starts", async () => {
    const gate = deferred();
    const f = await fixture(async () => {
      await gate.promise;
      return result();
    });
    const a = await f.create();
    const b = await f.create();
    try {
      const started = await Promise.all([
        f.service.startRun(a.id),
        f.service.startRun(b.id),
      ]);
      expect(started.map((r) => r.status).sort()).toEqual([
        "planned",
        "running",
      ]);
      expect(f.service.queuedRunIds("phone-1")).toHaveLength(1);
      await expect(f.service.startRun(a.id)).rejects.toMatchObject({
        status: 409,
      });
    } finally {
      gate.release();
      await f.service.waitForRun(a.id);
      await f.service.waitForRun(b.id);
    }
  });

  it("claims each approved draft for only one concurrent comment run", async () => {
    const f = await fixture();
    const draft = await f.approve();
    const request = {
      projectId: f.project.id,
      accountId: f.account.id,
      draftIds: [draft.id],
    };
    const attempts = await Promise.allSettled([
      f.service.createCommentRun(request),
      f.service.createCommentRun(request),
    ]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await f.store.listRuns()).filter((r) => r.plan.kind === "comment"),
    ).toHaveLength(1);
  });

  it("carries the account's actual daily interaction usage into the next run", async () => {
    const f = await fixture(async () => result(1));
    const a = await f.create();
    await f.service.startRun(a.id);
    await f.service.waitForRun(a.id);
    const b = await f.create();
    await f.service.startRun(b.id);
    await f.service.waitForRun(b.id);
    expect(f.calls[0]?.task).toContain("点赞 开，本次最多 1 次");
    expect(f.calls[1]?.task).toContain("点赞 关，本次最多 0 次");
  });

  it("validates interaction ratios against actual browsing, not the planned reservation", async () => {
    const f = await fixture(async () => ({
      taskId: "partial-with-like",
      success: true,
      message: `RECORD_JSON:${JSON.stringify({
        v: 1,
        mode: "search",
        keyword: "亲子酒店",
        planned: 8,
        browsed: 1,
        skipped: 0,
        refreshCount: 0,
        interactions: { like: 1, collect: 0, follow: 0 },
        anomalies: [],
        posts: [
          {
            title: "亲子酒店体验",
            author: "作者",
            action: "like",
            commentsRead: 0,
            dwellSeconds: 11,
            commentsComplete: true,
          },
        ],
        observation: "partial",
      })}`,
    }));
    const ratioInteraction = {
      ...interaction,
      like: { enabled: true, dailyCap: 1, ratioPercent: 20 },
    };
    await f.store.updateAccount(f.account.id, {
      interaction: ratioInteraction,
    });
    const run = await f.service.createRun({
      projectId: f.project.id,
      accountId: f.account.id,
      plan: {
        ...plan,
        keywords: [{ keyword: "亲子酒店", count: 8 }],
        interaction: ratioInteraction,
      },
    });

    await f.service.startRun(run.id);
    await f.service.waitForRun(run.id);

    expect(f.calls[0]?.task).toContain("点赞 开，本次最多 1 次");
    expect(await f.store.getRun(run.id)).toMatchObject({
      status: "failed",
      chunks: [
        expect.objectContaining({
          browsed: 1,
          interactions: { like: 1, collect: 0, follow: 0 },
          error: expect.stringContaining("like 互动数超过本块上限"),
        }),
      ],
    });
  });

  it("safety stop blocks queued work and survives a new service instance", async () => {
    const gate = deferred();
    const f = await fixture(async () => {
      await gate.promise;
      return result(0, "rate_limited");
    });
    const a = await f.create();
    const b = await f.create();
    await f.service.startRun(a.id);
    await f.service.startRun(b.id);
    gate.release();
    await f.service.waitForRun(a.id);
    expect(f.calls).toHaveLength(1);
    expect((await f.store.getRun(b.id))?.status).not.toBe("running");
    const recovered = new XhsOpsRunService({
      store: new XhsOpsStore(f.file),
      deviceControl: {
        getDevice: async () => null,
        executeTask: async () => {
          throw new Error("must not dispatch");
        },
        cancelTask: async () => {},
      },
      options: { now: () => NOW },
    });
    const c = await recovered.createRun({
      projectId: f.project.id,
      accountId: f.account.id,
      plan,
    });
    await expect(recovered.startRun(c.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("enforces exclusive phone binding across projects and concurrent requests", async () => {
    const f = await fixture();
    const other = await f.store.createProject({ name: "other" });
    await expect(
      f.store.createAccount({
        projectId: other.id,
        label: "wrong",
        deviceId: "phone-1",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const a = await f.store.createAccount({ projectId: other.id, label: "A" });
    const b = await f.store.createAccount({ projectId: other.id, label: "B" });
    const attempts = await Promise.allSettled([
      f.store.updateAccount(a.id, { deviceId: "phone-2" }),
      f.store.updateAccount(b.id, { deviceId: "phone-2" }),
    ]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it.each([true, false])(
    "does not accept comment self-reports without a receipt (success=%s)",
    (success) => {
      const outcome = interpretCommentTaskResult({
        taskId: "t",
        success,
        message: 'COMMENT_JSON:{"status":"sent"}',
      });
      expect(outcome.status).toBe("failed");
      expect(outcome.interactions.comment ?? 0).toBe(0);
      expect(outcome.anomalies.length).toBeGreaterThan(0);
    },
  );

  it("releases unattempted comment claims when a queued run is cancelled", async () => {
    const gate = deferred();
    const f = await fixture(async () => {
      await gate.promise;
      return result();
    });
    const draft = await f.approve();
    const comment = await f.service.createCommentRun({
      projectId: f.project.id,
      accountId: f.account.id,
    });
    const browsing = await f.create();
    try {
      await f.service.startRun(browsing.id);
      await f.service.startRun(comment.id);
      await f.service.cancelRun(comment.id);
      expect(await f.store.getComment(draft.id)).toMatchObject({
        status: "approved",
        sentRunId: null,
      });
    } finally {
      gate.release();
      await f.service.waitForRun(browsing.id);
    }
  });
});
