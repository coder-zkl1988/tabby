import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type XhsOpsAccount,
  type XhsOpsCommentDraft,
  type XhsOpsRun,
  xhsOpsToneGuideSchema,
} from "@nexu/shared";
import { afterAll, describe, expect, it } from "vitest";
import {
  XhsOpsCommentService,
  buildCommentPrompt,
  computeCommentQuota,
  parseCandidates,
  validateCommentText,
} from "../src/services/xhs-ops-comment-service.js";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";

const tempDir = mkdtempSync(join(tmpdir(), "xhs-ops-comments-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

describe("validateCommentText (评审规则：≤10 字、正向、无营销)", () => {
  it("accepts short on-topic text and rejects the rule violations with a reason", () => {
    expect(validateCommentText("儿童用品齐全太省心")).toBeNull();
    expect(validateCommentText("这家泳池真不错👍")).toBeNull();
    expect(validateCommentText("好")).toBe("太短");
    expect(validateCommentText("这家酒店的亲子房间真的很不错啊")).toContain(
      "超过 10 字",
    );
    expect(validateCommentText("加微信聊")).toContain("营销/引流");
    expect(validateCommentText("多少钱一晚")).toContain("营销/引流");
    expect(validateCommentText("看主页有攻略")).toContain("营销/引流");
    expect(validateCommentText("热玛吉真香", ["热玛吉", "医美"])).toContain(
      "禁忌方向",
    );
    expect(validateCommentText("太棒了👍👍")).toBe("表情最多 1 个");
    expect(validateCommentText("！！！")).toBe("只有符号");
    expect(validateCommentText("好看\n真好看")).toBe("不能换行");
  });
});

describe("parseCandidates", () => {
  it("prefers the JSON payload and falls back to numbered lines", () => {
    expect(
      parseCandidates('好的：{"candidates":["A 候选","B 候选","A 候选"]} 完'),
    ).toEqual(["A 候选", "B 候选"]);
    expect(parseCandidates("1. 第一条\n2、第二条\n- 第三条\n")).toEqual([
      "第一条",
      "第二条",
      "第三条",
    ]);
    expect(parseCandidates('"带引号的"')).toEqual(["带引号的"]);
  });
});

function account(overrides: Partial<XhsOpsAccount> = {}): XhsOpsAccount {
  return {
    id: "a1",
    projectId: "p1",
    entryMode: "new",
    label: "豆豆妈",
    positioning: "周末遛娃",
    persona: {
      age: "32岁",
      gender: "女",
      region: "北京",
      occupation: "产品经理",
      lifeStatus: "2岁娃妈",
    },
    personaTags: { general: [], vertical: [] },
    personaReviewedAt: null,
    personaReviewNote: null,
    platformAccountId: "",
    profileDraft: {} as never,
    deviceId: "dev-1",
    deviceName: "dev-1",
    interestPool: { core: ["亲子酒店"], extended: [], general: [] },
    interaction: {
      like: { enabled: false, dailyCap: 0, ratioPercent: 0 },
      collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
      follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
      comment: { enabled: true, dailyCap: 2 },
    },
    browseDefaults: {} as never,
    takeover: null,
    toneGuide: xhsOpsToneGuideSchema.parse({}),
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

function run(browsed: number, date = "2026-09-06"): XhsOpsRun {
  return {
    accountId: "a1",
    date,
    summary: { browsedTotal: browsed },
  } as unknown as XhsOpsRun;
}

function draft(
  status: XhsOpsCommentDraft["status"],
  sentAt: string | null = null,
): XhsOpsCommentDraft {
  return {
    accountId: "a1",
    status,
    sentAt,
    createdAt: "2026-09-06T01:00:00.000Z",
  } as unknown as XhsOpsCommentDraft;
}

describe("computeCommentQuota (min(dailyCap, 5, floor(浏览/8)) − 已发 − 已批未发)", () => {
  it("scales with today's browsing and honours the switch and the hard cap", () => {
    expect(
      computeCommentQuota({
        account: account(),
        date: "2026-09-06",
        runs: [run(7)],
        drafts: [],
      }),
    ).toMatchObject({ byBrowse: 0, cap: 0, remaining: 0 });
    expect(
      computeCommentQuota({
        account: account(),
        date: "2026-09-06",
        runs: [run(20), run(5, "2026-09-05")],
        drafts: [],
      }),
    ).toMatchObject({ todayBrowsed: 20, byBrowse: 2, cap: 2, remaining: 2 });
    expect(
      computeCommentQuota({
        account: account({
          interaction: {
            ...account().interaction,
            comment: { enabled: true, dailyCap: 5 },
          },
        }),
        date: "2026-09-06",
        runs: [run(80)],
        drafts: [
          draft("sent", "2026-09-06T02:00:00.000Z"),
          draft("sent", "2026-09-05T02:00:00.000Z"),
          draft("approved"),
          draft("rejected"),
        ],
      }),
    ).toMatchObject({
      byBrowse: 10,
      cap: 5,
      sentToday: 1,
      approvedPending: 1,
      remaining: 3,
    });
    expect(
      computeCommentQuota({
        account: account({
          interaction: {
            ...account().interaction,
            comment: { enabled: false, dailyCap: 2 },
          },
        }),
        date: "2026-09-06",
        runs: [run(40)],
        drafts: [],
      }),
    ).toMatchObject({ enabled: false, cap: 0, remaining: 0 });
  });
});

describe("XhsOpsCommentService", () => {
  it("prompt carries persona, post summary, the 10-char rule and forbidden topics", async () => {
    const store = new XhsOpsStore(join(tempDir, "prompt.json"));
    const project = await store.createProject({
      name: "P",
      opsNotes: {
        forbiddenTopics: ["医美"],
        boostKeywords: [],
        avoidContentTypes: [],
      },
    });
    const prompt = buildCommentPrompt({
      project,
      account: account({ projectId: project.id }),
      post: {
        title: "亲子房天花板",
        author: "满哥",
        summary: "儿童洗漱用品齐全",
      },
    });
    expect(prompt).toContain("32岁·女·北京");
    expect(prompt).toContain("儿童洗漱用品齐全");
    expect(prompt).toContain("≤10 字");
    expect(prompt).toContain("医美");
    expect(prompt).toContain('{"candidates"');
  });

  it("adds the takeover tone guide's comment style as one line, and nothing without one (§6.5, #11)", async () => {
    const store = new XhsOpsStore(join(tempDir, "tone.json"));
    const project = await store.createProject({
      name: "P",
      opsNotes: {
        forbiddenTopics: ["医美"],
        boostKeywords: [],
        avoidContentTypes: [],
      },
    });
    const post = { title: "亲子房天花板", author: "满哥", summary: "" };
    const plain = buildCommentPrompt({
      project,
      account: account({ projectId: project.id }),
      post,
    });
    expect(plain).not.toContain("评论语气");
    const toned = buildCommentPrompt({
      project,
      account: account({
        projectId: project.id,
        toneGuide: xhsOpsToneGuideSchema.parse({
          commentStyle: "像朋友一样聊，\n多用短句",
        }),
      }),
      post,
    });
    const lines = toned.split("\n");
    expect(lines.filter((line) => line.includes("评论语气"))).toEqual([
      "评论语气（账号调性指南）：像朋友一样聊， 多用短句",
    ]);
    // Everything else is the prompt it was, rules and forbidden topics included.
    expect(lines.filter((line) => !line.includes("评论语气"))).toEqual(
      plain.split("\n"),
    );
    // The hard rules still decide what may be sent.
    expect(validateCommentText("像朋友一样聊多用短句真好")).toContain(
      "超过 10 字",
    );
    expect(
      buildCommentPrompt({
        project,
        account: account({
          projectId: project.id,
          toneGuide: xhsOpsToneGuideSchema.parse({ commentStyle: "   " }),
        }),
        post,
      }),
    ).toBe(plain);
  });

  it("generateForRun keeps only valid, unused candidates and still creates an empty draft when all fail", async () => {
    const store = new XhsOpsStore(join(tempDir, "gen.json"));
    const project = await store.createProject({ name: "P" });
    const acct = await store.createAccount({
      projectId: project.id,
      label: "豆豆妈",
      deviceId: "dev-1",
      interaction: account().interaction,
    });
    const mkRun = () =>
      store.createRun({
        projectId: project.id,
        accountId: acct.id,
        deviceId: "dev-1",
        accountLabel: acct.label,
        date: "2026-09-06",
        status: "completed",
        plan: {
          keywords: [{ keyword: "亲子酒店", count: 2 }],
          homeFeedCount: 0,
          dwellSecMin: 10,
          dwellSecMax: 20,
          interaction: acct.interaction,
        },
        segment: null,
        queuedBehindRunId: null,
        notes: "",
        error: null,
        startedAt: null,
        completedAt: null,
        summary: {
          plannedTotal: 2,
          browsedTotal: 2,
          searchBrowsed: 2,
          homeBrowsed: 0,
          interactions: { like: 0, collect: 0, follow: 0 },
          anomalyCount: 0,
          durationMs: 1,
        },
        chunks: [
          {
            index: 0,
            mode: "search",
            keyword: "亲子酒店",
            plannedCount: 2,
            status: "completed",
            taskId: null,
            startedAt: null,
            completedAt: null,
            browsed: 2,
            skipped: 0,
            refreshCount: 0,
            interactions: { like: 0, collect: 0, follow: 0 },
            anomalies: [],
            observation: null,
            message: null,
            totalSteps: 10,
            finalScreenshot: null,
            error: null,
            posts: [
              {
                title: "A 帖",
                author: "作者A",
                action: "none",
                commentsRead: 3,
                dwellSeconds: 12,
                commentsComplete: true,
                commentWorthy: true,
                summary: "泳池很大",
              },
              {
                title: "B 帖",
                author: "作者B",
                action: "none",
                commentsRead: 3,
                dwellSeconds: 12,
                commentsComplete: true,
                commentWorthy: true,
                summary: "",
              },
            ],
          },
        ],
      });
    const r1 = await mkRun();
    const texts = [
      '{"candidates":["泳池真大娃玩疯了","加微信问价","这家泳池真大娃玩疯了太开心啦","泳池真大娃玩疯了"]}',
      "全是废话太棒了太棒了太棒了太棒了",
    ];
    let call = 0;
    const svc = new XhsOpsCommentService({
      store,
      media: { generateText: async () => ({ text: texts[call++] ?? "" }) },
      now: () => Date.parse("2026-09-06T03:00:00Z"),
    });
    const { drafts, skipped } = await svc.generateForRun(r1.id);
    expect(skipped).toEqual([]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.candidates).toEqual(["泳池真大娃玩疯了"]); // 营销词、超长、重复都被剔掉
    expect(drafts[1]?.candidates).toEqual([]);
    expect(drafts[1]?.reviewNote).toContain("全部不合规");

    // 同一 run 再生成：已有草稿全部跳过
    const again = await svc.generateForRun(r1.id);
    expect(again.drafts).toHaveLength(0);
    expect(again.skipped).toHaveLength(2);
  });

  it("review: approve needs valid text + quota, expired drafts roll over at the next listing", async () => {
    const store = new XhsOpsStore(join(tempDir, "review.json"));
    const project = await store.createProject({ name: "P" });
    const acct = await store.createAccount({
      projectId: project.id,
      label: "豆豆妈",
      deviceId: "dev-1",
      interaction: account().interaction,
    });
    // 今日浏览 16 篇 → byBrowse 2 → cap 2
    await store.createRun({
      projectId: project.id,
      accountId: acct.id,
      deviceId: "dev-1",
      accountLabel: acct.label,
      date: "2026-09-06",
      status: "completed",
      plan: {
        keywords: [{ keyword: "k", count: 8 }],
        homeFeedCount: 8,
        dwellSecMin: 10,
        dwellSecMax: 20,
        interaction: acct.interaction,
      },
      segment: null,
      queuedBehindRunId: null,
      notes: "",
      error: null,
      startedAt: null,
      completedAt: null,
      chunks: [],
      summary: {
        plannedTotal: 16,
        browsedTotal: 16,
        searchBrowsed: 8,
        homeBrowsed: 8,
        interactions: { like: 0, collect: 0, follow: 0 },
        anomalyCount: 0,
        durationMs: 1,
      },
    });
    let now = Date.parse("2026-09-06T03:00:00Z");
    const svc = new XhsOpsCommentService({
      store,
      media: { generateText: async () => ({ text: "" }) },
      now: () => now,
    });
    const seed = (title: string, createdAt = "2026-09-06T02:00:00.000Z") =>
      store
        .createComment({
          projectId: project.id,
          accountId: acct.id,
          deviceId: "dev-1",
          sourceRunId: "r",
          sourceChunkIndex: 0,
          sourcePostIndex: 0,
          post: { title, author: "x", summary: "" },
          candidates: ["泳池真大"],
          text: null,
          status: "pending",
          reviewedAt: null,
          reviewNote: "",
          sentRunId: null,
          sentAt: null,
          sendResult: null,
        })
        .then(async (d) =>
          createdAt !== d.createdAt
            ? ((await store.updateComment(d.id, (c) => ({
                ...c,
                createdAt,
              }))) ?? d)
            : d,
        );

    const d1 = await seed("一");
    const d2 = await seed("二");
    const d3 = await seed("三");
    await expect(
      svc.review(d1.id, { decision: "approved", text: "" }),
    ).rejects.toMatchObject({ status: 400 }); // 空文案但有候选 → 取候选
    const a1 = await svc.review(d1.id, { decision: "approved" });
    expect(a1).toMatchObject({ status: "approved", text: "泳池真大" });
    await expect(
      svc.review(d1.id, { decision: "rejected" }),
    ).rejects.toMatchObject({ status: 409 });
    const a2 = await svc.review(d2.id, {
      decision: "approved",
      text: "娃玩得很开心",
    });
    expect(a2.status).toBe("approved");
    await expect(
      svc.review(d3.id, { decision: "approved", text: "还想再来住" }),
    ).rejects.toMatchObject({ status: 409 }); // cap 2 用完
    const rej = await svc.review(d3.id, {
      decision: "rejected",
      note: "帖子太老",
    });
    expect(rej).toMatchObject({ status: "rejected", reviewNote: "帖子太老" });

    // 次日：昨天批准未发的过期，配额释放
    now = Date.parse("2026-09-07T02:00:00Z");
    const listed = await svc.listForProject(project.id);
    expect(listed.drafts.filter((d) => d.status === "expired")).toHaveLength(2);
    expect(listed.quotas[0]).toMatchObject({
      approvedPending: 0,
      todayBrowsed: 0,
      cap: 0,
    });
  });
});
