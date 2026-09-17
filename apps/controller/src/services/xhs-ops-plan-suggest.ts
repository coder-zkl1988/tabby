import type {
  XhsOpsAccount,
  XhsOpsPlanSuggestion,
  XhsOpsRun,
  XhsOpsRunSegment,
} from "@nexu/shared";
import { XhsOpsError } from "../lib/xhs-ops-common.js";

/**
 * 当日计划确定性生成（运营文档 §四「当日养号任务」）：不依赖 LLM——
 * 核心兴趣按"这是该账号第几轮"轮换取 3 个，扩展/泛各取 1 个补自然感，
 * 并避开上一轮完全相同的关键词集合；每词篇数取账号 browseDefaults；
 * 首页篇数由 searchRatioPercent 反推（搜索占比 80% → 首页≈搜索总量的 1/4）。
 * agent 只需渲染 RunPlanner，桌面自己拉建议；用户仍可在卡片上改。
 */

const CORE_PICK = 3;
const RETRYABLE_STATUSES: ReadonlySet<string> = new Set([
  "cancelled",
  "failed",
  "interrupted",
]);
const EXTENDED_PICK = 1;
const GENERAL_PICK = 1;
const MAX_KEYWORDS = 8;
const MAX_HOME = 12;

function uniq(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const k = raw.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function rotate<T>(list: readonly T[], offset: number, take: number): T[] {
  if (list.length === 0 || take <= 0) return [];
  const n = Math.min(take, list.length);
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const item = list[(offset + i) % list.length];
    if (item !== undefined) out.push(item);
  }
  return out;
}

/** 搜索占比 r：首页篇数 = 搜索总篇数 × (1-r)/r，钳 0..12；r=100% → 0；r=0 → 回退账号默认。 */
export function homeFeedFromRatio(
  searchTotal: number,
  searchRatioPercent: number,
  fallback: number,
): number {
  const r = Math.max(0, Math.min(100, searchRatioPercent)) / 100;
  if (r >= 1) return 0;
  if (r <= 0) return Math.max(0, Math.min(MAX_HOME, fallback));
  return Math.max(
    0,
    Math.min(MAX_HOME, Math.round((searchTotal * (1 - r)) / r)),
  );
}

/** @param previousRuns 该账号历史 run，最新在前（store.listRuns 的顺序）。 */
export function suggestPlan(
  account: XhsOpsAccount,
  previousRuns: readonly XhsOpsRun[],
): XhsOpsPlanSuggestion {
  const last = previousRuns[0];
  return suggestPlanAt(
    account,
    previousRuns.length,
    new Set((last?.plan.keywords ?? []).map((k) => k.keyword.trim())),
    null,
  );
}

/**
 * P2-3 当日多段：账号 `dailySegments` > 1 时，把当天拆成 N 个串行 run，每段
 * 轮次递进（第 k 段视作"下一轮"，避开上一段的关键词集合），每段总量 ≈
 * `dailyTargetPosts ÷ N`（目标为 0 时沿用每词篇数）。当天已有的段不再建议，
 * 所以下午打开计划卡只剩下未跑的段。单段账号退化为 `suggestPlan`。
 */
export function suggestDailyPlans(
  account: XhsOpsAccount,
  previousRuns: readonly XhsOpsRun[],
  today: string,
): XhsOpsPlanSuggestion[] {
  const segments = Math.max(
    1,
    Math.min(3, account.browseDefaults.dailySegments ?? 1),
  );
  if (segments <= 1) return [suggestPlan(account, previousRuns)];
  // 当天已计划/在跑/完成的段不再建议；失败、中断、取消的段保持开放，
  // 让「立即执行」能重跑（定时器本身因 lastTriggeredDate 一天只点火一次）。
  const doneToday = new Set(
    previousRuns
      .filter(
        (r) =>
          r.date === today && r.segment && !RETRYABLE_STATUSES.has(r.status),
      )
      .map((r) => r.segment?.index ?? 0),
  );
  const out: XhsOpsPlanSuggestion[] = [];
  let round = previousRuns.length;
  let lastSet = new Set(
    (previousRuns[0]?.plan.keywords ?? []).map((k) => k.keyword.trim()),
  );
  for (let index = 1; index <= segments; index++) {
    const segment: XhsOpsRunSegment = { index, count: segments };
    if (doneToday.has(index)) continue;
    const plan = suggestPlanAt(account, round, lastSet, segment);
    out.push(plan);
    round += 1;
    lastSet = new Set(plan.keywords.map((k) => k.keyword));
  }
  return out;
}

function suggestPlanAt(
  account: XhsOpsAccount,
  round: number,
  lastSet: ReadonlySet<string>,
  segment: XhsOpsRunSegment | null,
): XhsOpsPlanSuggestion {
  const core = uniq(account.interestPool.core);
  const extended = uniq(account.interestPool.extended);
  const general = uniq(account.interestPool.general);
  const rationale: string[] = [];

  let offset = core.length > 0 ? round % core.length : 0;
  let picks = rotate(core, offset, CORE_PICK);
  if (
    core.length > CORE_PICK &&
    lastSet.size > 0 &&
    picks.length === lastSet.size &&
    picks.every((k) => lastSet.has(k))
  ) {
    offset = (offset + 1) % core.length;
    picks = rotate(core, offset, CORE_PICK);
    rationale.push("与上一轮关键词完全相同，核心词前移一位");
  }
  const ext = rotate(extended, round, EXTENDED_PICK);
  const gen = rotate(general, round, GENERAL_PICK);
  const preferredWords = uniq([...picks, ...ext, ...gen]);
  const availableWords = uniq([
    ...preferredWords,
    ...rotate(core, offset, core.length),
    ...rotate(extended, round, extended.length),
    ...rotate(general, round, general.length),
  ]).slice(0, MAX_KEYWORDS);
  const target = account.browseDefaults.dailyTargetPosts ?? 0;
  const segmentCount = segment?.count ?? 1;
  const perKeyword = account.browseDefaults.postsPerKeyword;
  let plannedWords = preferredWords;
  let plannedCounts: number[] | null = null;
  let homeFeedCount = 0;
  let targetLine: string | null = null;
  if (target > 0) {
    const baseSegmentTarget = Math.floor(target / segmentCount);
    const segmentRemainder = target % segmentCount;
    const segmentTarget =
      segment === null
        ? target
        : baseSegmentTarget + (segment.index <= segmentRemainder ? 1 : 0);
    const r =
      Math.max(0, Math.min(100, account.browseDefaults.searchRatioPercent)) /
      100;
    const requestedSearchBudget = Math.round(segmentTarget * r);
    const requestedHomeBudget = segmentTarget - requestedSearchBudget;
    const requiredWordCount = Math.ceil(requestedSearchBudget / 8);
    if (requiredWordCount > availableWords.length) {
      throw new XhsOpsError(
        409,
        `本段搜索目标 ${requestedSearchBudget} 篇至少需要 ${requiredWordCount} 个兴趣词，当前只有 ${availableWords.length} 个，请补充兴趣池或增加每日分段`,
      );
    }
    if (requestedHomeBudget > MAX_HOME) {
      throw new XhsOpsError(
        409,
        `本段首页目标 ${requestedHomeBudget} 篇超过上限 ${MAX_HOME}，请提高搜索占比或增加每日分段`,
      );
    }
    const searchBudget = requestedSearchBudget;
    const homeBudget = requestedHomeBudget;
    const activeWordCount = Math.min(
      availableWords.length,
      searchBudget,
      Math.max(preferredWords.length, requiredWordCount),
    );
    plannedWords = availableWords.slice(0, activeWordCount);
    const baseKeywordCount =
      activeWordCount > 0 ? Math.floor(searchBudget / activeWordCount) : 0;
    const keywordRemainder =
      activeWordCount > 0 ? searchBudget % activeWordCount : 0;
    plannedCounts = plannedWords.map(
      (_, index) => baseKeywordCount + (index < keywordRemainder ? 1 : 0),
    );
    homeFeedCount = homeBudget;
    const searchTotalPlanned = plannedCounts.reduce(
      (sum, count) => sum + count,
      0,
    );
    const total = searchTotalPlanned + homeFeedCount;
    targetLine = `日目标 ${target} 篇${segmentCount > 1 ? ` ÷ ${segmentCount} 段` : ""} → 本${segmentCount > 1 ? "段" : "次"}目标 ${segmentTarget} 篇：搜索 ${searchTotalPlanned} + 首页 ${homeFeedCount}${total < segmentTarget ? `（受每词 ≤8、首页 ≤${MAX_HOME} 限制，实际 ${total} 篇）` : ""}`;
  }
  const keywords = plannedWords.map((keyword, index) => ({
    keyword,
    count: plannedCounts?.[index] ?? perKeyword,
  }));
  const searchTotal = keywords.reduce((n, k) => n + k.count, 0);
  if (targetLine === null) {
    homeFeedCount = homeFeedFromRatio(
      searchTotal,
      account.browseDefaults.searchRatioPercent,
      account.browseDefaults.homeFeedCount,
    );
  }

  rationale.unshift(
    core.length > 0
      ? `第 ${round + 1} 轮：核心兴趣从第 ${offset + 1} 个起轮换取 ${picks.length} 个（${picks.join("、")}）`
      : "核心兴趣池为空，未能生成核心关键词",
  );
  if (ext.length > 0) rationale.push(`扩展兴趣补 ${ext.join("、")}`);
  if (gen.length > 0) rationale.push(`泛内容补 ${gen.join("、")}`);
  if (targetLine) rationale.push(targetLine);
  else {
    rationale.push(
      `搜索占比 ${account.browseDefaults.searchRatioPercent}%：搜索 ${searchTotal} 篇 → 首页 ${homeFeedCount} 篇`,
    );
  }
  if (segment && segment.count > 1) {
    rationale.unshift(
      `第 ${segment.index}/${segment.count} 段（当日多段串行执行）`,
    );
  }

  return {
    accountId: account.id,
    accountLabel: account.label,
    keywords,
    homeFeedCount,
    dwellSecMin: account.browseDefaults.dwellSecMin,
    dwellSecMax: account.browseDefaults.dwellSecMax,
    interaction: account.interaction,
    rationale,
    segment,
  };
}
