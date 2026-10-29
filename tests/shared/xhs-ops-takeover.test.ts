import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as shared from "../../packages/shared/src/index.js";
import { deviceInfoSchema } from "../../packages/shared/src/schemas/device-control.js";
import {
  XHS_ACCOUNT_PROFILE_MATERIAL_REQUIRED_MESSAGE,
  XHS_OPS_PLAYBOOK_CATEGORY,
  XHS_TAKEOVER_CHANGE_BUDGET,
  XHS_TAKEOVER_CHANGE_ORDER_STATUS_LABEL,
  XHS_TAKEOVER_DORMANT_REVIEW_BROWSE,
  XHS_TAKEOVER_DORMANT_REVIEW_DAYS,
  XHS_TAKEOVER_DORMANT_REVIEW_MESSAGE,
  XHS_TAKEOVER_IDENTITY_READ_TTL_MS,
  XHS_TAKEOVER_MANUAL_CHECK_AUDIT_FLAGS,
  XHS_TAKEOVER_OBSERVATION_HOURS,
  XHS_TAKEOVER_RESUME_REASON_CODES,
  XHS_TAKEOVER_TIER_CADENCE,
  type XhsOpsAccount,
  type XhsOpsAccountAudit,
  type XhsOpsHeaderCounts,
  type XhsOpsMaturityTier,
  compareXhsOpsAudits,
  xhsOpsAccountAuditSchema,
  xhsOpsAccountConflictResponseSchema,
  xhsOpsAccountCreateSchema,
  xhsOpsAccountDiagnosisSchema,
  xhsOpsAccountEntryModeLocked,
  xhsOpsAccountNurtureIssues,
  xhsOpsAccountSchema,
  xhsOpsAccountTransferSchema,
  xhsOpsAccountUpdateSchema,
  xhsOpsAlreadyLikedSkippedByDate,
  xhsOpsAuditManualCheckFlags,
  xhsOpsChangeOrderConfirmBodySchema,
  xhsOpsChangeOrderFieldCounted,
  xhsOpsChangeOrderImageBodySchema,
  xhsOpsChangeOrderMissingAcks,
  xhsOpsChangeOrderPreviousReviewWarned,
  xhsOpsChangeOrderRequiredAcks,
  xhsOpsChangeOrderSchema,
  xhsOpsChangeOrderStatusSchema,
  xhsOpsCountRange,
  xhsOpsCountSchema,
  xhsOpsFindingSchema,
  xhsOpsHeaderCountFlags,
  xhsOpsInteractionConfigSchema,
  xhsOpsInterestWordCount,
  xhsOpsLegacyExistingVerified,
  xhsOpsObservationVerdict,
  xhsOpsParseCount,
  xhsOpsPlanBudgetIssues,
  xhsOpsPlaybookResponseSchema,
  xhsOpsPlaybookRuleSchema,
  xhsOpsProfileFieldLabels,
  xhsOpsProjectSchema,
  xhsOpsProposalSchema,
  xhsOpsRunSummarySchema,
  xhsOpsSafetyPauseSchema,
  xhsOpsStoreDataSchema,
  xhsOpsTakeoverAuthorizeBodySchema,
  xhsOpsTakeoverDormantReviewDue,
  xhsOpsTakeoverEventSchema,
  xhsOpsTakeoverFieldBudgetState,
  xhsOpsTakeoverParamConflictCodeSchema,
  xhsOpsTakeoverPlanIssueSchema,
  xhsOpsTakeoverPlanIssues,
  xhsOpsTakeoverSchema,
  xhsOpsTakeoverSkippedFieldSchema,
  xhsOpsTakeoverStage,
} from "../../packages/shared/src/schemas/xhs-ops.js";
import {
  PHONE_SKILLS_BUNDLE,
  XHS_OPS_PLAYBOOK,
  XHS_OPS_PLAYBOOK_VERSION,
} from "../../packages/shared/src/xhs-ops-playbook.js";
import {
  XHS_OPS_ACCOUNT_AUDITED_EVENT,
  XHS_OPS_ACCOUNT_DIAGNOSED_EVENT,
  XHS_OPS_CHANGE_ORDER_FINISHED_EVENT,
  XHS_OPS_TAKEOVER_IDENTITY_LOCKED_EVENT,
  XHS_OPS_TAKEOVER_PLAN_CONFIRMED_EVENT,
  type XhsOpsChangeOrderFinishedEvent,
  xhsOpsAccountAuditedEvent,
  xhsOpsAccountDiagnosedEvent,
  xhsOpsChangeOrderFinishedEvent,
  xhsOpsRedactContact,
  xhsOpsTakeoverIdentityLockedEvent,
  xhsOpsTakeoverPlanConfirmedEvent,
} from "../../packages/shared/src/xhs-ops-takeover-events.js";

const NOW = "2026-10-20T08:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const project = xhsOpsProjectSchema.parse({
  id: "proj-1",
  name: "护肤项目",
  profile: { summary: "职场女性", confirmedAt: NOW, updatedAt: NOW },
  createdAt: NOW,
  updatedAt: NOW,
});

const verifiedDraft = {
  applyStatus: "applied",
  appliedAt: NOW,
  verifiedAt: NOW,
  verificationTaskId: "verify-1",
  verifiedAccountId: "xhs-123",
};

function account(overrides: Record<string, unknown> = {}): XhsOpsAccount {
  return xhsOpsAccountSchema.parse({
    id: "acct-1",
    projectId: "proj-1",
    entryMode: "existing",
    label: "接管·小米",
    platformAccountId: "xhs-123",
    deviceId: "dev-1",
    // Five distinct words: exactly what the default 90/2/80 cadence needs.
    interestPool: {
      core: ["通勤护肤", "敏感肌", "早C晚A"],
      extended: ["通勤穿搭"],
      general: ["咖啡"],
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function takeover(overrides: Record<string, unknown> = {}) {
  return xhsOpsTakeoverSchema.parse({
    authorizedAt: NOW,
    identityConfirmedAt: NOW,
    identitySource: "takeover",
    baselineAuditId: "audit-1",
    latestAuditId: "audit-1",
    activeDiagnosisId: "diag-1",
    planConfirmedAt: NOW,
    maturity: "established",
    ...overrides,
  });
}

function counts(
  following: string | null,
  followers: string | null,
  likesCollects: string | null,
): XhsOpsHeaderCounts {
  return {
    following: xhsOpsParseCount(following),
    followers: xhsOpsParseCount(followers),
    likesCollects: xhsOpsParseCount(likesCollects),
  };
}

function audit(overrides: Record<string, unknown> = {}): XhsOpsAccountAudit {
  return xhsOpsAccountAuditSchema.parse({
    id: "audit-1",
    projectId: "proj-1",
    accountId: "acct-1",
    deviceId: "dev-1",
    platformAccountId: "xhs-123",
    status: "completed",
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function homePart(
  header: XhsOpsHeaderCounts | null,
  titles: string[] = [],
  notesEnd = false,
) {
  return {
    status: "read",
    code: "ok",
    evidence: null,
    nickname: "小米的通勤日记",
    header,
    headerEnd: header,
    notesEnd,
    notes: titles.map((title, index) => ({
      i: index + 1,
      title,
      likes: xhsOpsParseCount("12"),
      video: false,
      pinned: false,
    })),
  };
}

function creatorPart(views: string | null, status = "read") {
  return {
    status,
    code: status === "read" ? "ok" : "creator_unavailable",
    evidence: null,
    nickname: "小米的通勤日记",
    header: null,
    periodLabel: "近7日",
    views: xhsOpsParseCount(views),
    interactions: xhsOpsParseCount("30"),
    newFollowers: xhsOpsParseCount("2"),
    profileVisitors: xhsOpsParseCount("10"),
    accountStatus: "正常",
  };
}

function profilePart(values: Record<string, unknown>) {
  return {
    status: "read",
    code: "ok",
    evidence: null,
    accountMatched: true,
    values: {
      nickname: "小米的通勤日记",
      bio: "上海 | 通勤穿搭",
      occupation: "时尚博主",
      gender: "女",
      birthdayFilled: false,
      region: "中国 上海 上海",
      ...values,
    },
  };
}

describe("xhsOpsParseCount (§3.4 rule 5)", () => {
  it("parses abbreviated counts to their lower bound and marks them approximate", () => {
    expect(xhsOpsParseCount("1.2万")).toEqual({
      text: "1.2万",
      value: 12_000,
      approx: true,
    });
    expect(xhsOpsParseCount("12万")?.value).toBe(120_000);
    expect(xhsOpsParseCount("1.25万")?.value).toBe(12_500);
    // 1.1 × 10000 is 11000.000000000002 in floating point.
    expect(xhsOpsParseCount("1.1万")?.value).toBe(11_000);
    expect(xhsOpsParseCount("1.2w")).toMatchObject({
      value: 12_000,
      approx: true,
    });
    expect(xhsOpsParseCount("1.2亿")?.value).toBe(120_000_000);
  });

  it("treats a trailing plus as an open lower bound", () => {
    expect(xhsOpsParseCount("999+")).toEqual({
      text: "999+",
      value: 999,
      approx: true,
    });
    expect(xhsOpsParseCount("10万+")).toMatchObject({
      value: 100_000,
      approx: true,
    });
  });

  it("parses plain counts exactly, including separators and padding", () => {
    expect(xhsOpsParseCount("356")).toEqual({
      text: "356",
      value: 356,
      approx: false,
    });
    expect(xhsOpsParseCount("1,234")).toMatchObject({
      value: 1234,
      approx: false,
    });
    expect(xhsOpsParseCount(" 8 ")).toEqual({
      text: "8",
      value: 8,
      approx: false,
    });
    expect(xhsOpsParseCount("0")).toMatchObject({ value: 0, approx: false });
  });

  it("keeps garbage as text with a null value, and missing text as null", () => {
    for (const raw of ["--", "约1万", "1.5", "abc", "1万2"]) {
      expect(xhsOpsParseCount(raw)).toEqual({
        text: raw,
        value: null,
        approx: false,
      });
    }
    expect(
      xhsOpsParseCount("这是一段很长很长很长的无效计数文字")?.text,
    ).toHaveLength(12);
    expect(xhsOpsParseCount(null)).toBeNull();
    expect(xhsOpsParseCount(undefined)).toBeNull();
    expect(xhsOpsParseCount("   ")).toBeNull();
  });

  it("always produces a value the count schema accepts", () => {
    for (const raw of [
      "1.2万",
      "999+",
      "356",
      "--",
      "这是一段很长很长很长的无效计数文字",
    ]) {
      expect(() =>
        xhsOpsCountSchema.parse(xhsOpsParseCount(raw)),
      ).not.toThrow();
    }
  });

  it("derives the range a count stands for", () => {
    expect(xhsOpsCountRange(xhsOpsParseCount("1.2万"))).toEqual({
      min: 12_000,
      max: 12_999,
    });
    expect(xhsOpsCountRange(xhsOpsParseCount("12万"))).toEqual({
      min: 120_000,
      max: 129_999,
    });
    expect(xhsOpsCountRange(xhsOpsParseCount("999+"))).toEqual({
      min: 999,
      max: null,
    });
    expect(xhsOpsCountRange(xhsOpsParseCount("356"))).toEqual({
      min: 356,
      max: 356,
    });
    expect(xhsOpsCountRange(xhsOpsParseCount("--"))).toBeNull();
    expect(xhsOpsCountRange(null)).toBeNull();
  });
});

describe("xhsOpsHeaderCountFlags (§3.2 状态差分)", () => {
  it("flags any change of an exact following count", () => {
    expect(
      xhsOpsHeaderCountFlags(
        counts("12", "1.2万", "8.9万"),
        counts("13", "1.2万", "8.9万"),
      ),
    ).toEqual(["countsChanged"]);
  });

  it("does not flag approximate following counts", () => {
    expect(
      xhsOpsHeaderCountFlags(
        counts("1.2万", "1", "1"),
        counts("1.3万", "1", "1"),
      ),
    ).toEqual([]);
  });

  it("flags only a 1–3 rise of exact likes+collects", () => {
    expect(
      xhsOpsHeaderCountFlags(
        counts("12", "100", "500"),
        counts("12", "100", "502"),
      ),
    ).toEqual(["possibleSelfLike"]);
    expect(
      xhsOpsHeaderCountFlags(
        counts("12", "100", "500"),
        counts("12", "100", "504"),
      ),
    ).toEqual([]);
    expect(
      xhsOpsHeaderCountFlags(
        counts("12", "100", "500"),
        counts("12", "100", "499"),
      ),
    ).toEqual([]);
  });

  it("never flags followers and tolerates missing reads", () => {
    expect(
      xhsOpsHeaderCountFlags(
        counts("12", "100", "500"),
        counts("12", "180", "500"),
      ),
    ).toEqual([]);
    expect(xhsOpsHeaderCountFlags(null, counts("12", "1", "1"))).toEqual([]);
    expect(
      xhsOpsHeaderCountFlags(counts(null, "1", "1"), counts("12", "1", "1")),
    ).toEqual([]);
  });
});

describe("compareXhsOpsAudits (§6.4)", () => {
  const base = audit({
    id: "audit-base",
    startedAt: "2026-10-01T08:00:00.000Z",
    profile: profilePart({}),
    home: homePart(
      counts("120", "1.2万", "999+"),
      ["通勤穿搭合集 一周不重样", "静安寺咖啡探店"],
      true,
    ),
    creator: creatorPart("1200"),
  });

  it("subtracts abbreviated counts as ranges", () => {
    const same = compareXhsOpsAudits(base, base);
    expect(same.header.followers).toMatchObject({
      delta: { min: -999, max: 999 },
      exact: false,
      direction: "uncertain",
    });
    expect(same.header.following).toMatchObject({
      delta: { min: 0, max: 0 },
      exact: true,
      direction: "same",
    });
    const grown = compareXhsOpsAudits(
      base,
      audit({
        startedAt: "2026-10-04T08:00:00.000Z",
        home: homePart(counts("117", "1.4万", "1200")),
      }),
    );
    expect(grown.header.followers).toMatchObject({
      delta: { min: 1001, max: 2999 },
      direction: "up",
    });
    expect(grown.header.following).toMatchObject({
      delta: { min: -3, max: -3 },
      exact: true,
      direction: "down",
    });
    // "999+" has no upper bound, so the change cannot be bounded below.
    expect(grown.header.likesCollects).toMatchObject({
      delta: { min: null, max: 201 },
      direction: "uncertain",
    });
  });

  it("falls back to the end-of-A and part-B header reads", () => {
    const target = audit({
      home: { ...homePart(null), headerEnd: counts("121", null, null) },
      creator: { ...creatorPart("1"), header: counts(null, "1.3万", null) },
    });
    const result = compareXhsOpsAudits(base, target);
    expect(result.header.following.target?.value).toBe(121);
    expect(result.header.followers.target?.text).toBe("1.3万");
    expect(result.header.likesCollects).toMatchObject({
      target: null,
      delta: null,
      direction: "uncertain",
    });
  });

  it("compares 近 7 日 data only when the audits are at least 7 days apart", () => {
    const early = compareXhsOpsAudits(
      base,
      audit({
        startedAt: "2026-10-07T07:59:00.000Z",
        creator: creatorPart("600"),
      }),
    );
    expect(early.weekly).toEqual({
      comparable: false,
      reason: "interval_lt_7d",
    });
    const late = compareXhsOpsAudits(
      base,
      audit({
        startedAt: "2026-10-08T08:00:00.000Z",
        creator: creatorPart("600"),
      }),
    );
    expect(late.daysApart).toBe(7);
    expect(late.weekly).toMatchObject({
      comparable: true,
      views: { delta: { min: -600, max: -600 }, direction: "down" },
    });
    const unavailable = compareXhsOpsAudits(
      base,
      audit({
        startedAt: "2026-10-20T08:00:00.000Z",
        creator: creatorPart(null, "unavailable"),
      }),
    );
    expect(unavailable.weekly).toEqual({
      comparable: false,
      reason: "creator_unavailable",
    });
  });

  it("diffs notes on title prefixes so truncated titles still match", () => {
    const result = compareXhsOpsAudits(
      base,
      audit({
        home: homePart(counts("120", "1.2万", "999+"), [
          "新笔记：护肤入门三步",
          "通勤穿搭合集 一周不…",
        ]),
      }),
    );
    // The target grid did not reach its end, so the missing note may only
    // have been pushed past the cards read.
    expect(result.notes).toEqual({
      added: ["新笔记：护肤入门三步"],
      removed: ["静安寺咖啡探店"],
      complete: false,
    });
    const whole = compareXhsOpsAudits(
      audit({ home: homePart(null, ["静安寺咖啡探店"], false) }),
      audit({ home: homePart(null, ["通勤穿搭合集"], true) }),
    );
    expect(whole.notes).toEqual({
      added: ["通勤穿搭合集"],
      removed: ["静安寺咖啡探店"],
      complete: true,
    });
    expect(compareXhsOpsAudits(base, audit({ home: null })).notes).toBeNull();
  });

  it("lists changed profile archive values, birthday only as filled or not", () => {
    const result = compareXhsOpsAudits(
      base,
      audit({
        profile: profilePart({ bio: "上海 | 通勤护肤", birthdayFilled: true }),
      }),
    );
    expect(result.profileChanges).toEqual([
      { field: "bio", base: "上海 | 通勤穿搭", target: "上海 | 通勤护肤" },
      { field: "birthdayFilled", base: "未填", target: "已填" },
    ]);
  });
});

describe("xhsOpsInterestWordCount / xhsOpsPlanBudgetIssues (§2.5)", () => {
  it("dedupes across layers, ignores blanks and caps at eight words", () => {
    expect(
      xhsOpsInterestWordCount({
        core: ["护肤", " 护肤 ", "敏感肌", ""],
        extended: ["敏感肌", "通勤"],
        general: ["  "],
      }),
    ).toBe(3);
    expect(
      xhsOpsInterestWordCount({
        core: ["a", "b", "c", "d", "e"],
        extended: ["f", "g", "h"],
        general: ["i", "j"],
      }),
    ).toBe(8);
  });

  it("passes the default 90/2/80 cadence with five words and names the shortfall with four", () => {
    const defaults = {
      dailyTargetPosts: 90,
      dailySegments: 2,
      searchRatioPercent: 80,
    };
    expect(xhsOpsPlanBudgetIssues(defaults, 5)).toEqual([]);
    expect(xhsOpsPlanBudgetIssues(defaults, 4)).toEqual([
      "本段搜索目标 36 篇至少需要 5 个兴趣词，当前只有 4 个，请补充兴趣池或增加每日分段",
    ]);
  });

  it("checks the largest segment of an odd daily target", () => {
    // 91 / 2 → segments of 46 and 45: the larger one needs 37 search posts.
    expect(
      xhsOpsPlanBudgetIssues(
        { dailyTargetPosts: 91, dailySegments: 2, searchRatioPercent: 80 },
        4,
      ),
    ).toEqual([
      "本段搜索目标 37 篇至少需要 5 个兴趣词，当前只有 4 个，请补充兴趣池或增加每日分段",
    ]);
    // 25 / 2 at 0% search → segments of 13 and 12; only the first exceeds 12.
    expect(
      xhsOpsPlanBudgetIssues(
        { dailyTargetPosts: 25, dailySegments: 2, searchRatioPercent: 0 },
        0,
      ),
    ).toEqual(["本段首页目标 13 篇超过上限 12，请提高搜索占比或增加每日分段"]);
  });

  it("reports both checks and skips configs without a daily target", () => {
    expect(
      xhsOpsPlanBudgetIssues(
        { dailyTargetPosts: 150, dailySegments: 1, searchRatioPercent: 50 },
        2,
      ),
    ).toHaveLength(2);
    expect(
      xhsOpsPlanBudgetIssues(
        { dailyTargetPosts: 0, dailySegments: 1, searchRatioPercent: 80 },
        0,
      ),
    ).toEqual([]);
  });

  it("every tier cadence fits with its minimum word count and not one fewer", () => {
    const minimumWords: Record<XhsOpsMaturityTier, number> = {
      starter: 5,
      growing: 3,
      established: 2,
      dormant: 3,
    };
    for (const [tier, cadence] of Object.entries(XHS_TAKEOVER_TIER_CADENCE)) {
      const words = minimumWords[tier as XhsOpsMaturityTier];
      expect(xhsOpsPlanBudgetIssues(cadence, words)).toEqual([]);
      expect(xhsOpsPlanBudgetIssues(cadence, words - 1)).toHaveLength(1);
    }
  });
});

describe("xhsOpsTakeoverPlanIssues (§5.1 step 2, §6.3)", () => {
  function tierAccount(
    tier: XhsOpsMaturityTier,
    overrides: Record<string, unknown> = {},
  ) {
    const cadence = XHS_TAKEOVER_TIER_CADENCE[tier];
    return account({
      browseDefaults: {
        dailyTargetPosts: cadence.dailyTargetPosts,
        dailySegments: cadence.dailySegments,
        searchRatioPercent: cadence.searchRatioPercent,
      },
      interaction: {
        like: {
          enabled: true,
          dailyCap: cadence.likeDailyCap,
          ratioPercent: cadence.likeRatioPercent,
        },
      },
      ...overrides,
    });
  }

  it("accepts each tier's own cadence", () => {
    for (const tier of Object.keys(
      XHS_TAKEOVER_TIER_CADENCE,
    ) as XhsOpsMaturityTier[]) {
      expect(xhsOpsTakeoverPlanIssues(tierAccount(tier), tier)).toEqual([]);
    }
  });

  it("marks parameters above the tier as overridable", () => {
    const issues = xhsOpsTakeoverPlanIssues(
      account({
        browseDefaults: {
          dailyTargetPosts: 60,
          dailySegments: 2,
          searchRatioPercent: 60,
        },
        interaction: { like: { enabled: true, dailyCap: 5, ratioPercent: 10 } },
      }),
      "established",
    );
    expect(issues.map((issue) => [issue.field, issue.overridable])).toEqual([
      ["browseDefaults.dailyTargetPosts", true],
      ["interaction.like.dailyCap", true],
      ["interaction.like.ratioPercent", true],
    ]);
    expect(issues[0]?.message).toBe(
      "日目标 60 篇超过接管档位（成熟档）上限 40 篇",
    );
  });

  it("caps at the schema defaults when no tier is known", () => {
    expect(xhsOpsTakeoverPlanIssues(account(), null)).toEqual([]);
    expect(
      xhsOpsTakeoverPlanIssues(
        account({
          browseDefaults: { dailyTargetPosts: 120, dailySegments: 3 },
        }),
        null,
      ).map((issue) => issue.message),
    ).toEqual(["日目标 120 篇超过新号默认值上限 90 篇"]);
  });

  it("treats collect, follow and comment as over the tier", () => {
    const issues = xhsOpsTakeoverPlanIssues(
      tierAccount("growing", {
        interaction: {
          like: { enabled: true, dailyCap: 5, ratioPercent: 8 },
          collect: { enabled: true, dailyCap: 2, ratioPercent: 3 },
          follow: {
            enabled: true,
            dailyCap: 1,
            ratioPercent: 1,
            targetTypes: ["同城"],
          },
          comment: { enabled: true },
        },
      }),
      "growing",
    );
    expect(issues.map((issue) => issue.field)).toEqual([
      "interaction.collect.enabled",
      "interaction.follow.enabled",
      "interaction.comment.enabled",
    ]);
    expect(issues.every((issue) => issue.overridable)).toBe(true);
  });

  it("ignores like caps while likes are off", () => {
    expect(
      xhsOpsTakeoverPlanIssues(
        tierAccount("dormant", {
          interaction: {
            like: { enabled: false, dailyCap: 50, ratioPercent: 100 },
          },
        }),
        "dormant",
      ),
    ).toEqual([]);
  });

  it("keeps the budget and dwell floor as hard limits", () => {
    const issues = xhsOpsTakeoverPlanIssues(
      tierAccount("starter", {
        interestPool: { core: ["护肤"], extended: [], general: [] },
        browseDefaults: { dwellSecMin: 10 },
      }),
      "starter",
    );
    expect(issues.map((issue) => [issue.field, issue.overridable])).toEqual([
      ["interestPool", false],
      ["browseDefaults.dwellSecMin", false],
    ]);
    const home = xhsOpsTakeoverPlanIssues(
      tierAccount("dormant", {
        browseDefaults: {
          dailyTargetPosts: 30,
          dailySegments: 1,
          searchRatioPercent: 50,
        },
      }),
      "dormant",
    );
    expect(home.map((issue) => [issue.field, issue.overridable])).toEqual([
      ["browseDefaults.searchRatioPercent", false],
    ]);
  });

  it("does not let a zero target slip past the tier", () => {
    expect(
      xhsOpsTakeoverPlanIssues(
        tierAccount("established", { browseDefaults: { dailyTargetPosts: 0 } }),
        "established",
      ).map((issue) => [issue.field, issue.overridable]),
    ).toEqual([["browseDefaults.dailyTargetPosts", true]]);
  });
});

describe("xhsOpsTakeoverStage (§1.1)", () => {
  const stage = (
    t: Record<string, unknown> | null,
    extra: Record<string, unknown> = {},
  ) =>
    xhsOpsTakeoverStage(
      account({
        takeover: t === null ? null : xhsOpsTakeoverSchema.parse(t),
        ...extra,
      }),
      NOW_MS,
    );

  it("is null for new accounts and bound before authorization", () => {
    expect(
      xhsOpsTakeoverStage(account({ entryMode: "new" }), NOW_MS),
    ).toBeNull();
    expect(stage(null)).toBe("bound");
    expect(stage({})).toBe("bound");
  });

  it("follows the lifecycle from authorization to diagnosis", () => {
    expect(stage({ authorizedAt: NOW })).toBe("authorized");
    expect(
      stage(
        { authorizedAt: NOW, identityConfirmedAt: NOW },
        { platformAccountId: "" },
      ),
    ).toBe("authorized");
    expect(stage({ authorizedAt: NOW, identityConfirmedAt: NOW })).toBe(
      "identity_locked",
    );
    expect(
      stage({
        authorizedAt: NOW,
        identityConfirmedAt: NOW,
        baselineAuditId: "a",
      }),
    ).toBe("baselined");
    expect(
      stage({
        authorizedAt: NOW,
        identityConfirmedAt: NOW,
        baselineAuditId: "a",
        activeDiagnosisId: "d",
      }),
    ).toBe("diagnosed");
  });

  it("splits a confirmed plan into change-in-flight, observing and maintaining", () => {
    const confirmed = {
      authorizedAt: NOW,
      identityConfirmedAt: NOW,
      planConfirmedAt: NOW,
    };
    expect(stage({ ...confirmed, activeChangeOrderId: "co-1" })).toBe(
      "plan_confirmed",
    );
    expect(
      stage({ ...confirmed, observationUntil: "2026-10-21T08:00:00.000Z" }),
    ).toBe("observing");
    expect(
      stage({ ...confirmed, observationUntil: "2026-10-19T08:00:00.000Z" }),
    ).toBe("maintaining");
    expect(stage(confirmed)).toBe("maintaining");
  });

  it("ranks a device hold above a pause above everything else", () => {
    const pause = { code: "manual", reason: "运营暂停", since: NOW };
    const hold = { taskId: "t-1", sourceRef: "audit-1", since: NOW };
    expect(stage({ authorizedAt: NOW, safetyPause: pause })).toBe("paused");
    expect(
      stage({ authorizedAt: NOW, safetyPause: pause, deviceHold: hold }),
    ).toBe("device_hold");
  });
});

describe("xhsOpsAccountNurtureIssues", () => {
  it("leaves the new-account branch exactly as before", () => {
    const fresh = account({
      entryMode: "new",
      platformAccountId: "",
      interestPool: { core: ["护肤"], extended: ["通勤"], general: ["咖啡"] },
    });
    expect(xhsOpsAccountNurtureIssues(fresh, null)).toEqual([
      "请先确认目标用户画像",
      "请补充账号定位名与内容方向",
      "请补充年龄",
      "请补充性别",
      "请补充地区",
      "请补充职业/身份",
      "请补充生活状态",
      "号设档案需要 1–2 个不同的垂直标签",
      "号设档案需要 2–3 个不同的泛兴趣标签",
      "人设或目标画像已变化，请重新核对并确认人设",
      "请先完成九项账号资料与素材并校验确认",
      "请先完成手机账号配置及资料生效核验",
    ]);
    expect(
      xhsOpsAccountNurtureIssues(
        account({ entryMode: "new", profileDraft: verifiedDraft }),
        project,
      ),
    ).not.toContain("请先完成手机账号配置及资料生效核验");
    // The run planner matches this issue exactly to embed the material card.
    expect(XHS_ACCOUNT_PROFILE_MATERIAL_REQUIRED_MESSAGE).toBe(
      "请先完成九项账号资料与素材并校验确认",
    );
    expect(xhsOpsAccountNurtureIssues(fresh, null)).toContain(
      XHS_ACCOUNT_PROFILE_MATERIAL_REQUIRED_MESSAGE,
    );
  });

  it("lets a legacy existing row the old flow verified keep running", () => {
    const legacy = account({ profileDraft: verifiedDraft });
    expect(xhsOpsLegacyExistingVerified(legacy)).toBe(true);
    expect(xhsOpsAccountNurtureIssues(legacy, project)).toEqual([]);
    expect(xhsOpsAccountNurtureIssues(legacy, null)).toEqual([
      "请先确认目标用户画像",
    ]);
  });

  it("sends an unverified legacy existing row to the takeover", () => {
    expect(xhsOpsAccountNurtureIssues(account(), project)).toEqual([
      "请先开始接管：授权、锁定身份并完成只读盘点",
    ]);
    const otherAccount = account({
      profileDraft: { ...verifiedDraft, verifiedAccountId: "xhs-999" },
    });
    expect(xhsOpsLegacyExistingVerified(otherAccount)).toBe(false);
    expect(
      xhsOpsLegacyExistingVerified(
        account({ entryMode: "new", profileDraft: verifiedDraft }),
      ),
    ).toBe(false);
    expect(
      xhsOpsAccountNurtureIssues(
        account({
          profileDraft: {
            ...verifiedDraft,
            applyOperation: {
              operationId: "op-1",
              status: "running",
              deviceId: "dev-1",
              accountUpdatedAt: NOW,
              startedAt: NOW,
            },
          },
        }),
        project,
      ),
    ).toEqual(["资料应用任务仍在执行"]);
  });

  it("requires identity, baseline and plan for a takeover", () => {
    expect(
      xhsOpsAccountNurtureIssues(
        account({ takeover: { authorizedAt: NOW } }),
        project,
      ),
    ).toEqual([
      "请先读取并锁定手机上的小红书号",
      "请先完成只读盘点并确认基线",
      "请先确认接管方案（至少兴趣池与养号参数）",
    ]);
    expect(
      xhsOpsAccountNurtureIssues(
        account({ platformAccountId: "", takeover: takeover() }),
        project,
      ),
    ).toEqual(["请先读取并锁定手机上的小红书号"]);
    expect(
      xhsOpsAccountNurtureIssues(account({ takeover: takeover() }), project),
    ).toEqual([]);
  });

  it("does not interrupt a legacy-verified takeover before its plan is confirmed", () => {
    const legacyTakeover = takeover({
      identitySource: "legacy",
      legacyVerified: true,
      baselineAuditId: null,
      planConfirmedAt: null,
    });
    expect(
      xhsOpsAccountNurtureIssues(
        account({ takeover: legacyTakeover }),
        project,
      ),
    ).toEqual([]);
    // Once a plan is confirmed the baseline rule applies to it as well.
    expect(
      xhsOpsAccountNurtureIssues(
        account({ takeover: { ...legacyTakeover, planConfirmedAt: NOW } }),
        project,
      ),
    ).toEqual(["请先完成只读盘点并确认基线"]);
  });

  it("applies the plan budget to takeover accounts", () => {
    expect(
      xhsOpsAccountNurtureIssues(
        account({
          takeover: takeover(),
          interestPool: { core: ["护肤", "敏感肌"], extended: [], general: [] },
        }),
        project,
      ),
    ).toEqual([
      "本段搜索目标 36 篇至少需要 5 个兴趣词，当前只有 2 个，请补充兴趣池或增加每日分段",
    ]);
  });

  it("holds a takeover on pauses, device holds, audits and change orders", () => {
    const blocked = takeover({
      safetyPause: { code: "rate_limited", reason: "操作频繁", since: NOW },
      deviceHold: { taskId: "t-1", sourceRef: "audit-1", since: NOW },
      activeChangeOrderId: "co-1",
      noNurtureDates: ["2026-10-20"],
    });
    expect(
      xhsOpsAccountNurtureIssues(account({ takeover: blocked }), project, {
        auditRunning: true,
        today: "2026-10-20",
      }),
    ).toEqual([
      "账号暂停中：操作频繁",
      "手机上的任务停止未确认，请到手机上确认后在接管卡片解除",
      "只读盘点进行中",
      "有资料变更单正在执行或待核验",
      "今天改过公开资料，按规则当天不养号",
    ]);
    // Without `today` the noNurtureDates rule is the caller's (scheduler) concern.
    expect(
      xhsOpsAccountNurtureIssues(
        account({ takeover: takeover({ noNurtureDates: ["2026-10-20"] }) }),
        project,
      ),
    ).toEqual([]);
  });

  it("sees a running audit on takeover.activeAuditId without being told, and still takes auditRunning", () => {
    expect(
      xhsOpsAccountNurtureIssues(
        account({ takeover: takeover({ activeAuditId: "audit-2" }) }),
        project,
      ),
    ).toEqual(["只读盘点进行中"]);
    expect(
      xhsOpsAccountNurtureIssues(
        account({ takeover: takeover({ activeAuditId: "audit-2" }) }),
        project,
        { auditRunning: true },
      ),
    ).toEqual(["只读盘点进行中"]);
    expect(
      xhsOpsAccountNurtureIssues(account({ takeover: takeover() }), project, {
        auditRunning: true,
      }),
    ).toEqual(["只读盘点进行中"]);
    expect(
      xhsOpsAccountNurtureIssues(account({ takeover: takeover() }), project),
    ).toEqual([]);
  });
});

describe("change-order acks (§2.5)", () => {
  it("requires the photo acks for image fields and the second check for nickname or region", () => {
    expect(xhsOpsChangeOrderRequiredAcks(["bio", "occupation"])).toEqual([]);
    expect(xhsOpsChangeOrderRequiredAcks(["avatar"])).toEqual([
      "photoPermission",
      "screenshotPrivacy",
      "cleanup",
    ]);
    expect(xhsOpsChangeOrderRequiredAcks(["nickname", "region"])).toEqual([
      "l2SecondCheck",
    ]);
    expect(
      xhsOpsChangeOrderRequiredAcks(["bio"], { previousWarn: true }),
    ).toEqual(["warnAcknowledged"]);
  });

  it("reports every ack that is not explicitly true", () => {
    expect(
      xhsOpsChangeOrderMissingAcks(
        ["avatar", "cover"],
        { photoPermission: true, screenshotPrivacy: false },
        { previousWarn: true },
      ),
    ).toEqual(["screenshotPrivacy", "cleanup", "warnAcknowledged"]);
    expect(
      xhsOpsChangeOrderMissingAcks(["region"], { l2SecondCheck: true }),
    ).toEqual([]);
  });

  it("asks for warnAcknowledged only when the newest reviewed order of the same 小红书号 ended with warn", () => {
    const reviewed = (
      id: string,
      confirmedAt: string,
      verdict: "pass" | "warn" | "fail" | "pending" | "inconclusive",
      overrides: Record<string, unknown> = {},
    ) =>
      xhsOpsChangeOrderSchema.parse({
        id,
        projectId: "proj-1",
        accountId: "acct-1",
        deviceId: "dev-1",
        platformAccountId: "xhs-123",
        diagnosisId: null,
        proposalIds: [],
        batchIndex: 1,
        risk: "L1",
        fields: [{ field: "bio", baselineValue: "旧", after: "新" }],
        status: "completed",
        confirmedAt,
        observation: {
          until: confirmedAt,
          auditId: "audit-9",
          baseAuditId: "audit-1",
          verdict,
          notes: [],
        },
        createdAt: confirmedAt,
        updatedAt: confirmedAt,
        ...overrides,
      });
    const next = reviewed("co-next", "2026-10-20T09:00:00.000Z", "pending", {
      status: "draft",
      confirmedAt: null,
      observation: null,
    });
    const warned = reviewed("co-1", "2026-10-10T00:00:00.000Z", "warn");
    const passed = reviewed("co-2", "2026-10-15T00:00:00.000Z", "pass");
    expect(xhsOpsChangeOrderPreviousReviewWarned([warned], next)).toBe(true);
    // The newest reviewed order decides.
    expect(xhsOpsChangeOrderPreviousReviewWarned([warned, passed], next)).toBe(
      false,
    );
    // Not reviewed yet, still observing, another 小红书号 or the order itself: no say.
    expect(
      xhsOpsChangeOrderPreviousReviewWarned(
        [
          warned,
          reviewed("co-3", "2026-10-16T00:00:00.000Z", "pending"),
          reviewed("co-4", "2026-10-17T00:00:00.000Z", "pass", {
            status: "observing",
          }),
          reviewed("co-5", "2026-10-18T00:00:00.000Z", "pass", {
            platformAccountId: "xhs-other",
          }),
        ],
        next,
      ),
    ).toBe(true);
    expect(xhsOpsChangeOrderPreviousReviewWarned([warned], warned)).toBe(false);
    expect(
      xhsOpsChangeOrderRequiredAcks(["bio"], {
        previousWarn: xhsOpsChangeOrderPreviousReviewWarned([warned], next),
      }),
    ).toEqual(["warnAcknowledged"]);
  });
});

describe("takeover rules the card shares with the controller (§2.1, §2.5, §6.5, T3)", () => {
  it("accepts an identity read for 30 minutes", () => {
    expect(XHS_TAKEOVER_IDENTITY_READ_TTL_MS).toBe(30 * 60_000);
  });

  it("needs a written reason to resume exactly the risk and observation pauses", () => {
    const codes = xhsOpsSafetyPauseSchema.shape.code.options;
    expect(
      codes.filter((code) => XHS_TAKEOVER_RESUME_REASON_CODES.has(code)),
    ).toEqual(["rate_limited", "account_restricted", "observation_failed"]);
  });

  it("asks for 「已人工检查」 only on the four flags a mistap could explain, in the audit's order", () => {
    expect([...XHS_TAKEOVER_MANUAL_CHECK_AUDIT_FLAGS.keys()]).toEqual([
      "unexpectedClicks",
      "countsChanged",
      "possibleSelfLike",
      "profileDrift",
    ]);
    expect(
      xhsOpsAuditManualCheckFlags([
        "nicknameInconsistent",
        "profileDrift",
        "creatorUnavailable",
        "unexpectedClicks",
        "identityStale",
        "cancellationUnconfirmed",
      ]),
    ).toEqual(["profileDrift", "unexpectedClicks"]);
    expect(xhsOpsAuditManualCheckFlags([])).toEqual([]);
  });

  it("names every change-order status and joins field names in Chinese", () => {
    expect(Object.keys(XHS_TAKEOVER_CHANGE_ORDER_STATUS_LABEL).sort()).toEqual(
      [...xhsOpsChangeOrderStatusSchema.options].sort(),
    );
    expect(XHS_TAKEOVER_CHANGE_ORDER_STATUS_LABEL).toMatchObject({
      draft: "草案",
      awaiting_confirm: "待确认",
      observing: "观察期",
      interrupted: "已中断",
    });
    expect(xhsOpsProfileFieldLabels(["bio", "occupation"])).toBe("简介、职业");
    expect(xhsOpsProfileFieldLabels(["avatar"])).toBe("头像");
    expect(xhsOpsProfileFieldLabels([])).toBe("");
  });

  it("describes a takeover parameter 409 with a stable code and the plan issues", () => {
    const issues = xhsOpsTakeoverPlanIssues(
      account({
        interaction: {
          like: { enabled: true, dailyCap: 5, ratioPercent: 10 },
          collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
          follow: { enabled: true, dailyCap: 2, ratioPercent: 2 },
          comment: { enabled: false, dailyCap: 2 },
        },
      }),
      "established",
    );
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues)
      expect(xhsOpsTakeoverPlanIssueSchema.parse(issue)).toEqual(issue);
    expect(
      xhsOpsAccountConflictResponseSchema.parse({
        message:
          "开启关注超出接管档位（成熟档）。超出接管档位的调整需要填写理由",
        code: "takeover_override_reason_required",
        issues,
      }),
    ).toMatchObject({ code: "takeover_override_reason_required" });
    // Every other 409 of the account routes is a bare message.
    expect(
      xhsOpsAccountConflictResponseSchema.parse({ message: "账号已更新" }),
    ).toEqual({ message: "账号已更新" });
    expect(xhsOpsTakeoverParamConflictCodeSchema.options).toEqual([
      "takeover_override_reason_required",
      "takeover_param_hard_limit",
    ]);
    expect(
      xhsOpsAccountConflictResponseSchema.safeParse({
        message: "x",
        code: "something_else",
      }).success,
    ).toBe(false);
  });

  it("lets a device transfer carry an overrideReason, as the PATCH does", () => {
    const body = {
      fromAccountId: "acct-1",
      toAccountId: "acct-2",
      account: { label: "接管目标", entryMode: "existing", deviceId: "dev-1" },
    };
    expect(
      xhsOpsAccountTransferSchema.parse(body).overrideReason,
    ).toBeUndefined();
    expect(
      xhsOpsAccountTransferSchema.parse({
        ...body,
        overrideReason: "  客户要求回关老粉  ",
      }).overrideReason,
    ).toBe("客户要求回关老粉");
    expect(
      xhsOpsAccountTransferSchema.safeParse({ ...body, overrideReason: " " })
        .success,
    ).toBe(false);
    // The reason is the request's, never part of the account it writes.
    expect(
      "overrideReason" in xhsOpsAccountTransferSchema.parse(body).account,
    ).toBe(false);
  });

  it("keeps the plan's skipped fields on the takeover, one per field at most", () => {
    const skipped = {
      proposalId: "P7",
      field: "avatar",
      reason: "这台手机系统版本过低，不支持自动换图",
    };
    expect(
      xhsOpsTakeoverSchema.parse({ skippedFields: [skipped] }).skippedFields,
    ).toEqual([skipped]);
    expect(
      xhsOpsTakeoverSchema.safeParse({
        skippedFields: [{ ...skipped, field: "gender" }],
      }).success,
    ).toBe(false);
    expect(
      xhsOpsTakeoverSchema.safeParse({
        skippedFields: Array.from({ length: 7 }, () => skipped),
      }).success,
    ).toBe(false);
    expect(xhsOpsTakeoverSkippedFieldSchema.parse(skipped)).toEqual(skipped);
  });

  it("serves the playbook with the phone-skills bundle its doc rules were checked against", () => {
    const response = {
      version: XHS_OPS_PLAYBOOK_VERSION,
      bundleVersion: PHONE_SKILLS_BUNDLE,
      rules: [...XHS_OPS_PLAYBOOK],
    };
    expect(xhsOpsPlaybookResponseSchema.parse(response)).toEqual(response);
    expect(
      xhsOpsPlaybookResponseSchema.safeParse({
        version: XHS_OPS_PLAYBOOK_VERSION,
        rules: [],
      }).success,
    ).toBe(false);
  });
});

describe("XHS_TAKEOVER_CHANGE_BUDGET (§8.1)", () => {
  it("assigns risk and batches as §4.4 #8 and MT-02 require", () => {
    const byBatch = new Map<number, string[]>();
    for (const [field, budget] of Object.entries(XHS_TAKEOVER_CHANGE_BUDGET)) {
      byBatch.set(budget.batch, [...(byBatch.get(budget.batch) ?? []), field]);
      expect(budget.risk).toBe(
        field === "bio" || field === "occupation" ? "L1" : "L2",
      );
      expect(budget.maxChanges).toBe(1);
    }
    expect(Object.fromEntries(byBatch)).toEqual({
      1: ["bio", "occupation"],
      2: ["nickname", "region"],
      3: ["avatar", "cover"],
    });
    expect(XHS_TAKEOVER_CHANGE_BUDGET.nickname.windowDays).toBe(30);
    expect(XHS_TAKEOVER_CHANGE_BUDGET.occupation.windowDays).toBe(14);
    expect(XHS_TAKEOVER_CHANGE_BUDGET.avatar.windowDays).toBe(7);
    expect(XHS_TAKEOVER_OBSERVATION_HOURS).toEqual({ L1: 72, L2: 168 });
  });
});

describe("xhsOpsTakeoverFieldBudgetState (§8.1 ledger)", () => {
  const DAY = 86_400_000;
  const daysAgo = (days: number) => new Date(NOW_MS - days * DAY).toISOString();

  function order(
    fields: Array<Record<string, unknown>>,
    overrides: Record<string, unknown> = {},
  ) {
    return xhsOpsChangeOrderSchema.parse({
      id: "co-1",
      projectId: "proj-1",
      accountId: "acct-1",
      deviceId: "dev-1",
      platformAccountId: "xhs-123",
      diagnosisId: "diag-1",
      proposalIds: [],
      batchIndex: 3,
      risk: "L2",
      fields: fields.map((field) => ({
        baselineValue: "",
        after: "x",
        ...field,
      })),
      status: "observing",
      applyTaskId: "apply-1",
      confirmedAt: daysAgo(2),
      createdAt: daysAgo(3),
      updatedAt: daysAgo(1),
      ...overrides,
    });
  }

  it("counts a dispatched field whatever the order's final state", () => {
    const orders = [
      order(
        [
          { field: "avatar", outcome: "verified" },
          { field: "cover", outcome: "failed", code: "step_limit" },
        ],
        { status: "failed" },
      ),
    ];
    expect(
      xhsOpsTakeoverFieldBudgetState("avatar", { orders, notices: [] }, NOW_MS),
    ).toEqual({
      used: 1,
      blockedUntil: new Date(NOW_MS + 5 * DAY).toISOString(),
    });
    // A failure that may already have been submitted still counts.
    expect(
      xhsOpsTakeoverFieldBudgetState("cover", { orders, notices: [] }, NOW_MS)
        .blockedUntil,
    ).not.toBeNull();
  });

  it("skips fields the phone never submitted and orders that never applied", () => {
    const orders = [
      order([
        { field: "avatar", outcome: "failed", code: "permission_required" },
        { field: "cover", outcome: "skipped" },
      ]),
      order([{ field: "bio", outcome: "pending" }], {
        applyTaskId: null,
        status: "draft",
        confirmedAt: null,
      }),
    ];
    for (const field of ["avatar", "cover", "bio"] as const) {
      expect(
        xhsOpsTakeoverFieldBudgetState(field, { orders, notices: [] }, NOW_MS),
      ).toEqual({ used: 0, blockedUntil: null });
    }
    expect(
      xhsOpsChangeOrderFieldCounted(
        { applyTaskId: "apply-1" },
        { outcome: "uncertain", code: null },
      ),
    ).toBe(true);
  });

  it("frees a field once its window has passed", () => {
    const orders = [
      order([{ field: "nickname", outcome: "verified" }], {
        confirmedAt: daysAgo(31),
      }),
      order([{ field: "occupation", outcome: "verified" }], {
        confirmedAt: daysAgo(13),
      }),
    ];
    expect(
      xhsOpsTakeoverFieldBudgetState(
        "nickname",
        { orders, notices: [] },
        NOW_MS,
      ),
    ).toEqual({ used: 0, blockedUntil: null });
    expect(
      xhsOpsTakeoverFieldBudgetState(
        "occupation",
        { orders, notices: [] },
        NOW_MS,
      ).blockedUntil,
    ).toBe(new Date(NOW_MS + DAY).toISOString());
  });

  it("exempts a rollback from the self-limit but not from platform notices", () => {
    const orders = [order([{ field: "nickname", outcome: "verified" }])];
    const notice = {
      field: "nickname" as const,
      text: "30天内只能修改1次",
      observedAt: daysAgo(2),
      blockedUntil: new Date(NOW_MS + 28 * DAY).toISOString(),
      sourceTaskId: "apply-1",
    };
    expect(
      xhsOpsTakeoverFieldBudgetState(
        "nickname",
        { orders, notices: [] },
        NOW_MS,
        { rollback: true },
      ),
    ).toEqual({ used: 1, blockedUntil: null });
    expect(
      xhsOpsTakeoverFieldBudgetState(
        "nickname",
        { orders, notices: [notice] },
        NOW_MS,
        { rollback: true },
      ).blockedUntil,
    ).toBe(notice.blockedUntil);
    // An expired notice no longer binds.
    expect(
      xhsOpsTakeoverFieldBudgetState(
        "region",
        {
          orders: [],
          notices: [{ ...notice, field: "region", blockedUntil: daysAgo(1) }],
        },
        NOW_MS,
      ).blockedUntil,
    ).toBeNull();
  });
});

describe("xhsOpsObservationVerdict (§6.4)", () => {
  function review(
    baseHeader: XhsOpsHeaderCounts,
    targetHeader: XhsOpsHeaderCounts,
    views: [string | null, string | null] = ["1200", "1100"],
    days = 7,
  ) {
    return compareXhsOpsAudits(
      audit({
        id: "audit-base",
        startedAt: NOW,
        home: homePart(baseHeader),
        creator: creatorPart(views[0]),
      }),
      audit({
        id: "audit-review",
        startedAt: new Date(NOW_MS + days * 86_400_000).toISOString(),
        home: homePart(targetHeader),
        creator: creatorPart(views[1]),
      }),
    );
  }
  const clean = {
    risk: "L1" as const,
    accountMatched: true,
    signals: [],
    fieldMismatches: [],
    images: [],
  };

  it("passes an exact, steady account and fails on any hard signal", () => {
    const comparison = review(
      counts("12", "800", "3000"),
      counts("12", "790", "3010"),
      ["1200", "1100"],
      3,
    );
    expect(xhsOpsObservationVerdict({ ...clean, comparison })).toEqual({
      verdict: "pass",
      awaitingVisualCheck: false,
      notes: [],
    });
    expect(
      xhsOpsObservationVerdict({
        ...clean,
        comparison,
        accountMatched: false,
        signals: ["rate_limited", "rate_limited"],
        fieldMismatches: ["bio"],
      }),
    ).toEqual({
      verdict: "fail",
      awaitingVisualCheck: false,
      notes: [
        "复查时号码核对不一致",
        "观察期内出现风控信号：操作频繁",
        "复查回读与目标值不一致：简介",
      ],
    });
  });

  it("warns on an exact followers drop of at least 3 % and 20", () => {
    expect(
      xhsOpsObservationVerdict({
        ...clean,
        comparison: review(
          counts("12", "800", "3000"),
          counts("12", "776", "3000"),
        ),
      }),
    ).toMatchObject({
      verdict: "warn",
      notes: ["粉丝从 800 降到 776，减少 24"],
    });
    // 19 fewer is under the absolute floor; 24 of 1000 is under 3 %.
    for (const [from, to] of [
      ["300", "281"],
      ["1000", "976"],
    ] as const) {
      expect(
        xhsOpsObservationVerdict({
          ...clean,
          comparison: review(counts("12", from, "1"), counts("12", to, "1")),
        }).verdict,
      ).toBe("pass");
    }
  });

  it("keeps approximate followers inconclusive", () => {
    const result = xhsOpsObservationVerdict({
      ...clean,
      comparison: review(
        counts("12", "1.5万", "9万"),
        counts("12", "1.2万", "9万"),
      ),
    });
    expect(result).toEqual({
      verdict: "inconclusive",
      awaitingVisualCheck: false,
      notes: ["粉丝数只显示约数，这一条不作判定"],
    });
  });

  it("compares 近 7 日 views only for L2 orders seven days apart", () => {
    const steady = counts("12", "800", "3000");
    const halved = review(steady, steady, ["1200", "600"]);
    expect(
      xhsOpsObservationVerdict({ ...clean, comparison: halved }).verdict,
    ).toBe("pass");
    expect(
      xhsOpsObservationVerdict({ ...clean, risk: "L2", comparison: halved }),
    ).toMatchObject({
      verdict: "warn",
      notes: ["近 7 日观看从 1200 降到 600，降幅不低于 50%"],
    });
    expect(
      xhsOpsObservationVerdict({
        ...clean,
        risk: "L2",
        comparison: review(steady, steady, ["1200", "600"], 6),
      }).verdict,
    ).toBe("pass");
    expect(
      xhsOpsObservationVerdict({
        ...clean,
        risk: "L2",
        comparison: review(steady, steady, ["1.2万", "1.1万"]),
      }).verdict,
    ).toBe("pass");
    // 1.2万 → 0.6万 may be 12999 → 6000 (54 %) or 12000 → 6999 (42 %).
    expect(
      xhsOpsObservationVerdict({
        ...clean,
        risk: "L2",
        comparison: review(steady, steady, ["1.2万", "0.6万"]),
      }),
    ).toMatchObject({
      verdict: "inconclusive",
      notes: ["近 7 日观看是近似值，变化小于页面精度"],
    });
  });

  it("holds image orders until every image is compared, then fails a mismatch", () => {
    const comparison = review(
      counts("12", "800", "3000"),
      counts("12", "800", "3000"),
    );
    expect(
      xhsOpsObservationVerdict({
        ...clean,
        risk: "L2",
        comparison,
        images: [
          { field: "avatar", result: "match" },
          { field: "cover", result: null },
        ],
      }),
    ).toEqual({
      verdict: "inconclusive",
      awaitingVisualCheck: true,
      notes: ["等待人工对照图片：背景图"],
    });
    expect(
      xhsOpsObservationVerdict({
        ...clean,
        risk: "L2",
        comparison,
        images: [
          { field: "avatar", result: "match" },
          { field: "cover", result: "mismatch" },
        ],
      }),
    ).toMatchObject({ verdict: "fail", notes: ["图片与原图不一致：背景图"] });
    expect(
      xhsOpsObservationVerdict({
        ...clean,
        risk: "L2",
        comparison,
        images: [{ field: "avatar", result: "match" }],
      }).verdict,
    ).toBe("pass");
  });

  it("is inconclusive without a base audit", () => {
    expect(xhsOpsObservationVerdict({ ...clean, comparison: null })).toEqual({
      verdict: "inconclusive",
      awaitingVisualCheck: false,
      notes: ["没有可对比的基准盘点"],
    });
  });
});

describe("xhsOpsAccountEntryModeLocked (§2.5)", () => {
  it("locks a takeover and an existing row with a 小红书号, never a plain new account", () => {
    expect(
      xhsOpsAccountEntryModeLocked(account({ takeover: takeover() })),
    ).toBe(true);
    expect(xhsOpsAccountEntryModeLocked(account())).toBe(true);
    expect(
      xhsOpsAccountEntryModeLocked(account({ platformAccountId: "  " })),
    ).toBe(false);
    expect(xhsOpsAccountEntryModeLocked(account({ entryMode: "new" }))).toBe(
      false,
    );
  });
});

describe("takeover schemas", () => {
  it("parses store data written before the takeover collections existed", () => {
    const legacy = {
      schemaVersion: 1,
      projects: [project],
      accounts: [
        {
          id: "acct-old",
          projectId: "proj-1",
          entryMode: "existing",
          label: "旧号",
          profileDraft: {
            applyOperation: {
              operationId: "op-1",
              status: "completed",
              deviceId: "dev-1",
              accountUpdatedAt: NOW,
              startedAt: NOW,
            },
          },
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      runs: [],
      comments: [],
    };
    const parsed = xhsOpsStoreDataSchema.parse(legacy);
    expect(parsed.audits).toEqual([]);
    expect(parsed.diagnoses).toEqual([]);
    expect(parsed.changeOrders).toEqual([]);
    const stored = parsed.accounts[0];
    expect(stored?.takeover).toBeNull();
    expect(stored?.toneGuide).toMatchObject({
      summary: "",
      pillars: [],
      confirmedAt: null,
    });
    expect(stored?.profileDraft.applyOperation?.changeOrderId).toBeNull();
    // Storage-only browse defaults for pre-target accounts are untouched.
    expect(stored?.browseDefaults).toMatchObject({
      dailyTargetPosts: 0,
      dailySegments: 1,
    });
    expect(
      xhsOpsStoreDataSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
  });

  it("fills every takeover default from an empty object", () => {
    expect(xhsOpsTakeoverSchema.parse({})).toEqual({
      authorizedAt: null,
      authorizationNote: "",
      identityConfirmedAt: null,
      identitySource: null,
      identityTaskId: null,
      identityScreenshotUrl: null,
      pendingIdentity: null,
      baselineAuditId: null,
      latestAuditId: null,
      activeAuditId: null,
      maturity: null,
      activeDiagnosisId: null,
      planConfirmedAt: null,
      keepAllPublic: false,
      skippedFields: [],
      safetyPause: null,
      pendingObservationFailure: null,
      resumeHistory: [],
      legacyVerified: false,
      prePlanSnapshot: null,
      paramOverrides: [],
      deviceHold: null,
      activeChangeOrderId: null,
      observationUntil: null,
      noNurtureDates: [],
      platformLimitNotices: [],
    });
    const snapshot = xhsOpsTakeoverSchema.parse({
      prePlanSnapshot: { label: "旧定位" },
    }).prePlanSnapshot;
    expect(snapshot?.browseDefaults.dailyTargetPosts).toBe(90);
    expect(snapshot?.toneGuide.commentStyle).toBe("");
  });

  it("keeps takeover and toneGuide out of client writes", () => {
    const created = xhsOpsAccountCreateSchema.parse({
      projectId: "proj-1",
      label: "新号",
      takeover: { authorizedAt: NOW },
      toneGuide: { summary: "伪造" },
    });
    expect("takeover" in created).toBe(false);
    expect("toneGuide" in created).toBe(false);
    const update = xhsOpsAccountUpdateSchema.parse({
      takeover: { planConfirmedAt: NOW },
      overrideReason: "  运营要求临时提高日目标  ",
    });
    expect("takeover" in update).toBe(false);
    expect(update.overrideReason).toBe("运营要求临时提高日目标");
    expect(() =>
      xhsOpsAccountUpdateSchema.parse({ overrideReason: " " }),
    ).toThrow();
  });

  it("round-trips an audit, a diagnosis and a change order", () => {
    const fullAudit = audit({
      profile: profilePart({}),
      home: homePart(counts("12", "1.2万", "999+"), ["笔记一"]),
      creator: creatorPart("1200"),
      flags: ["countsChanged"],
    });
    expect(
      xhsOpsAccountAuditSchema.parse(JSON.parse(JSON.stringify(fullAudit))),
    ).toEqual(fullAudit);

    const diagnosis = xhsOpsAccountDiagnosisSchema.parse({
      id: "diag-1",
      projectId: "proj-1",
      accountId: "acct-1",
      auditId: "audit-1",
      version: 1,
      status: "ready",
      playbookVersion: XHS_OPS_PLAYBOOK_VERSION,
      facts: { tier: "established" },
      cadence: { browseDefaults: {}, interaction: {}, rationale: [] },
      findings: [
        {
          id: "F1",
          dimension: "persona_fit",
          severity: "medium",
          summary: "内容主线与目标人群重叠低",
          evidence: ["home.notes[1]", "project.verticalInterests"],
          ruleIds: ["MT-01"],
        },
      ],
      proposals: [
        {
          id: "P1",
          kind: "interestPool",
          core: ["通勤护肤", "敏感肌", "早C晚A"],
          extended: ["通勤穿搭"],
          general: ["咖啡"],
          rationale: "旧主线留在扩展层过渡",
          findingIds: ["F1"],
          ruleIds: ["NU-08", "MT-04"],
          risk: "L0",
          batch: 0,
        },
        {
          id: "P2",
          kind: "profileField",
          field: "bio",
          to: "上海 | 通勤护肤",
          rationale: "简介补上护肤方向",
          ruleIds: ["PF-06"],
          risk: "L1",
          batch: 1,
        },
      ],
      decisions: { P1: { decision: "adopt", decidedAt: NOW } },
      generator: { botId: "bot-1", model: null },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(diagnosis.facts).toMatchObject({
      notesSeen: 0,
      feedMatch: "unknown",
    });
    expect(diagnosis.proposals[1]).toMatchObject({
      from: "",
      budgetBlockedUntil: null,
    });
    expect(
      xhsOpsAccountDiagnosisSchema.parse(JSON.parse(JSON.stringify(diagnosis))),
    ).toEqual(diagnosis);

    const order = xhsOpsChangeOrderSchema.parse({
      id: "co-1",
      projectId: "proj-1",
      accountId: "acct-1",
      deviceId: "dev-1",
      platformAccountId: "xhs-123",
      diagnosisId: "diag-1",
      proposalIds: ["P5"],
      batchIndex: 3,
      risk: "L2",
      fields: [{ field: "avatar", baselineValue: "", after: "浅色背景半身照" }],
      status: "observing",
      observation: {
        until: NOW,
        auditId: null,
        baseAuditId: "audit-1",
        visualChecks: {
          avatar: { screenshotUrl: null, result: "match", at: NOW },
        },
        verdict: "inconclusive",
        notes: [],
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(order.fields[0]).toMatchObject({
      before: "",
      outcome: "pending",
      visualCheck: null,
      imageSha256: null,
    });
    expect(order.acks).toEqual({});
    expect(
      xhsOpsChangeOrderSchema.parse(JSON.parse(JSON.stringify(order))),
    ).toEqual(order);
  });

  it("enforces the diagnosis output limits", () => {
    const finding = {
      id: "F1",
      dimension: "risk",
      severity: "low",
      summary: "近期有安全停止",
      evidence: ["facts.recentSafetyStops"],
      ruleIds: ["NU-05"],
    };
    expect(xhsOpsFindingSchema.safeParse(finding).success).toBe(true);
    for (const broken of [
      { ...finding, id: "X1" },
      { ...finding, evidence: [] },
      { ...finding, evidence: ["audit.raw"] },
      { ...finding, ruleIds: [] },
      { ...finding, ruleIds: ["nu-05"] },
      { ...finding, ruleIds: ["NU-05", "NU-01", "MT-01", "MT-02"] },
      { ...finding, summary: "长".repeat(121) },
    ]) {
      expect(xhsOpsFindingSchema.safeParse(broken).success).toBe(false);
    }
    const base = { id: "P1", rationale: "", ruleIds: ["PF-03"] };
    for (const field of ["gender", "birthday", "platformAccountId"]) {
      expect(
        xhsOpsProposalSchema.safeParse({
          ...base,
          kind: "profileField",
          field,
          to: "x",
        }).success,
      ).toBe(false);
    }
    expect(
      xhsOpsProposalSchema.safeParse({
        ...base,
        kind: "noteAction",
        noteIndex: 1,
        action: "delete",
      }).success,
    ).toBe(false);
    expect(
      xhsOpsProposalSchema.safeParse({
        ...base,
        kind: "interestPool",
        core: ["a", "b"],
        extended: [],
        general: [],
      }).success,
    ).toBe(false);
  });

  it("validates the takeover request bodies", () => {
    expect(
      xhsOpsTakeoverAuthorizeBodySchema.safeParse({
        expectedUpdatedAt: NOW,
        ownershipConfirmed: false,
      }).success,
    ).toBe(false);
    expect(
      xhsOpsChangeOrderConfirmBodySchema.safeParse({
        confirmDigest: "a".repeat(64),
        expectedUpdatedAt: NOW,
        acks: { photoPermission: true },
      }).success,
    ).toBe(true);
    expect(
      xhsOpsChangeOrderConfirmBodySchema.safeParse({
        confirmDigest: "not-a-digest",
        expectedUpdatedAt: NOW,
        acks: {},
      }).success,
    ).toBe(false);
    expect(
      xhsOpsChangeOrderImageBodySchema.safeParse({
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        expectedUpdatedAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      xhsOpsChangeOrderImageBodySchema.safeParse({
        dataUrl: "data:image/gif;base64,R0lGOD==",
        expectedUpdatedAt: NOW,
      }).success,
    ).toBe(false);
  });

  it("carries the phone's policy mode on device info", () => {
    const device = {
      deviceId: "dev-1",
      status: "idle",
      connectedAt: 1,
      lastSeen: 2,
    };
    expect(deviceInfoSchema.parse(device).devicePolicyMode).toBeUndefined();
    expect(
      deviceInfoSchema.parse({ ...device, devicePolicyMode: "enforce" })
        .devicePolicyMode,
    ).toBe("enforce");
    expect(
      deviceInfoSchema.safeParse({ ...device, devicePolicyMode: "strict" })
        .success,
    ).toBe(false);
  });
});

describe("XHS_OPS_PLAYBOOK (§4.5)", () => {
  const SOURCE_REF =
    /^(?:本方案|(?:xhs\/references\/[a-z-]+\.md|apps\/[A-Za-z0-9._/-]+)(?::\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)?)(?:（[^（）]+）)?$/;
  const PREFIX_TOPIC: Record<string, string> = {
    ID: "identity",
    PF: "profile",
    MT: "takeover",
    NU: "nurture",
    TN: "tone",
    RK: "risk",
    MX: "metrics",
  };

  it("contains every rule of the design table under a unique id", () => {
    const ids = XHS_OPS_PLAYBOOK.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "ID-01",
      "PF-01",
      "PF-02",
      "PF-03",
      "PF-04",
      "PF-05",
      "PF-06",
      "PF-07",
      "MT-01",
      "MT-02",
      "MT-03",
      "MT-04",
      "NU-01",
      "NU-04",
      "NU-05",
      "NU-08",
      "TN-01",
      "TN-02",
      "TN-06",
      "TN-08",
      "RK-03",
      "RK-04",
      "MX-01",
    ]) {
      expect(ids).toContain(id);
    }
    expect(ids.length).toBeGreaterThanOrEqual(28);
    expect(ids.length).toBeLessThanOrEqual(36);
  });

  it("is valid against the rule schema and the diagnosis rule-id format", () => {
    for (const rule of XHS_OPS_PLAYBOOK) {
      expect(xhsOpsPlaybookRuleSchema.parse(rule)).toEqual(rule);
      expect(PREFIX_TOPIC[rule.id.slice(0, 2)]).toBe(rule.topic);
      expect(XHS_OPS_PLAYBOOK_CATEGORY[rule.confidence]).toBeDefined();
      expect(
        xhsOpsFindingSchema.shape.ruleIds.safeParse([rule.id]).success,
      ).toBe(true);
    }
  });

  it("cites sources in the documented format, with in-repo paths that exist", () => {
    for (const rule of XHS_OPS_PLAYBOOK) {
      for (const ref of rule.source.split("；")) {
        expect(ref, `${rule.id}: ${ref}`).toMatch(SOURCE_REF);
        const repoPath = /^apps\/[^:（]+/.exec(ref)?.[0];
        if (repoPath)
          expect(existsSync(path.join(REPO_ROOT, repoPath)), repoPath).toBe(
            true,
          );
      }
    }
  });

  it("gives every doc rule a short excerpt, a bundle version and a phone-skills line", () => {
    for (const rule of XHS_OPS_PLAYBOOK.filter((r) => r.confidence === "doc")) {
      expect(rule.excerpt?.length, rule.id).toBeGreaterThan(0);
      expect(rule.excerpt?.length ?? 0, rule.id).toBeLessThanOrEqual(40);
      expect(rule.bundleVersion, rule.id).toBe(PHONE_SKILLS_BUNDLE);
      expect(rule.source, rule.id).toMatch(/xhs\/references\/[a-z-]+\.md:\d/);
    }
  });

  it("exports the phone-skills bundle it was checked against, for the card's device check (§3.5)", () => {
    expect(Number.isInteger(PHONE_SKILLS_BUNDLE)).toBe(true);
    expect(PHONE_SKILLS_BUNDLE).toBeGreaterThan(0);
    // Every recorded bundle comes from the one constant the card compares
    // DeviceInfo.skillBundleVersion with, and the package root exports it.
    expect(
      new Set(
        XHS_OPS_PLAYBOOK.flatMap((rule) =>
          rule.bundleVersion === undefined ? [] : [rule.bundleVersion],
        ),
      ),
    ).toEqual(new Set([PHONE_SKILLS_BUNDLE]));
    expect(shared.PHONE_SKILLS_BUNDLE).toBe(PHONE_SKILLS_BUNDLE);
  });

  it("is unsigned until ops or product sign it off (D8) and mostly applies to takeovers", () => {
    expect(XHS_OPS_PLAYBOOK.every((rule) => rule.signedOffAt === null)).toBe(
      true,
    );
    expect(
      XHS_OPS_PLAYBOOK.filter((rule) => rule.appliesTo.includes("existing"))
        .length,
    ).toBe(XHS_OPS_PLAYBOOK.length);
    expect(XHS_OPS_PLAYBOOK_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});

describe("xhsOpsChangeOrderFinishedEvent (T8)", () => {
  const UNTIL = "2026-10-23T08:00:00.000Z";

  function changeOrder(overrides: Record<string, unknown> = {}) {
    return xhsOpsChangeOrderSchema.parse({
      id: "co-7",
      projectId: "proj-1",
      accountId: "acct-1",
      deviceId: "dev-1",
      platformAccountId: "xhs-123",
      diagnosisId: "diag-1",
      proposalIds: ["P3", "P4"],
      batchIndex: 1,
      risk: "L1",
      fields: [
        {
          field: "bio",
          baselineValue: "上海 | 通勤穿搭",
          before: "上海 | 通勤穿搭",
          after: "通勤护肤记录 vx: lin_2024abc",
          outcome: "verified",
        },
        {
          field: "occupation",
          baselineValue: "时尚博主",
          before: "时尚博主",
          after: "互联网运营",
          outcome: "failed",
          code: "option_not_found",
        },
      ],
      status: "observing",
      confirmedAt: NOW,
      applyTaskId: "apply-1",
      observation: {
        until: UNTIL,
        auditId: null,
        baseAuditId: "audit-1",
        verdict: "pending",
        notes: [],
      },
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    });
  }

  function finished(
    input: Parameters<typeof xhsOpsChangeOrderFinishedEvent>[0],
  ): XhsOpsChangeOrderFinishedEvent {
    const event = xhsOpsChangeOrderFinishedEvent(input);
    if (!event) throw new Error("expected an event");
    return event;
  }

  it("stays silent while the order is still on its way", () => {
    for (const status of [
      "draft",
      "prechecking",
      "awaiting_confirm",
      "applying",
      "verifying",
      "awaiting_visual_check",
      "awaiting_manual_check",
      "interrupted",
    ])
      expect(
        xhsOpsChangeOrderFinishedEvent({
          order: changeOrder({ status }),
          account: null,
        }),
      ).toBeNull();
    // The observation is announced once: its review reports as completed or failed.
    expect(
      xhsOpsChangeOrderFinishedEvent({
        order: changeOrder({
          observation: {
            until: UNTIL,
            auditId: "audit-2",
            baseAuditId: "audit-1",
            verdict: "inconclusive",
            notes: ["等待人工对照图片：头像"],
          },
        }),
        account: null,
      }),
    ).toBeNull();
  });

  it("reports field names, outcomes, the batch and the observation deadline, never a value", () => {
    const event = finished({
      order: changeOrder(),
      account: account({ takeover: takeover() }),
    });
    expect(xhsOpsTakeoverEventSchema.parse(event).name).toBe(
      XHS_OPS_CHANGE_ORDER_FINISHED_EVENT,
    );
    expect(event.payload).toMatchObject({
      projectId: "proj-1",
      accountId: "acct-1",
      orderId: "co-7",
      batchIndex: 1,
      risk: "L1",
      rollback: false,
      status: "observing",
      observationUntil: UNTIL,
      verdict: "pending",
      notes: [],
      reason: null,
      pauseCode: null,
      fields: [
        { field: "bio", label: "简介", outcome: "verified", code: null },
        {
          field: "occupation",
          label: "职业",
          outcome: "failed",
          code: "option_not_found",
        },
      ],
    });
    const text = JSON.stringify(event);
    for (const secret of [
      "上海 | 通勤穿搭",
      "时尚博主",
      "通勤护肤记录",
      "lin_2024abc",
      "互联网运营",
      "xhs-123",
    ])
      expect(text).not.toContain(secret);
    expect(event.payload.agentInstruction).toContain(
      "第 1 批资料变更（简介、职业）",
    );
    expect(event.payload.agentInstruction).toContain("observationUntil");
    expect(event.payload.agentInstruction).toContain("不要重试或修改任何值");
  });

  it("explains a failure with a masked reason and the pause in force", () => {
    const event = finished({
      order: changeOrder({
        status: "failed",
        error: "复查时号码核对不一致 xhs-123，联系 13812345678",
        observation: {
          until: UNTIL,
          auditId: "audit-2",
          baseAuditId: "audit-1",
          verdict: "fail",
          notes: ["复查时号码核对不一致"],
        },
      }),
      account: account({
        takeover: takeover({
          safetyPause: {
            code: "observation_failed",
            reason: "复查时号码核对不一致",
            sourceRef: "co-7",
            since: NOW,
          },
        }),
      }),
    });
    expect(event.payload).toMatchObject({
      status: "failed",
      verdict: "fail",
      pauseCode: "observation_failed",
      notes: ["复查时号码核对不一致"],
    });
    expect(event.payload.reason).toContain("[小红书号]");
    expect(event.payload.reason).toContain("[电话]");
    expect(JSON.stringify(event)).not.toContain("xhs-123");
    expect(JSON.stringify(event)).not.toContain("13812345678");
    expect(event.payload.agentInstruction).toContain("账号已暂停接管");
  });

  it("names rollbacks, flags a warn review and says a cancel changed nothing", () => {
    const completed = finished({
      order: changeOrder({
        status: "completed",
        rollbackOfId: "co-1",
        observation: {
          until: UNTIL,
          auditId: "audit-2",
          baseAuditId: "audit-1",
          verdict: "warn",
          notes: ["粉丝从 800 降到 760，减少 40"],
        },
      }),
      account: null,
    });
    expect(completed.payload).toMatchObject({
      rollback: true,
      verdict: "warn",
      notes: ["粉丝从 800 降到 760，减少 40"],
    });
    expect(completed.payload.agentInstruction).toContain("回滚单");
    expect(completed.payload.agentInstruction).toContain("额外确认");

    const cancelled = finished({
      order: changeOrder({
        status: "cancelled",
        error: "已取消",
        observation: null,
      }),
      account: null,
    });
    expect(cancelled.payload).toMatchObject({
      status: "cancelled",
      observationUntil: null,
      verdict: null,
      reason: "已取消",
    });
    expect(cancelled.payload.agentInstruction).toContain("没有因为这张单改动");
  });

  it("is one of the events the takeover responses declare", () => {
    expect(xhsOpsTakeoverEventSchema.shape.name.options).toEqual([
      XHS_OPS_TAKEOVER_IDENTITY_LOCKED_EVENT,
      XHS_OPS_ACCOUNT_AUDITED_EVENT,
      XHS_OPS_ACCOUNT_DIAGNOSED_EVENT,
      XHS_OPS_TAKEOVER_PLAN_CONFIRMED_EVENT,
      XHS_OPS_CHANGE_ORDER_FINISHED_EVENT,
    ]);
  });
});

describe("xhsOpsRedactContact (D6, A7)", () => {
  it("masks the forms that used to slip through", () => {
    expect(xhsOpsRedactContact("电话１３８１２３４５６７８")).toBe(
      "[联系方式]",
    );
    expect(xhsOpsRedactContact("找我１３８１２３４５６７８")).toBe(
      "找我[电话]",
    );
    expect(xhsOpsRedactContact("备用 １３８１２３４５６７８ 找我")).toBe(
      "备用 [电话] 找我",
    );
    for (const text of [
      "微 信：xiaoming88",
      "微信号是xiaoming88",
      "微信号码为 xiaoming88",
      "v：xiaoming88",
      "V: xiaoming88",
      "vx xiaoming88",
      "wechat id: xiaoming88",
      "WeChat ID：xiaoming88",
      "ｖｘ：ｘｉａｏｍｉｎｇ８８",
      "扣 扣 12345abc",
    ]) {
      const masked = xhsOpsRedactContact(text);
      expect(masked, text).toContain("[联系方式]");
      expect(masked, text).not.toContain("xiaoming88");
    }
  });

  it("keeps the text around a mask as it was written", () => {
    expect(
      xhsOpsRedactContact("合作加ｖｘ：ｘｉａｏｍｉｎｇ８８，谢谢（上）"),
    ).toBe("合作加[联系方式]，谢谢（上）");
    expect(xhsOpsRedactContact("１３８１２３４５６７８，全角逗号")).toBe(
      "[电话]，全角逗号",
    );
  });

  it("leaves ordinary text exactly as it was", () => {
    for (const text of [
      "视频",
      "vlog",
      "周末 vlog 第3期",
      "vlog博主日常",
      "我的 vlog: daily",
      "微信读书推荐",
      "手机壳测评",
      "通勤穿搭合集 第3篇",
      "全角标点：好物分享（上）～",
      "ＭＢＴＩ：ＩＮＦＰ",
      "2024年第12期",
    ]) {
      expect(xhsOpsRedactContact(text), text).toBe(text);
    }
  });
});

describe("xhsOpsAccountDiagnosedEvent masks the region (A9)", () => {
  const diagnosis = xhsOpsAccountDiagnosisSchema.parse({
    id: "diag-1",
    projectId: "proj-1",
    accountId: "acct-1",
    auditId: "audit-1",
    version: 1,
    status: "ready",
    playbookVersion: XHS_OPS_PLAYBOOK_VERSION,
    facts: { tier: "established" },
    cadence: { browseDefaults: {}, interaction: {}, rationale: [] },
    summary:
      "深圳的通勤女生账号，中国 广东 深圳 南山区 一带，小红书号 49268961587",
    findings: [
      {
        id: "F1",
        dimension: "persona_fit",
        severity: "medium",
        summary: "内容多写深圳本地探店",
        evidence: ["home.notes[1]"],
        ruleIds: ["MT-01"],
      },
    ],
    questions: [
      {
        id: "Q1",
        text: "要继续写深圳吗？",
        options: ["继续写深圳", "转向通勤"],
        answer: null,
      },
    ],
    generator: { botId: "bot-1", model: null },
    createdAt: NOW,
    updatedAt: NOW,
  });
  const account = {
    id: "acct-1",
    projectId: "proj-1",
    platformAccountId: "49268961587",
  };

  it("masks the region as read and its city in every free-text field", () => {
    const { payload } = xhsOpsAccountDiagnosedEvent({
      account,
      diagnosis,
      region: { value: "中国 广东 深圳 南山区", city: "深圳" },
    });
    const free = JSON.stringify([
      payload.summary,
      payload.findings,
      payload.questions,
    ]);
    expect(free).not.toContain("深圳");
    expect(free).not.toContain("南山区");
    expect(free).not.toContain("49268961587");
    expect(payload.summary).toBe(
      "[地区]的通勤女生账号，[地区] 一带，小红书号 [小红书号]",
    );
    expect(payload.questions[0]).toEqual({
      id: "Q1",
      text: "要继续写[地区]吗？",
      options: ["继续写[地区]", "转向通勤"],
    });
  });

  it("masks only the 小红书号 without a region", () => {
    const { payload } = xhsOpsAccountDiagnosedEvent({ account, diagnosis });
    expect(payload.findings[0]?.summary).toBe("内容多写深圳本地探店");
    expect(payload.summary).toContain("[小红书号]");
  });
});

describe("xhsOpsTakeoverDormantReviewDue (§6.3 沉寂档一周提示)", () => {
  const DAY = 86_400_000;
  const CONFIRMED = "2026-10-01T08:00:00.000Z";
  const FIRST_RUN = "2026-10-01T10:00:00.000Z";
  const DUE_AT = Date.parse(FIRST_RUN) + XHS_TAKEOVER_DORMANT_REVIEW_DAYS * DAY;
  const dormant = XHS_TAKEOVER_TIER_CADENCE.dormant;

  type ReviewRun = Parameters<typeof xhsOpsTakeoverDormantReviewDue>[1][number];

  function dormantAccount(
    takeoverOverrides: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ) {
    return account({
      browseDefaults: {
        dailyTargetPosts: dormant.dailyTargetPosts,
        dailySegments: dormant.dailySegments,
        searchRatioPercent: dormant.searchRatioPercent,
      },
      takeover: takeover({
        maturity: "dormant",
        planConfirmedAt: CONFIRMED,
        ...takeoverOverrides,
      }),
      ...overrides,
    });
  }

  function run(
    overrides: Partial<Omit<ReviewRun, "plan">> & {
      kind?: "browse" | "comment";
    } = {},
  ): ReviewRun {
    const { kind, ...rest } = overrides;
    return {
      accountId: "acct-1",
      status: "completed",
      startedAt: FIRST_RUN,
      plan: {
        ...(kind ? { kind } : {}),
        keywords: kind === "comment" ? [] : [{ keyword: "通勤护肤", count: 8 }],
        homeFeedCount: kind === "comment" ? 0 : 6,
        dwellSecMin: 11,
        dwellSecMax: 20,
        interaction: xhsOpsInteractionConfigSchema.parse({}),
      },
      ...rest,
    };
  }

  it("is due a full week after the first nurture run since the plan was confirmed", () => {
    const account = dormantAccount();
    expect(xhsOpsTakeoverDormantReviewDue(account, [run()], DUE_AT)).toBe(true);
    expect(xhsOpsTakeoverDormantReviewDue(account, [run()], DUE_AT - 1)).toBe(
      false,
    );
    // The earliest qualifying run counts, whatever the order of the list.
    const later = run({
      startedAt: new Date(Date.parse(FIRST_RUN) + 3 * DAY).toISOString(),
    });
    expect(
      xhsOpsTakeoverDormantReviewDue(account, [later, run()], DUE_AT),
    ).toBe(true);
    // Raised a little by hand, still below the suggestion: still offered.
    expect(
      xhsOpsTakeoverDormantReviewDue(
        dormantAccount(
          {},
          {
            browseDefaults: {
              dailyTargetPosts: 45,
              dailySegments: 2,
              searchRatioPercent: 80,
            },
          },
        ),
        [run()],
        DUE_AT,
      ),
    ).toBe(true);
  });

  it("is not due yet without a completed nurture run of this account since the confirmation", () => {
    const account = dormantAccount();
    const monthLater = DUE_AT + 30 * DAY;
    expect(xhsOpsTakeoverDormantReviewDue(account, [], monthLater)).toBe(false);
    for (const [label, entry] of [
      // Nurture before the plan was confirmed (a legacy-verified account) does not count.
      [
        "before the plan",
        run({
          startedAt: new Date(Date.parse(CONFIRMED) - DAY).toISOString(),
        }),
      ],
      ["a comment run", run({ kind: "comment" })],
      ["a failed run", run({ status: "failed" })],
      ["a cancelled run", run({ status: "cancelled" })],
      ["a run still going", run({ status: "running" })],
      ["a run that never started", run({ startedAt: null })],
      ["another account's run", run({ accountId: "acct-2" })],
    ] as const)
      expect(
        xhsOpsTakeoverDormantReviewDue(account, [entry], monthLater),
        label,
      ).toBe(false);
  });

  it("is not offered again once the daily target reached the suggestion", () => {
    for (const dailyTargetPosts of [
      XHS_TAKEOVER_DORMANT_REVIEW_BROWSE.dailyTargetPosts,
      80,
    ])
      expect(
        xhsOpsTakeoverDormantReviewDue(
          dormantAccount(
            {},
            {
              browseDefaults: {
                ...XHS_TAKEOVER_DORMANT_REVIEW_BROWSE,
                dailyTargetPosts,
              },
            },
          ),
          [run()],
          DUE_AT,
        ),
        String(dailyTargetPosts),
      ).toBe(false);
  });

  it("only concerns a dormant takeover whose plan is confirmed", () => {
    for (const tier of ["starter", "growing", "established"] as const)
      expect(
        xhsOpsTakeoverDormantReviewDue(
          dormantAccount({ maturity: tier }),
          [run()],
          DUE_AT,
        ),
        tier,
      ).toBe(false);
    for (const [label, candidate] of [
      ["no tier", dormantAccount({ maturity: null })],
      ["plan not confirmed", dormantAccount({ planConfirmedAt: null })],
      ["no takeover", account({ takeover: null })],
      ["a new account", dormantAccount({}, { entryMode: "new" })],
    ] as const)
      expect(
        xhsOpsTakeoverDormantReviewDue(candidate, [run()], DUE_AT),
        label,
      ).toBe(false);
  });

  it("suggests 60 / 2 / 80 %: 24 search, 6 home and 3 words a segment, an override above the dormant tier", () => {
    expect(XHS_TAKEOVER_DORMANT_REVIEW_MESSAGE).toBe(
      "建议调整到 60 / 2 / 80%（每段 24 / 6 / 3），之后按体量定档",
    );
    expect(XHS_TAKEOVER_DORMANT_REVIEW_BROWSE).toEqual({
      dailyTargetPosts: 60,
      dailySegments: 2,
      searchRatioPercent: 80,
    });
    // 30 a segment: 24 searched over at least 3 words, 6 from the home feed.
    expect(
      xhsOpsPlanBudgetIssues(XHS_TAKEOVER_DORMANT_REVIEW_BROWSE, 3),
    ).toEqual([]);
    expect(
      xhsOpsPlanBudgetIssues(XHS_TAKEOVER_DORMANT_REVIEW_BROWSE, 2),
    ).toEqual([
      "本段搜索目标 24 篇至少需要 3 个兴趣词，当前只有 2 个，请补充兴趣池或增加每日分段",
    ]);
    // Written with the dormant like caps kept, only the target is past the tier.
    const suggested = account({
      browseDefaults: XHS_TAKEOVER_DORMANT_REVIEW_BROWSE,
      interaction: {
        like: {
          enabled: true,
          dailyCap: dormant.likeDailyCap,
          ratioPercent: dormant.likeRatioPercent,
        },
      },
    });
    expect(xhsOpsTakeoverPlanIssues(suggested, "dormant")).toEqual([
      {
        field: "browseDefaults.dailyTargetPosts",
        message: "日目标 60 篇超过接管档位（沉寂档）上限 30 篇",
        overridable: true,
      },
    ]);
  });
});

describe("xhsOpsAlreadyLikedSkippedByDate (§6.3 已赞跳过 k 篇, NU-04)", () => {
  const summary = (alreadyLikedSkipped?: number) =>
    xhsOpsRunSummarySchema.parse(
      alreadyLikedSkipped === undefined ? {} : { alreadyLikedSkipped },
    );
  const runs = [
    { accountId: "acct-1", date: "2026-10-20", summary: summary(3) },
    // The day's second segment adds to the first.
    { accountId: "acct-1", date: "2026-10-20", summary: summary(2) },
    { accountId: "acct-1", date: "2026-10-21", summary: summary(1) },
    // Nothing skipped that day: summarizeRun leaves the field out.
    { accountId: "acct-1", date: "2026-10-22", summary: summary() },
    { accountId: "acct-2", date: "2026-10-20", summary: summary(4) },
  ];

  it("sums one account's runs per day and leaves out days with nothing skipped", () => {
    expect(xhsOpsAlreadyLikedSkippedByDate(runs, "acct-1")).toEqual({
      "2026-10-20": 5,
      "2026-10-21": 1,
    });
    expect(xhsOpsAlreadyLikedSkippedByDate(runs, "acct-3")).toEqual({});
  });

  it("sums every account without an account id", () => {
    expect(xhsOpsAlreadyLikedSkippedByDate(runs)).toEqual({
      "2026-10-20": 9,
      "2026-10-21": 1,
    });
  });

  it("is empty for runs that never reported it, as a new account's", () => {
    expect(
      xhsOpsAlreadyLikedSkippedByDate([
        { accountId: "acct-1", date: "2026-10-20", summary: summary() },
        { accountId: "acct-1", date: "2026-10-21", summary: summary(0) },
      ]),
    ).toEqual({});
  });
});

describe("takeover events: privacy sweep over every builder (D6, §8.2 隐私)", () => {
  const XHS_ID = "49268961587";
  const BIRTHDAY = "1996-03-12";
  const REGION = "中国 浙江 杭州";
  const NEW_REGION = "中国 江苏 苏州";
  /** What stays on the card: the 小红书号, the birthday, the region as read or as it would be written, whole or piece by piece. */
  const SECRETS = [
    XHS_ID,
    BIRTHDAY,
    "1996",
    REGION,
    "中国浙江杭州",
    "浙江",
    "杭州",
    NEW_REGION,
    "江苏",
    "苏州",
  ];

  // The account row the card hands in, every secret on it: the 小红书号,
  // a pending identity read, the draft's birthday and region, the persona's region.
  const takenOver = account({
    platformAccountId: XHS_ID,
    deviceName: "一号机",
    persona: {
      region: "浙江 杭州",
      age: "30岁",
      gender: "女",
      occupation: "运营",
      lifeStatus: "通勤族",
    },
    profileDraft: { birthday: BIRTHDAY, region: REGION, gender: "女" },
    takeover: takeover({
      maturity: "growing",
      pendingIdentity: {
        taskId: "identity-2",
        deviceId: "dev-1",
        readAt: NOW,
        screenshotUrl: null,
        readAccountId: XHS_ID,
      },
    }),
  });

  // An audit as the phone read it: the archive's region and a filled
  // birthday, a contact in the bio, the 小红书号 in a note title.
  function sweptAudit(id: string, followers: string, region: string) {
    return audit({
      id,
      platformAccountId: XHS_ID,
      profile: profilePart({
        bio: "通勤护肤 | 敏感肌 vx: lin_2024abc",
        region,
        birthdayFilled: true,
      }),
      home: homePart(
        counts("12", followers, "999+"),
        ["通勤护肤分享", `合作看主页 ${XHS_ID}`],
        true,
      ),
      creator: creatorPart("1200"),
    });
  }
  const baseAudit = sweptAudit("audit-1", "800", REGION);
  const reviewAudit = sweptAudit("audit-2", "760", NEW_REGION);

  // LLM text may echo the city it saw and the 小红书号 a title carried.
  const diagnosis = xhsOpsAccountDiagnosisSchema.parse({
    id: "diag-sweep",
    projectId: "proj-1",
    accountId: "acct-1",
    auditId: "audit-1",
    version: 2,
    status: "ready",
    playbookVersion: XHS_OPS_PLAYBOOK_VERSION,
    facts: { tier: "growing" },
    cadence: { browseDefaults: {}, interaction: {}, rationale: [] },
    inferredPersona: {
      persona: {
        region: "浙江 杭州",
        age: "30岁",
        gender: "女",
        occupation: "运营",
        lifeStatus: "通勤族",
      },
      contentLine: "杭州通勤护肤",
      confidence: "medium",
    },
    summary: `杭州的通勤护肤账号（小红书号 ${XHS_ID}），资料写着中国浙江杭州`,
    findings: [
      {
        id: "F1",
        dimension: "persona_fit",
        severity: "medium",
        summary: "笔记多写浙江 杭州周边",
        evidence: ["home.notes[1]"],
        ruleIds: ["MT-01"],
      },
    ],
    questions: [
      {
        id: "Q1",
        text: "地区要从杭州改成苏州吗？",
        options: ["保留杭州", "改成苏州"],
        answer: null,
      },
    ],
    proposals: [
      {
        id: "P1",
        kind: "interestPool",
        core: ["通勤护肤", "敏感肌", "早C晚A"],
        extended: ["通勤穿搭"],
        general: ["咖啡"],
        rationale: "旧主线留在扩展层过渡",
        findingIds: ["F1"],
        ruleIds: ["NU-08", "MT-04"],
        risk: "L0",
        batch: 0,
      },
      {
        id: "P2",
        kind: "profileField",
        field: "region",
        from: REGION,
        to: NEW_REGION,
        rationale: "人搬到了苏州",
        ruleIds: ["PF-06"],
        risk: "L2",
        batch: 2,
      },
    ],
    dropped: [{ ref: "P9", reason: `提议把地区改回${REGION}` }],
    decisions: {
      P1: { decision: "adopt", decidedAt: NOW },
      P2: { decision: "adopt", decidedAt: NOW },
    },
    generator: { botId: "bot-1", model: null },
    createdAt: NOW,
    updatedAt: NOW,
  });

  function order(overrides: Record<string, unknown> = {}) {
    return xhsOpsChangeOrderSchema.parse({
      id: "co-region",
      projectId: "proj-1",
      accountId: "acct-1",
      deviceId: "dev-1",
      platformAccountId: XHS_ID,
      diagnosisId: "diag-sweep",
      proposalIds: ["P2"],
      batchIndex: 2,
      risk: "L2",
      fields: [
        {
          field: "region",
          baselineValue: REGION,
          before: REGION,
          after: NEW_REGION,
          outcome: "verified",
        },
      ],
      status: "draft",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    });
  }
  const observation = (verdict: string, notes: string[]) => ({
    until: "2026-10-27T08:00:00.000Z",
    auditId: verdict === "pending" ? null : "audit-2",
    baseAuditId: "audit-1",
    verdict,
    notes,
  });
  const comparison = compareXhsOpsAudits(baseAudit, reviewAudit);
  const failedReview = xhsOpsObservationVerdict({
    risk: "L2",
    comparison,
    accountMatched: false,
    signals: ["rate_limited"],
    fieldMismatches: ["region"],
    images: [],
  });
  const warnedReview = xhsOpsObservationVerdict({
    risk: "L2",
    comparison,
    accountMatched: true,
    signals: [],
    fieldMismatches: [],
    images: [],
  });

  function finished(
    input: Parameters<typeof xhsOpsChangeOrderFinishedEvent>[0],
  ) {
    const event = xhsOpsChangeOrderFinishedEvent(input);
    if (!event) throw new Error("expected an event");
    return event;
  }

  it("masks a custom 小红书号 the contact patterns cannot see in an audit's texts", () => {
    const custom = "lin_tongqin";
    const event = xhsOpsAccountAuditedEvent({
      account: takenOver,
      audit: audit({
        platformAccountId: custom,
        profile: profilePart({
          nickname: `通勤日记 ${custom}`,
          bio: `通勤护肤 | 搜 ${custom} 找我`,
        }),
        home: homePart(
          counts("12", "800", "999+"),
          [`合作看主页 ${custom}`],
          true,
        ),
      }),
      baseline: false,
    });
    expect(JSON.stringify(event.payload)).not.toContain(custom);
    expect(event.payload.profile).toMatchObject({
      nickname: "通勤日记 [小红书号]",
      bio: "通勤护肤 | 搜 [小红书号] 找我",
    });
    expect(event.payload.notes[0]?.title).toBe("合作看主页 [小红书号]");
  });

  it("keeps the 小红书号, the birthday and the region out of every takeover event", () => {
    // The sweep inputs really carry the secrets the events must drop.
    expect(comparison.profileChanges).toContainEqual({
      field: "region",
      base: REGION,
      target: NEW_REGION,
    });
    expect(warnedReview.verdict).toBe("warn");
    expect(failedReview.verdict).toBe("fail");
    const paused = account({
      ...takenOver,
      takeover: {
        ...takenOver.takeover,
        safetyPause: {
          code: "observation_failed",
          reason: failedReview.notes[0] ?? "观察期复查未通过",
          sourceRef: "co-region",
          since: NOW,
        },
      },
    });
    const diagnosed = xhsOpsAccountDiagnosedEvent({
      account: takenOver,
      diagnosis,
      // The region as the audit read it, and the city the LLM saw.
      region: { value: REGION, city: "杭州" },
    });
    // The region a proposal would write is masked like the one read.
    expect(diagnosed.payload.questions).toEqual([
      {
        id: "Q1",
        text: "地区要从[地区]改成[地区]吗？",
        options: ["保留[地区]", "改成[地区]"],
      },
    ]);
    const events: Record<string, unknown[]> = {
      [XHS_OPS_TAKEOVER_IDENTITY_LOCKED_EVENT]: [
        xhsOpsTakeoverIdentityLockedEvent(takenOver),
      ],
      [XHS_OPS_ACCOUNT_AUDITED_EVENT]: [
        xhsOpsAccountAuditedEvent({
          account: takenOver,
          audit: baseAudit,
          baseline: true,
        }),
        xhsOpsAccountAuditedEvent({
          account: takenOver,
          audit: reviewAudit,
          baseline: false,
        }),
      ],
      [XHS_OPS_ACCOUNT_DIAGNOSED_EVENT]: [
        diagnosed,
        xhsOpsAccountDiagnosedEvent({
          account: takenOver,
          diagnosis: xhsOpsAccountDiagnosisSchema.parse({
            ...diagnosis,
            status: "failed",
            error: "诊断生成失败（生成超时），请点「再生成方案」重试",
          }),
          region: { value: REGION, city: "杭州" },
        }),
      ],
      [XHS_OPS_TAKEOVER_PLAN_CONFIRMED_EVENT]: [
        xhsOpsTakeoverPlanConfirmedEvent({
          account: takenOver,
          diagnosis: { ...diagnosis, status: "confirmed", confirmedAt: NOW },
          changeOrders: [
            order({
              fields: [
                { field: "region", baselineValue: REGION, after: NEW_REGION },
              ],
            }),
          ],
          skippedFields: [{ field: "nickname", reason: "手机上已是目标值" }],
        }),
      ],
      [XHS_OPS_CHANGE_ORDER_FINISHED_EVENT]: [
        finished({
          order: order({
            status: "observing",
            observation: observation("pending", []),
          }),
          account: takenOver,
        }),
        finished({
          order: order({
            status: "completed",
            observation: observation("warn", warnedReview.notes),
          }),
          account: takenOver,
        }),
        finished({
          order: order({
            status: "failed",
            error: `复查时号码核对不一致：手机上是 ${XHS_ID}`,
            observation: observation("fail", failedReview.notes),
          }),
          account: paused,
        }),
        finished({
          order: order({
            status: "cancelled",
            error: "已取消",
            fields: [
              {
                field: "region",
                baselineValue: REGION,
                before: REGION,
                after: NEW_REGION,
              },
            ],
          }),
          account: null,
        }),
      ],
    };
    // Every event the takeover responses declare is swept.
    expect(Object.keys(events).sort()).toEqual(
      [...xhsOpsTakeoverEventSchema.shape.name.options].sort(),
    );
    for (const [name, list] of Object.entries(events))
      for (const [index, event] of list.entries()) {
        expect(xhsOpsTakeoverEventSchema.parse(event).name).toBe(name);
        const text = JSON.stringify(event);
        for (const secret of SECRETS)
          expect(text, `${name}[${index}] carries ${secret}`).not.toContain(
            secret,
          );
      }
  });
});
