import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DeviceExecuteTaskBody,
  DeviceInfo,
  XhsOpsRunPlan,
} from "@nexu/shared";
import { afterAll, describe, expect, it } from "vitest";
import { XhsOpsCommentService } from "../src/services/xhs-ops-comment-service.js";
import {
  XhsOpsRunService,
  buildRunChunks,
  commentTaskPolicy,
  interpretCommentTaskResult,
  summarizeRun,
} from "../src/services/xhs-ops-run-service.js";
import {
  buildCommentChunkTask,
  parseCommentJson,
  parseReceiptClicks,
} from "../src/services/xhs-ops-task-builder.js";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";

const tempDir = mkdtempSync(join(tmpdir(), "xhs-ops-comment-run-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

const TEXT = "儿童用品齐全太省心";

describe("comment task template + COMMENT_JSON (P3-1 D2)", () => {
  it("task text carries the approved text verbatim, the search-by-title step and the JSON contract", () => {
    const t = buildCommentChunkTask({
      label: "豆豆妈",
      positioning: "周末遛娃",
      persona: "32岁·女·北京",
      postTitle: "亲子房天花板！带娃住这太省事",
      postAuthor: "满哥铛弟",
      text: TEXT,
    });
    expect(t).toContain(
      "【小红书评论任务｜账号定位：豆豆妈｜人设：32岁·女·北京｜周末遛娃】",
    );
    expect(t).toContain(`   ${TEXT}`);
    expect(t).toContain("TYPE 输入笔记标题「亲子房天花板！带娃住这太省事」");
    expect(t).toContain("post_not_found");
    expect(t).toContain("COMMENT_JSON:");
    expect(t).toContain("禁止：改写文案");
  });

  it("parseCommentJson is lenient; parseReceiptClicks reads the xhs count", () => {
    expect(
      parseCommentJson(
        '评论已发出。\\nCOMMENT_JSON:{"v":1,"status":"sent","detail":"评论区已出现"}\\n[回执] 各应用生效点击: com.xingin.xhs=6',
      ),
    ).toEqual({ status: "sent", detail: "评论区已出现", anomalies: [] });
    expect(
      parseCommentJson(
        'COMMENT_JSON:{"status":"weird","anomalies":["rate_limited",{"type":"other","detail":"x"}]}',
      ),
    ).toEqual({
      status: "skipped",
      detail: "",
      anomalies: [
        { type: "rate_limited", detail: "" },
        { type: "other", detail: "x" },
      ],
    });
    expect(parseCommentJson("no marker")).toBeNull();
    expect(
      parseReceiptClicks(
        "...\n[回执] 各应用生效点击: com.xingin.xhs=6, com.hihonor.launcher=1",
        "com.xingin.xhs",
      ),
    ).toBe(6);
    expect(
      parseReceiptClicks(
        "[回执] 各应用生效点击: com.other=2",
        "com.xingin.xhs",
      ),
    ).toBe(0);
    expect(parseReceiptClicks("no receipt", "com.xingin.xhs")).toBeNull();
  });

  it("interpretCommentTaskResult: sent needs a non-zero receipt; failed/skipped/missing map to chunk statuses", () => {
    const sent = interpretCommentTaskResult({
      taskId: "t",
      success: true,
      message:
        'ok\nCOMMENT_JSON:{"status":"sent","detail":"已出现"}\n[回执] 各应用生效点击: com.xingin.xhs=5',
    });
    expect(sent).toMatchObject({ status: "completed", observation: "已出现" });
    expect(sent.interactions.comment).toBe(1);

    const fake = interpretCommentTaskResult({
      taskId: "t",
      success: true,
      message:
        'COMMENT_JSON:{"status":"sent"}\n[回执] 各应用生效点击: com.xingin.xhs=0',
    });
    expect(fake.status).toBe("failed");
    expect(fake.anomalies[0]?.detail).toContain("待核验");

    const failed = interpretCommentTaskResult({
      taskId: "t",
      success: true,
      message:
        'COMMENT_JSON:{"status":"failed","detail":"提示操作频繁","anomalies":[{"type":"rate_limited","detail":"操作过于频繁"}]}',
    });
    expect(failed).toMatchObject({ status: "failed", error: "提示操作频繁" });
    expect(failed.anomalies.map((a) => a.type)).toEqual(["rate_limited"]);

    const skipped = interpretCommentTaskResult({
      taskId: "t",
      success: true,
      message: 'COMMENT_JSON:{"status":"skipped","detail":"帖子搜不到"}',
    });
    expect(skipped).toMatchObject({ status: "skipped", error: "帖子搜不到" });

    const missing = interpretCommentTaskResult({
      taskId: "t",
      success: false,
      message: "Task reached maximum steps",
    });
    expect(missing.status).toBe("failed");
    expect(missing.anomalies[0]?.detail).toContain("COMMENT_JSON");
  });

  it("comment plans become one chunk per comment; summaries count comments, not posts", () => {
    const plan: XhsOpsRunPlan = {
      kind: "comment",
      keywords: [],
      homeFeedCount: 0,
      dwellSecMin: 10,
      dwellSecMax: 20,
      interaction: {
        like: { enabled: false, dailyCap: 0, ratioPercent: 0 },
        collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
        follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
        comment: { enabled: true, dailyCap: 2 },
      },
      comments: [
        { draftId: "d1", postTitle: "A", postAuthor: "a", text: TEXT },
        {
          draftId: "d2",
          postTitle: "B",
          postAuthor: "b",
          text: "娃玩得很开心",
        },
      ],
    };
    const chunks = buildRunChunks(plan);
    expect(
      chunks.map((c) => [c.mode, c.commentDraftId, c.plannedCount]),
    ).toEqual([
      ["comment", "d1", 1],
      ["comment", "d2", 1],
    ]);
    const done = chunks.map((c, i) => ({
      ...c,
      status: "completed" as const,
      interactions: {
        like: 0,
        collect: 0,
        follow: 0,
        comment: i === 0 ? 1 : 0,
      },
    }));
    const summary = summarizeRun(done, null, null);
    expect(summary).toMatchObject({ plannedTotal: 0, browsedTotal: 0 });
    expect(summary.interactions.comment).toBe(1);
    expect(commentTaskPolicy(TEXT)).toMatchObject({
      confirmationPolicy: {
        publish: "forbidden",
        payment: "forbidden",
        comment: "allowed",
      },
      commentAllowlist: [TEXT],
    });
  });
});

describe("XhsOpsRunService.createCommentRun + execution", () => {
  const interaction = {
    like: { enabled: false, dailyCap: 0, ratioPercent: 0 },
    collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
    follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
    comment: { enabled: true, dailyCap: 2 },
  };

  async function seed(file: string) {
    const store = new XhsOpsStore(join(tempDir, file));
    const project = await store.createProject({ name: "评论执行" });
    const account = await store.createAccount({
      projectId: project.id,
      label: "豆豆妈",
      deviceId: "dev-1",
      deviceName: "dev-1",
      interaction,
    });
    await store.createRun({
      projectId: project.id,
      accountId: account.id,
      deviceId: "dev-1",
      accountLabel: account.label,
      date: "2026-09-06",
      status: "completed",
      plan: {
        keywords: [{ keyword: "k", count: 8 }],
        homeFeedCount: 8,
        dwellSecMin: 10,
        dwellSecMax: 20,
        interaction,
      },
      segment: null,
      queuedBehindRunId: null,
      chunks: [],
      notes: "",
      error: null,
      startedAt: new Date(2026, 8, 6, 12).toISOString(),
      completedAt: new Date(2026, 8, 6, 13).toISOString(),
      summary: {
        plannedTotal: 16,
        browsedTotal: 16,
        searchBrowsed: 8,
        homeBrowsed: 8,
        interactions: { like: 0, collect: 0, follow: 0 },
        anomalyCount: 0,
        durationMs: 1000,
      },
    });
    const draft = async (
      title: string,
      text: string,
      status: "approved" | "pending" = "approved",
    ) =>
      store.createComment({
        projectId: project.id,
        accountId: account.id,
        deviceId: "dev-1",
        sourceRunId: "r0",
        sourceChunkIndex: 0,
        sourcePostIndex: 0,
        post: { title, author: "作者", summary: "" },
        candidates: [text],
        text: status === "approved" ? text : null,
        status,
        reviewedAt:
          status === "approved" ? new Date(2026, 8, 6, 13).toISOString() : null,
        reviewNote: "",
        sentRunId: null,
        sentAt: null,
        sendResult: null,
      });
    return { store, project, account, draft };
  }

  it("respects the time window and the 10-minute gap after browsing", async () => {
    const { store, project, account, draft } = await seed("window.json");
    await draft("A", TEXT);
    let now = new Date(2026, 8, 6, 23, 30).getTime(); // 23:30 → 窗口外
    const svc = new XhsOpsRunService({
      store,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async () => {
          throw new Error("unused");
        },
        cancelTask: async () => {},
      },
      options: { now: () => now },
    });
    await expect(
      svc.createCommentRun({ projectId: project.id, accountId: account.id }),
    ).rejects.toMatchObject({ status: 409 });

    now = new Date(2026, 8, 6, 14, 0).getTime();
    // 一次 5 分钟前刚结束的浏览 run
    await store.createRun({
      projectId: project.id,
      accountId: account.id,
      deviceId: "dev-1",
      accountLabel: "豆豆妈",
      date: "2026-09-06",
      status: "completed",
      plan: {
        keywords: [{ keyword: "k", count: 1 }],
        homeFeedCount: 0,
        dwellSecMin: 10,
        dwellSecMax: 20,
        interaction,
      },
      segment: null,
      queuedBehindRunId: null,
      chunks: [],
      notes: "",
      error: null,
      startedAt: null,
      completedAt: new Date(now - 5 * 60_000).toISOString(),
      summary: {
        plannedTotal: 1,
        browsedTotal: 1,
        searchBrowsed: 1,
        homeBrowsed: 0,
        interactions: { like: 0, collect: 0, follow: 0 },
        anomalyCount: 0,
        durationMs: 1,
      },
    });
    await expect(
      svc.createCommentRun({ projectId: project.id, accountId: account.id }),
    ).rejects.toMatchObject({ status: 409 });

    now += 6 * 60_000; // 11 分钟后可以
    const run = await svc.createCommentRun({
      projectId: project.id,
      accountId: account.id,
    });
    expect(run.plan.kind).toBe("comment");
    expect(run.chunks).toHaveLength(1);
    expect(
      (await store.listComments({ accountId: account.id }))[0]?.sentRunId,
    ).toBe(run.id);
    // 已认领 → 再建一个没有可发的
    await expect(
      svc.createCommentRun({ projectId: project.id, accountId: account.id }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("serializes approvals per account so concurrent reviews cannot exceed quota", async () => {
    const { store, account, draft } = await seed("approval-race.json");
    await store.updateAccount(account.id, {
      interaction: {
        ...interaction,
        comment: { enabled: true, dailyCap: 1 },
      },
    });
    const first = await draft("A", "第一条", "pending");
    const second = await draft("B", "第二条", "pending");
    const service = new XhsOpsCommentService({
      store,
      media: { generateText: async () => ({ text: "" }) },
      now: () => new Date("2026-09-06T14:00:00.000Z").getTime(),
    });

    const results = await Promise.allSettled([
      service.review(first.id, { decision: "approved" }),
      service.review(second.id, { decision: "approved" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const statuses = await Promise.all(
      [first.id, second.id].map(
        async (id) => (await store.getComment(id))?.status,
      ),
    );
    expect(statuses.filter((status) => status === "approved")).toHaveLength(1);
  });

  it("executes one comment per chunk with an allowlisted policy and writes sent/failed back to the drafts", async () => {
    const { store, project, account, draft } = await seed("exec.json");
    const d1 = await draft("A 帖", TEXT);
    const d2 = await draft("B 帖", "娃玩得很开心");
    await draft("待审", "不该被派", "pending");
    const bodies: DeviceExecuteTaskBody[] = [];
    const FAKE_NOW = new Date(2026, 8, 6, 15, 0).getTime();
    const svc = new XhsOpsRunService({
      store,
      deviceControl: {
        // lastSeen 要用同一个假时钟，否则 waitForIdle 会把设备判成离线
        getDevice: async (id: string) =>
          ({ deviceId: id, status: "idle", lastSeen: FAKE_NOW }) as DeviceInfo,
        executeTask: async (_id: string, body: DeviceExecuteTaskBody) => {
          bodies.push(body);
          const first = bodies.length === 1;
          return {
            result: {
              taskId: `t${bodies.length}`,
              success: true,
              message: first
                ? 'ok\nCOMMENT_JSON:{"status":"sent","detail":"评论区已出现"}\n[回执] 各应用生效点击: com.xingin.xhs=7'
                : 'x\nCOMMENT_JSON:{"status":"failed","detail":"提示操作频繁","anomalies":[{"type":"rate_limited","detail":"操作过于频繁"}]}\n[回执] 各应用生效点击: com.xingin.xhs=3',
            },
          };
        },
        cancelTask: async () => {},
      },
      options: { idlePollIntervalMs: 5, now: () => FAKE_NOW },
    });
    const run = await svc.createCommentRun({
      projectId: project.id,
      accountId: account.id,
    });
    // 两条草稿同毫秒创建，chunk 顺序不作假设：按草稿 id 对应
    expect(new Set(run.chunks.map((c) => c.commentDraftId))).toEqual(
      new Set([d1.id, d2.id]),
    );
    const firstDraftId = run.chunks[0]?.commentDraftId as string;
    const firstText = firstDraftId === d1.id ? TEXT : "娃玩得很开心";
    const secondText = firstDraftId === d1.id ? "娃玩得很开心" : TEXT;
    await svc.startRun(run.id);
    await svc.waitForRun(run.id);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.taskPolicy?.confirmationPolicy?.comment).toBe("allowed");
    expect(bodies[0]?.taskPolicy?.commentAllowlist).toEqual([firstText]);
    expect(bodies[0]?.task).toContain(firstText);
    expect(bodies[1]?.taskPolicy?.commentAllowlist).toEqual([secondText]);

    const done = await store.getRun(run.id);
    expect(done?.status).toBe("failed"); // rate_limited 是安全停机类型
    expect(done?.chunks.map((c) => c.status)).toEqual(["completed", "failed"]);
    expect(done?.summary.interactions.comment).toBe(1);
    const drafts = await store.listComments({ accountId: account.id });
    const byId = new Map(drafts.map((d) => [d.id, d]));
    const failedId = firstDraftId === d1.id ? d2.id : d1.id;
    expect(byId.get(firstDraftId)).toMatchObject({
      status: "sent",
      sentRunId: run.id,
      sendResult: "评论区已出现",
    });
    expect(byId.get(firstDraftId)?.sentAt).not.toBeNull();
    expect(byId.get(failedId)).toMatchObject({
      status: "failed",
      sendResult: "提示操作频繁",
    });
  });
});
