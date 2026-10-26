import {
  XHS_OPS_PLAN_MAX_POSTS_PER_KEYWORD,
  XHS_TAKEOVER_TIER_CADENCE,
  XHS_TAKEOVER_TIER_LABEL,
  type XhsOpsAccount,
  type XhsOpsAccountAudit,
  type XhsOpsAccountFacts,
  type XhsOpsAuditPartStatus,
  type XhsOpsBrowseDefaults,
  type XhsOpsChangeOrder,
  type XhsOpsCount,
  type XhsOpsCountRange,
  type XhsOpsInteractionConfig,
  type XhsOpsMaturityTier,
  type XhsOpsRun,
  xhsOpsBrowseDefaultsSchema,
  xhsOpsCountRange,
  xhsOpsInteractionConfigSchema,
  xhsOpsTakeoverFieldBudgetState,
  xhsOpsTakeoverProfileFieldSchema,
} from "@nexu/shared";
import { parseHomeFeedMatch } from "./xhs-ops-task-builder.js";

// Deterministic facts of one takeover audit (design §4.2) and the static
// per-tier cadence (§6.3, D3). What a diagnosis must not take from the LLM —
// the maturity tier, the maintenance parameters, the change budget — is
// computed here. Page counts are read as ranges (xhsOpsCountRange) and the
// tier is decided on their lower bounds.

const DAY_MS = 86_400_000;

/** Tier thresholds of §6.3, on count lower bounds. */
const GROWING_MIN_FOLLOWERS = 100;
const ESTABLISHED_MIN_FOLLOWERS = 1_000;
const ESTABLISHED_MIN_LIKES_COLLECTS = 10_000;
/** A fully listed account with fewer notes than this is starter. */
const STARTER_MAX_NOTES = 5;
/** 近 7 日观看和互动≈0 (§6.3): the upper bounds of the shown ranges. */
export const XHS_TAKEOVER_DORMANT_MAX_VIEWS = 10;
export const XHS_TAKEOVER_DORMANT_MAX_INTERACTIONS = 1;
/** Home-feed chunks older than this no longer describe the feed (§4.2). */
export const XHS_TAKEOVER_FEED_MATCH_LOOKBACK_MS = 14 * DAY_MS;
/** Window of facts.recentSafetyStops. */
export const XHS_TAKEOVER_SAFETY_STOP_WINDOW_MS = 7 * DAY_MS;

const READ_STATUSES: ReadonlySet<XhsOpsAuditPartStatus> = new Set([
  "read",
  "partial",
]);
/** Run anomalies that stop a run for safety (RS SAFETY_STOP_TYPES). */
const SAFETY_STOP_ANOMALIES: ReadonlySet<string> = new Set([
  "login_required",
  "account_restricted",
  "rate_limited",
]);
/** The same stops as preparation codes; phone_required is the preparation's 未登录. */
const SAFETY_STOP_PREPARATION_CODES: ReadonlySet<string> = new Set([
  "phone_required",
  "account_restricted",
  "rate_limited",
]);
/** Audit receipt codes that end the session for safety (audit service SAFETY_STOP_CODES). */
const AUDIT_SAFETY_STOP_CODES: ReadonlySet<string> = new Set([
  "rate_limited",
  "account_restricted",
  "not_logged_in",
]);

function readPart<P extends { status: XhsOpsAuditPartStatus }>(
  part: P | null,
): P | null {
  return part && READ_STATUSES.has(part.status) ? part : null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return Math.floor(((sorted[middle - 1] ?? upper) + upper) / 2);
}

type TierDecision = { tier: XhsOpsMaturityTier; reasons: string[] };

/**
 * §6.3, most conservative matching tier first: dormant needs creator data
 * (近 7 日观看和互动≈0), then established, growing, and starter for the rest —
 * including an account whose follower count could not be read.
 */
function decideTier(input: {
  followers: XhsOpsCountRange | null;
  likesCollects: XhsOpsCountRange | null;
  notesSeen: number;
  notesEnd: boolean;
  weekly: XhsOpsAccountFacts["weekly"];
}): TierDecision {
  const views = input.weekly?.views ?? null;
  const interactions = input.weekly?.interactions ?? null;
  if (
    views?.max != null &&
    interactions?.max != null &&
    views.max <= XHS_TAKEOVER_DORMANT_MAX_VIEWS &&
    interactions.max <= XHS_TAKEOVER_DORMANT_MAX_INTERACTIONS
  )
    return {
      tier: "dormant",
      reasons: [`近 7 日观看 ${views.max}、互动 ${interactions.max}，接近 0`],
    };
  const followers = input.followers?.min ?? null;
  const likes = input.likesCollects?.min ?? null;
  const notCreator = input.weekly
    ? []
    : ["创作者数据不可用，不判沉寂档，按体量定档"];
  const established: string[] = [];
  if (followers !== null && followers >= ESTABLISHED_MIN_FOLLOWERS)
    established.push(`粉丝下界 ${followers} ≥ ${ESTABLISHED_MIN_FOLLOWERS}`);
  if (likes !== null && likes >= ESTABLISHED_MIN_LIKES_COLLECTS)
    established.push(
      `获赞与收藏下界 ${likes} ≥ ${ESTABLISHED_MIN_LIKES_COLLECTS}`,
    );
  if (established.length > 0)
    return { tier: "established", reasons: [...established, ...notCreator] };
  if (followers !== null && followers >= GROWING_MIN_FOLLOWERS)
    return {
      tier: "growing",
      reasons: [
        `粉丝下界 ${followers} 在 ${GROWING_MIN_FOLLOWERS}–${ESTABLISHED_MIN_FOLLOWERS - 1} 之间`,
        ...notCreator,
      ],
    };
  const starter = [
    followers === null
      ? "没有读到粉丝数，按起步档"
      : `粉丝下界 ${followers} < ${GROWING_MIN_FOLLOWERS}`,
  ];
  if (input.notesEnd && input.notesSeen < STARTER_MAX_NOTES)
    starter.push(`主页共 ${input.notesSeen} 篇笔记 < ${STARTER_MAX_NOTES}`);
  return { tier: "starter", reasons: [...starter, ...notCreator] };
}

/** Recent 推荐流匹配度 of the account's home-feed chunks (§4.2); unknown when none says. */
function recentFeedMatch(
  runs: readonly XhsOpsRun[],
  now: number,
): XhsOpsAccountFacts["feedMatch"] {
  let newest: { at: number; match: XhsOpsAccountFacts["feedMatch"] } | null =
    null;
  for (const run of runs) {
    for (const chunk of run.chunks) {
      if (chunk.mode !== "home") continue;
      const match = parseHomeFeedMatch(chunk.observation);
      const at = Date.parse(chunk.completedAt ?? run.updatedAt);
      if (
        !match ||
        !Number.isFinite(at) ||
        at + XHS_TAKEOVER_FEED_MATCH_LOOKBACK_MS <= now ||
        (newest && newest.at >= at)
      )
        continue;
      newest = { at, match };
    }
  }
  return newest?.match ?? "unknown";
}

/** Runs and audits of the account that stopped for safety inside the window, one each. */
function countRecentSafetyStops(
  runs: readonly XhsOpsRun[],
  audits: readonly XhsOpsAccountAudit[],
  now: number,
): number {
  const recent = (iso: string | null | undefined) => {
    const at = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(at) && at + XHS_TAKEOVER_SAFETY_STOP_WINDOW_MS > now;
  };
  let stops = 0;
  for (const run of runs) {
    const stopped =
      (run.preparation?.reasonCode != null &&
        SAFETY_STOP_PREPARATION_CODES.has(run.preparation.reasonCode)) ||
      run.chunks.some((chunk) =>
        chunk.anomalies.some((anomaly) =>
          SAFETY_STOP_ANOMALIES.has(anomaly.type),
        ),
      );
    if (stopped && recent(run.completedAt ?? run.updatedAt)) stops += 1;
  }
  for (const audit of audits) {
    const stopped = [audit.profile, audit.home, audit.creator].some(
      (part) => part !== null && AUDIT_SAFETY_STOP_CODES.has(part.code),
    );
    if (stopped && recent(audit.completedAt ?? audit.updatedAt)) stops += 1;
  }
  return stops;
}

export interface XhsOpsTakeoverFactsInput {
  audit: XhsOpsAccountAudit;
  account: Pick<XhsOpsAccount, "takeover">;
  /** The account's change orders: the budget ledger (§8.1). */
  changeOrders: readonly XhsOpsChangeOrder[];
  /** The account's runs: feed match and safety stops. */
  runs: readonly XhsOpsRun[];
  /** The account's audits: safety stops. */
  audits: readonly XhsOpsAccountAudit[];
  now: number;
}

/** facts of a diagnosis (§4.2), from one audit and the account's records. */
export function computeTakeoverFacts(
  input: XhsOpsTakeoverFactsInput,
): XhsOpsAccountFacts {
  const { audit, now } = input;
  const home = readPart(audit.home);
  const creatorPart = readPart(audit.creator);
  const creator =
    creatorPart && !audit.flags.includes("creatorUnavailable")
      ? creatorPart
      : null;
  const header = (key: "following" | "followers" | "likesCollects") =>
    xhsOpsCountRange(
      home?.header?.[key] ??
        home?.headerEnd?.[key] ??
        creatorPart?.header?.[key] ??
        null,
    );
  const notes = home?.notes ?? [];
  const liked = notes.flatMap((note) =>
    note.likes?.value != null ? [{ i: note.i, likes: note.likes.value }] : [],
  );
  const range = (count: XhsOpsCount | null) => xhsOpsCountRange(count);
  const weekly: XhsOpsAccountFacts["weekly"] = creator
    ? {
        periodLabel: creator.periodLabel.slice(0, 24),
        views: range(creator.views),
        interactions: range(creator.interactions),
        newFollowers: range(creator.newFollowers),
        profileVisitors: range(creator.profileVisitors),
      }
    : null;
  const followers = header("followers");
  const likesCollects = header("likesCollects");
  const notesEnd = home?.notesEnd ?? false;
  const tier = decideTier({
    followers,
    likesCollects,
    notesSeen: notes.length,
    notesEnd,
    weekly,
  });
  const ledger = {
    orders: input.changeOrders,
    notices: input.account.takeover?.platformLimitNotices ?? [],
  };
  return {
    following: header("following"),
    followers,
    likesCollects,
    notesSeen: notes.length,
    notesEnd,
    videoSharePercent:
      notes.length > 0
        ? Math.round(
            (notes.filter((note) => note.video).length * 100) / notes.length,
          )
        : null,
    pinnedCount: notes.filter((note) => note.pinned).length,
    medianNoteLikes: median(liked.map((note) => note.likes)),
    topNoteIndexes: [...liked]
      .sort((left, right) => right.likes - left.likes || left.i - right.i)
      .slice(0, 3)
      .map((note) => note.i),
    creatorAvailable: creator !== null,
    weekly,
    feedMatch: recentFeedMatch(input.runs, now),
    tier: tier.tier,
    tierReasons: tier.reasons.slice(0, 3).map((reason) => reason.slice(0, 80)),
    budget: xhsOpsTakeoverProfileFieldSchema.options.map((field) => ({
      field,
      blockedUntil: xhsOpsTakeoverFieldBudgetState(field, ledger, now)
        .blockedUntil,
    })),
    recentSafetyStops: countRecentSafetyStops(input.runs, input.audits, now),
  };
}

export interface XhsOpsTakeoverCadence {
  browseDefaults: XhsOpsBrowseDefaults;
  interaction: XhsOpsInteractionConfig;
  rationale: string[];
}

/**
 * The maintenance parameters of a tier (§6.3): the tier's daily target,
 * segments, search ratio and like caps over the schema defaults; collect,
 * follow and comment stay off. Every tier passes both plan-budget checks with
 * enough interest words and stays at or below the new-account defaults.
 */
export function cadenceForTier(
  tier: XhsOpsMaturityTier,
): XhsOpsTakeoverCadence {
  const cadence = XHS_TAKEOVER_TIER_CADENCE[tier];
  const label = XHS_TAKEOVER_TIER_LABEL[tier];
  const segment = Math.ceil(cadence.dailyTargetPosts / cadence.dailySegments);
  const search = Math.round((segment * cadence.searchRatioPercent) / 100);
  return {
    browseDefaults: xhsOpsBrowseDefaultsSchema.parse({
      dailyTargetPosts: cadence.dailyTargetPosts,
      dailySegments: cadence.dailySegments,
      searchRatioPercent: cadence.searchRatioPercent,
    }),
    interaction: xhsOpsInteractionConfigSchema.parse({
      like: {
        enabled: true,
        dailyCap: cadence.likeDailyCap,
        ratioPercent: cadence.likeRatioPercent,
      },
      collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
      follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
      comment: { enabled: false },
    }),
    rationale: [
      `${label}：日目标 ${cadence.dailyTargetPosts} 篇，分 ${cadence.dailySegments} 段，搜索占比 ${cadence.searchRatioPercent}%（NU-03）`,
      `每段约搜索 ${search} 篇、首页 ${segment - search} 篇，兴趣池至少需要 ${Math.ceil(search / XHS_OPS_PLAN_MAX_POSTS_PER_KEYWORD)} 个词`,
      `点赞每日最多 ${cadence.likeDailyCap} 次、比例 ${cadence.likeRatioPercent}%，多数帖子只看不互动（NU-01）`,
      "收藏、关注、评论保持关闭：关注列表公开，老粉看得到；评论只走人工审核（NU-02、NU-06）",
      tier === "dormant"
        ? "沉寂档跑满一周后可由人确认上调到 60 / 2 / 80%，之后按体量定档（NU-03）"
        : "档位静态不变，养号强度只降不升，调整档位由人确认（NU-03）",
    ],
  };
}
