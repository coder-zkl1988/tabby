import {
  type XhsOpsAccount,
  type XhsOpsRun,
  xhsOpsInterestWordCount,
  xhsOpsPlanBudgetIssues,
  xhsOpsProfileDraftSchema,
  xhsOpsSegmentBudgetIssues,
  xhsOpsToneGuideSchema,
} from "@nexu/shared";
import { describe, expect, it } from "vitest";
import {
  homeFeedFromRatio,
  suggestDailyPlans,
  suggestPlan,
} from "../src/services/xhs-ops-plan-suggest.js";
import {
  chunkMaxSteps,
  computeChunkQuota,
} from "../src/services/xhs-ops-run-service.js";

function account(overrides: Partial<XhsOpsAccount> = {}): XhsOpsAccount {
  return {
    id: "acct-1",
    projectId: "p1",
    entryMode: "new",
    label: "豆豆妈的周末计划",
    positioning: "",
    persona: {
      age: "",
      gender: "",
      region: "",
      occupation: "",
      lifeStatus: "",
    },
    personaTags: { general: [], vertical: [] },
    personaReviewedAt: null,
    personaReviewNote: null,
    platformAccountId: "",
    profileDraft: xhsOpsProfileDraftSchema.parse({}),
    deviceId: "dev-1",
    deviceName: "dev",
    interestPool: {
      core: ["亲子酒店", "周末遛娃", "带娃攻略", "周边游"],
      extended: ["亲子旅行", "北京周边游"],
      general: ["咖啡", "摄影", "家居"],
    },
    interaction: {
      like: { enabled: true, dailyCap: 5, ratioPercent: 10 },
      collect: { enabled: false, dailyCap: 2, ratioPercent: 3 },
      follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
      comment: { enabled: false, dailyCap: 0 },
    },
    browseDefaults: {
      dwellSecMin: 10,
      dwellSecMax: 25,
      searchRatioPercent: 80,
      postsPerKeyword: 5,
      homeFeedCount: 6,
      dailyTargetPosts: 0,
      dailySegments: 1,
    },
    takeover: null,
    toneGuide: xhsOpsToneGuideSchema.parse({}),
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

function runWith(keywords: string[]): XhsOpsRun {
  return {
    plan: {
      keywords: keywords.map((k) => ({ keyword: k, count: 5 })),
      homeFeedCount: 5,
      dwellSecMin: 10,
      dwellSecMax: 25,
      interaction: account().interaction,
    },
  } as unknown as XhsOpsRun;
}

describe("suggestPlan (P1-4 当日计划确定性生成)", () => {
  it("round 1 takes the first three core words plus one extended and one general", () => {
    const s = suggestPlan(account(), []);
    expect(s.keywords.map((k) => k.keyword)).toEqual([
      "亲子酒店",
      "周末遛娃",
      "带娃攻略",
      "亲子旅行",
      "咖啡",
    ]);
    expect(s.keywords.every((k) => k.count === 5)).toBe(true);
    // 搜索 25 篇、占比 80% → 首页 round(25*0.2/0.8)=6
    expect(s.homeFeedCount).toBe(6);
    expect(s.rationale[0]).toContain("第 1 轮");
  });

  it("rotates core words by round so consecutive days differ", () => {
    const day1 = suggestPlan(account(), []);
    const day2 = suggestPlan(account(), [
      runWith(day1.keywords.map((k) => k.keyword)),
    ]);
    expect(day2.keywords.map((k) => k.keyword)).not.toEqual(
      day1.keywords.map((k) => k.keyword),
    );
    expect(day2.keywords.map((k) => k.keyword).slice(0, 3)).toEqual([
      "周末遛娃",
      "带娃攻略",
      "周边游",
    ]);
  });

  it("shifts one more step when rotation would repeat the previous run exactly", () => {
    // 4 个核心词、每轮取 3：第 4 轮 offset=0 会回到第 1 轮集合；上一轮若恰好是同一集合则前移
    const acct = account();
    const prev = runWith(["亲子酒店", "周末遛娃", "带娃攻略"]);
    const s = suggestPlan(acct, [prev, prev, prev, prev]); // round=4 → offset 0 → 与 prev 相同 → 前移
    expect(s.keywords.map((k) => k.keyword).slice(0, 3)).toEqual([
      "周末遛娃",
      "带娃攻略",
      "周边游",
    ]);
    expect(s.rationale).toContain("与上一轮关键词完全相同，核心词前移一位");
  });

  it("derives the home-feed count from searchRatioPercent", () => {
    expect(homeFeedFromRatio(20, 80, 6)).toBe(5);
    expect(homeFeedFromRatio(20, 100, 6)).toBe(0);
    expect(homeFeedFromRatio(20, 50, 6)).toBe(12); // 20 → clamp 12
    expect(homeFeedFromRatio(20, 0, 6)).toBe(6); // 无占比 → 回退账号默认
    const s = suggestPlan(
      account({
        browseDefaults: {
          dwellSecMin: 10,
          dwellSecMax: 25,
          searchRatioPercent: 100,
          postsPerKeyword: 5,
          homeFeedCount: 6,
          dailyTargetPosts: 0,
          dailySegments: 1,
        },
      }),
      [],
    );
    expect(s.homeFeedCount).toBe(0);
  });

  it("empty interest pool yields no keywords and says so", () => {
    const s = suggestPlan(
      account({ interestPool: { core: [], extended: [], general: [] } }),
      [],
    );
    expect(s.keywords).toEqual([]);
    expect(s.rationale[0]).toContain("核心兴趣池为空");
  });
});

describe("computeChunkQuota with ratioPercent (P1-4 触发比例生效)", () => {
  const config = account().interaction;
  it("unlocks the ratio budget from cumulative planned posts without per-chunk ceil inflation", () => {
    const first = computeChunkQuota(
      config,
      { like: 0, collect: 0, follow: 0 },
      4,
      5,
    );
    const second = computeChunkQuota(
      config,
      { like: 0, collect: 0, follow: 0 },
      4,
      10,
    );
    expect(first.like).toMatchObject({ enabled: false, max: 0 });
    expect(second.like).toMatchObject({ enabled: true, max: 1 });
  });
  it("ratio 0 disables interaction for the chunk even when enabled", () => {
    const zero = {
      ...config,
      like: { enabled: true, dailyCap: 5, ratioPercent: 0 },
    };
    expect(
      computeChunkQuota(zero, { like: 0, collect: 0, follow: 0 }, 2, 5).like,
    ).toMatchObject({ enabled: false, max: 0 });
  });
  it("without plannedCount the legacy share/remaining rule still applies", () => {
    expect(
      computeChunkQuota(config, { like: 4, collect: 0, follow: 0 }, 4).like,
    ).toMatchObject({ enabled: true, max: 1 });
  });
});

describe("suggestDailyPlans (P2-3 当日容量拆分，可选能力)", () => {
  const browse = account().browseDefaults;
  it("single segment (default) is exactly suggestPlan with segment=null", () => {
    const plans = suggestDailyPlans(account(), [], "2026-09-05");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.segment).toBeNull();
    expect(plans[0]?.keywords).toEqual(suggestPlan(account(), []).keywords);
  });

  it("dailySegments=2 yields two serial segments with rotated keyword sets sized from the daily target", () => {
    const acct = account({
      browseDefaults: { ...browse, dailyTargetPosts: 40, dailySegments: 2 },
    });
    const plans = suggestDailyPlans(acct, [], "2026-09-05");
    expect(plans.map((p) => p.segment)).toEqual([
      { index: 1, count: 2 },
      { index: 2, count: 2 },
    ]);
    const words = plans.map((p) => p.keywords.map((k) => k.keyword).join(","));
    expect(words[0]).not.toBe(words[1]); // 第 2 段视作下一轮，核心词轮换
    for (const p of plans) {
      // 40 ÷ 2 = 20 篇/段；搜索占比 80% → 搜索 16（4+3+3+3+3）+ 首页 4。
      expect(p.keywords.map((k) => k.count)).toEqual([4, 3, 3, 3, 3]);
      expect(p.homeFeedCount).toBe(4);
      expect(
        p.keywords.reduce((n, k) => n + k.count, 0) + p.homeFeedCount,
      ).toBe(20);
      expect(p.rationale[0]).toContain("第 ");
      expect(p.rationale.join(" ")).toContain("日目标 40 篇 ÷ 2 段");
    }
  });

  it("fills the default 90-post daily target exactly across two segments", () => {
    const acct = account({
      browseDefaults: { ...browse, dailyTargetPosts: 90, dailySegments: 2 },
    });

    const plans = suggestDailyPlans(acct, [], "2026-09-05");

    expect(
      plans.map(
        (plan) =>
          plan.keywords.reduce((sum, keyword) => sum + keyword.count, 0) +
          plan.homeFeedCount,
      ),
    ).toEqual([45, 45]);
    expect(plans.every((plan) => plan.homeFeedCount === 9)).toBe(true);
  });

  it("uses additional interest words when the configured search target needs them", () => {
    const acct = account({
      browseDefaults: {
        ...browse,
        dailyTargetPosts: 96,
        dailySegments: 2,
        searchRatioPercent: 100,
      },
    });

    const plans = suggestDailyPlans(acct, [], "2026-09-05");

    expect(plans[0]?.keywords).toHaveLength(6);
    expect(
      plans[0]?.keywords.reduce((sum, keyword) => sum + keyword.count, 0),
    ).toBe(48);
  });

  it("rejects a target that cannot fit instead of silently planning fewer posts", () => {
    const acct = account({
      interestPool: { core: ["亲子酒店"], extended: [], general: [] },
      browseDefaults: { ...browse, dailyTargetPosts: 90, dailySegments: 2 },
    });

    expect(() => suggestDailyPlans(acct, [], "2026-09-05")).toThrow(
      "请补充兴趣池或增加每日分段",
    );
    expect(() =>
      suggestDailyPlans(
        account({
          browseDefaults: {
            ...browse,
            dailyTargetPosts: 90,
            dailySegments: 2,
            searchRatioPercent: 0,
          },
        }),
        [],
        "2026-09-05",
      ),
    ).toThrow("请提高搜索占比或增加每日分段");
  });

  it("skips segments already planned/running/completed today; cancelled, failed and interrupted stay open", () => {
    const acct = account({
      browseDefaults: { ...browse, dailyTargetPosts: 0, dailySegments: 3 },
    });
    const ran = (index: number, status: string, date = "2026-09-05") =>
      ({
        ...runWith(["亲子酒店"]),
        date,
        status,
        segment: { index, count: 3 },
      }) as unknown as XhsOpsRun;
    const plans = suggestDailyPlans(
      acct,
      [
        ran(3, "failed"),
        ran(2, "cancelled"),
        ran(1, "completed"),
        ran(1, "completed", "2026-09-04"),
      ],
      "2026-09-05",
    );
    expect(plans.map((p) => p.segment?.index)).toEqual([2, 3]);
    // 目标为 0 时每词沿用 postsPerKeyword
    expect(plans[0]?.keywords.every((k) => k.count === 5)).toBe(true);
  });

  it("a daily target without segments resizes the single run", () => {
    const acct = account({
      browseDefaults: { ...browse, dailyTargetPosts: 30, dailySegments: 1 },
    });
    const [plan] = suggestDailyPlans(acct, [], "2026-09-05");
    // 30 篇 × 80% = 24 搜索（5+5+5+5+4）+ 首页 6。
    expect(plan?.segment).toBeNull();
    expect(plan?.keywords.map((k) => k.count)).toEqual([5, 5, 5, 5, 4]);
    expect(plan?.homeFeedCount).toBe(6);
    expect(plan?.rationale.join(" ")).toContain("本次目标 30 篇");
  });

  it("keeps an odd daily target exact across segments instead of rounding every segment up", () => {
    const acct = account({
      browseDefaults: { ...browse, dailyTargetPosts: 41, dailySegments: 2 },
    });

    const plans = suggestDailyPlans(acct, [], "2026-09-05");
    const totals = plans.map(
      (plan) =>
        plan.keywords.reduce((sum, keyword) => sum + keyword.count, 0) +
        plan.homeFeedCount,
    );

    expect(totals).toEqual([21, 20]);
    expect(totals.reduce((sum, total) => sum + total, 0)).toBe(41);
  });

  it("supports home-only at 0% and search-only at 100%", () => {
    const atRatio = (searchRatioPercent: number) =>
      suggestDailyPlans(
        account({
          browseDefaults: {
            ...browse,
            dailyTargetPosts: 10,
            searchRatioPercent,
          },
        }),
        [],
        "2026-09-05",
      )[0];

    expect(atRatio(0)).toMatchObject({ keywords: [], homeFeedCount: 10 });
    expect(atRatio(100)).toMatchObject({ homeFeedCount: 0 });
    expect(
      atRatio(100)?.keywords.reduce((sum, keyword) => sum + keyword.count, 0),
    ).toBe(10);
  });

  it("does not move an unfillable search budget into the home-feed budget", () => {
    expect(() =>
      suggestDailyPlans(
        account({
          interestPool: { core: ["亲子酒店"], extended: [], general: [] },
          browseDefaults: { ...browse, dailyTargetPosts: 20 },
        }),
        [],
        "2026-09-05",
      ),
    ).toThrow("本段搜索目标 16 篇至少需要 2 个兴趣词");
  });

  it("chunkMaxSteps gives home-feed chunks more headroom than search, capped at the phone's 100", () => {
    expect(chunkMaxSteps(4)).toBe(60);
    expect(chunkMaxSteps(4, "search")).toBe(60);
    expect(chunkMaxSteps(4, "home")).toBe(78);
    expect(chunkMaxSteps(6, "home")).toBe(100);
    expect(chunkMaxSteps(12, "home")).toBe(100);
    expect(chunkMaxSteps(8, "search")).toBe(100);
  });
});

describe("xhsOpsPlanBudgetIssues agrees with plan-suggest (takeover §2.5)", () => {
  const browse = account().browseDefaults;
  // Duplicates across layers and padded copies must not count twice.
  const words = ["亲子酒店", "周末遛娃", "带娃攻略", "周边游", "亲子旅行"];
  const extra = ["北京周边游", "咖啡", "摄影", "家居", "露营"];
  function pool(size: number): XhsOpsAccount["interestPool"] {
    const distinct = [...words, ...extra].slice(0, size);
    return {
      core: distinct.slice(0, 4),
      extended: [...distinct.slice(4, 7), ...distinct.slice(0, 1)],
      general: [...distinct.slice(7), ` ${distinct[0] ?? ""} `, ""],
    };
  }

  function planError(acct: XhsOpsAccount): string | null {
    try {
      suggestDailyPlans(acct, [], "2026-09-05");
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it("rejects exactly the configs plan-suggest rejects, with its first message", () => {
    let rejected = 0;
    for (const target of [
      0, 1, 13, 25, 29, 31, 40, 45, 59, 61, 89, 90, 91, 119, 150,
    ]) {
      for (const segments of [1, 2, 3]) {
        for (const ratio of [0, 33, 50, 60, 67, 70, 80, 95, 100]) {
          for (const size of [0, 1, 2, 3, 5, 8, 10]) {
            const acct = account({
              interestPool: pool(size),
              browseDefaults: {
                ...browse,
                dailyTargetPosts: target,
                dailySegments: segments,
                searchRatioPercent: ratio,
              },
            });
            const error = planError(acct);
            const issues = xhsOpsPlanBudgetIssues(
              acct.browseDefaults,
              xhsOpsInterestWordCount(acct.interestPool),
            );
            const label = `${target}/${segments}/${ratio}%/${size} words`;
            expect(issues.length > 0, label).toBe(error !== null);
            // plan-suggest stops at the first segment, which is the largest.
            if (error !== null) {
              rejected += 1;
              expect(issues[0], label).toBe(error);
            }
          }
        }
      }
    }
    expect(rejected).toBeGreaterThan(0);
  });

  it("raises the shared segment check's own message as its 409 (§2.5)", () => {
    const acct = account({
      interestPool: { core: ["亲子酒店"], extended: [], general: [] },
      browseDefaults: {
        ...browse,
        dailyTargetPosts: 41,
        dailySegments: 2,
        searchRatioPercent: 80,
      },
    });
    // The first of the two segments takes the remainder: 21 posts, 17 of them searched.
    const [issue] = xhsOpsSegmentBudgetIssues(21, 80, 1);
    expect(issue).toBe(
      "本段搜索目标 17 篇至少需要 3 个兴趣词，当前只有 1 个，请补充兴趣池或增加每日分段",
    );
    let thrown: unknown = null;
    try {
      suggestDailyPlans(acct, [], "2026-09-05");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ status: 409, message: issue });
  });

  it("counts the words plan-suggest can draw on", () => {
    expect(xhsOpsInterestWordCount(pool(3))).toBe(3);
    expect(xhsOpsInterestWordCount(pool(10))).toBe(8);
  });

  it("fails an odd target on its larger first segment even when the second would fit", () => {
    // 25 / 2 at 0% search: segments of 13 and 12 home posts; only 12 fits.
    const acct = account({
      interestPool: pool(0),
      browseDefaults: {
        ...browse,
        dailyTargetPosts: 25,
        dailySegments: 2,
        searchRatioPercent: 0,
      },
    });
    expect(planError(acct)).toBe(
      "本段首页目标 13 篇超过上限 12，请提高搜索占比或增加每日分段",
    );
    expect(xhsOpsPlanBudgetIssues(acct.browseDefaults, 0)).toEqual([
      "本段首页目标 13 篇超过上限 12，请提高搜索占比或增加每日分段",
    ]);
  });
});
