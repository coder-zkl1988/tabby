import {
  type DeviceExecuteTaskBody,
  type DeviceInfo,
  type DeviceTaskPolicy,
  type TaskResult,
  type XhsOpsAccount,
  type XhsOpsAnomaly,
  type XhsOpsAnomalyType,
  type XhsOpsInteractionConfig,
  type XhsOpsInteractionCounts,
  type XhsOpsInteractionRule,
  type XhsOpsPlanSuggestion,
  type XhsOpsPreparation,
  type XhsOpsPreparationCode,
  type XhsOpsProject,
  type XhsOpsRun,
  type XhsOpsRunChunk,
  type XhsOpsRunCreate,
  type XhsOpsRunPlan,
  type XhsOpsRunSummary,
  type XhsOpsStoreData,
  xhsOpsAccountNurtureIssues,
} from "@nexu/shared";
import { logger } from "../lib/logger.js";
import { XhsOpsError, localDateString } from "../lib/xhs-ops-common.js";
export { XhsOpsError, localDateString } from "../lib/xhs-ops-common.js";
import type { XhsOpsRunSeed, XhsOpsStore } from "../store/xhs-ops-store.js";
import {
  DeviceControlRpcError,
  type DeviceControlService,
} from "./device-control-service.js";
import {
  computeCommentQuota,
  validateCommentText,
} from "./xhs-ops-comment-service.js";
import { suggestDailyPlans } from "./xhs-ops-plan-suggest.js";
import {
  buildPreparationRequest,
  buildPreparationVerificationRequest,
  interpretPreparationResult,
  interruptPreparation,
  isPreparationSafetyStop,
  preparationReason,
} from "./xhs-ops-preparation.js";
import {
  type XhsOpsChunkQuota,
  buildCommentChunkTask,
  buildHomeChunkTask,
  buildSearchChunkTask,
  extractBrowsedFromMessage,
  formatPersona,
  parseCommentJson,
  parseReceiptClicks,
  parseRecordJson,
} from "./xhs-ops-task-builder.js";

// Executes one xhs-ops run: its chunks go to the phone strictly one at a time
// through DeviceControlService (spec §4). Never talks to tabby-control itself.

export const XHS_PACKAGE = "com.xingin.xhs";
export const XHS_CHUNK_TIMEOUT_MS = 300_000;

export const XHS_TASK_POLICY: DeviceTaskPolicy = {
  operationClass: "app.use.xhs",
  targetPackages: [XHS_PACKAGE],
  allowedAppRoles: ["target_app", "system_dialog", "system_settings"],
  allowedActions: [
    "AWAKE",
    "CLICK",
    "TYPE",
    "ENTER",
    "WAIT",
    "BACK",
    "HOME",
    "SLIDE",
    "SCROLL",
    // FLING belongs here on paper — it is the one gesture that keeps its
    // inertia, and the 200+ entry region list cannot be crossed without it.
    // It is out because the phones cannot honour it yet: TabbyApp 1.0.22 has
    // no FLING at all, and the commit that added the gesture left it out of
    // TaskPolicy.supportedActions, so the phone reports a vocabulary without
    // it and tabby-control rejects the whole dispatch with
    // UNKNOWN_PHONE_ACTION — which killed every xhs task, not just the ones
    // touching 地区 (observed 2026-09-20). Put it back once a build carrying
    // FLING in supportedActions is installed on the fleet, together with the
    // region step in buildProfileApplyTask.
    // The birthday sheet is a custom-drawn wheel with nothing clickable, so
    // the only way in is a press-and-drag. Leaving these out does not prevent
    // the gesture — it just kills the run with POLICY_ACTION_NOT_ALLOWED at
    // the exact step the wheel appears (observed 2026-09-20).
    "LONGPRESS",
    "LONGPRESSANDDRAG",
    "LOAD_SKILL",
    "COMPLETE",
    "ABORT",
    "INFO",
  ],
  allowedApps: [XHS_PACKAGE],
  confirmationPolicy: { publish: "forbidden", payment: "forbidden" },
};

/** Anomalies that end the whole run: the account must not keep browsing. */
const SAFETY_STOP_TYPES: ReadonlySet<XhsOpsAnomalyType> = new Set([
  "login_required",
  "account_restricted",
  "rate_limited",
]);
const MAX_CONSECUTIVE_FAILURES = 2;
const MAX_MESSAGE_CHARS = 4000;
const MAX_ERROR_CHARS = 200;
const DEVICE_UNAVAILABLE = "设备不可用";
const CANCELLATION_UNCONFIRMED =
  "手机任务停止未确认；请先在手机上确认任务已结束，同设备后续任务已隔离";
const MIN_NURTURE_DWELL_SECONDS = 11;

export const XHS_OPS_DEFAULT_IDLE_POLL_MS = 3_000;
export const XHS_OPS_DEFAULT_IDLE_WAIT_MS = 180_000;
export const XHS_OPS_DEFAULT_OFFLINE_AFTER_MS = 90_000;

export type XhsOpsDeviceControl = Pick<
  DeviceControlService,
  "getDevice" | "executeTask" | "cancelTask"
>;

export interface XhsOpsRunServiceOptions {
  idlePollIntervalMs?: number;
  idleWaitTimeoutMs?: number;
  offlineAfterMs?: number;
  now?: () => number;
}

export interface XhsOpsRunServiceDeps {
  store: XhsOpsStore;
  deviceControl: XhsOpsDeviceControl;
  options?: XhsOpsRunServiceOptions;
}

interface RunController {
  cancelled: boolean;
  deviceId: string;
  done: Promise<void>;
}

/** Fields a finished phone task writes back onto its chunk. */
type ChunkOutcome = Pick<
  XhsOpsRunChunk,
  | "status"
  | "browsed"
  | "skipped"
  | "refreshCount"
  | "interactions"
  | "anomalies"
  | "posts"
  | "observation"
  | "taskId"
  | "totalSteps"
  | "finalScreenshot"
  | "message"
  | "error"
> & { stopRun?: boolean };

const ZERO_COUNTS: XhsOpsInteractionCounts = { like: 0, collect: 0, follow: 0 };

export interface XhsOpsTaskResultExpectation {
  mode: "search" | "home";
  keyword: string | null;
  plannedCount: number;
  dwellSecMin: number;
  elapsedMs: number;
  quota: XhsOpsChunkQuota;
}

/** 评论任务（P3-1 D2）：一条评论一个 chunk，步数预算与时间窗。 */
export const XHS_COMMENT_CHUNK_MAX_STEPS = 40;
export const XHS_COMMENT_WINDOW_START_HOUR = 8;
export const XHS_COMMENT_WINDOW_END_HOUR = 23;
export const XHS_COMMENT_MIN_GAP_AFTER_BROWSE_MS = 10 * 60_000;

/** 评论任务的手机策略：仍禁发布/付款，评论放开但只放行这一条审核原文。 */
export function commentTaskPolicy(text: string): DeviceTaskPolicy {
  return {
    ...XHS_TASK_POLICY,
    confirmationPolicy: {
      ...XHS_TASK_POLICY.confirmationPolicy,
      comment: "allowed",
    },
    commentAllowlist: [text],
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nurturePlanIssues(
  account: XhsOpsAccount,
  project: XhsOpsProject | null,
  plan: XhsOpsRunPlan,
): string[] {
  const issues = xhsOpsAccountNurtureIssues(account, project);
  if (plan.dwellSecMin < MIN_NURTURE_DWELL_SECONDS) {
    issues.push(`单篇最短停留必须至少 ${MIN_NURTURE_DWELL_SECONDS} 秒`);
  }
  if (plan.dwellSecMax < plan.dwellSecMin) {
    issues.push("单篇最长停留不能短于最短停留");
  }
  if (
    plan.interaction.follow.enabled &&
    !plan.interaction.follow.targetTypes?.some((value) => value.trim())
  ) {
    issues.push("开启关注时必须填写允许关注的目标类型");
  }
  if (
    account.interaction.follow.enabled &&
    !account.interaction.follow.targetTypes?.some((value) => value.trim())
  ) {
    issues.push("账号关注配置缺少允许关注的目标类型");
  }
  return issues;
}

function assertNurtureReady(
  account: XhsOpsAccount,
  project: XhsOpsProject | null,
  plan: XhsOpsRunPlan,
): void {
  const issues = nurturePlanIssues(account, project, plan);
  if (issues.length > 0) {
    throw new XhsOpsError(409, `养号准备未完成：${issues.join("；")}`);
  }
}

export function buildRunChunks(plan: XhsOpsRunPlan): XhsOpsRunChunk[] {
  const blank = {
    status: "pending" as const,
    taskId: null,
    startedAt: null,
    completedAt: null,
    browsed: 0,
    skipped: 0,
    refreshCount: 0,
    interactions: { ...ZERO_COUNTS },
    anomalies: [],
    observation: null,
    posts: [],
    message: null,
    totalSteps: null,
    finalScreenshot: null,
    error: null,
    commentDraftId: null,
  };
  if (plan.kind === "comment") {
    // 一条评论一个 chunk：任务文本、手机白名单、回填都以草稿为单位。
    return (plan.comments ?? []).map((comment, index) => ({
      ...blank,
      index,
      mode: "comment" as const,
      keyword: null,
      plannedCount: 1,
      commentDraftId: comment.draftId,
    }));
  }
  const chunks: XhsOpsRunChunk[] = plan.keywords.map((entry, index) => ({
    ...blank,
    index,
    mode: "search",
    keyword: entry.keyword,
    plannedCount: entry.count,
  }));
  if (plan.homeFeedCount > 0) {
    chunks.push({
      ...blank,
      index: chunks.length,
      mode: "home",
      keyword: null,
      plannedCount: plan.homeFeedCount,
    });
  }
  return chunks;
}

export function summarizeRun(
  chunks: XhsOpsRunChunk[],
  startedAt: string | null,
  completedAt: string | null,
): XhsOpsRunSummary {
  const summary: XhsOpsRunSummary = {
    plannedTotal: 0,
    browsedTotal: 0,
    searchBrowsed: 0,
    homeBrowsed: 0,
    interactions: { ...ZERO_COUNTS },
    anomalyCount: 0,
    durationMs: null,
  };
  let comments = 0;
  for (const chunk of chunks) {
    if (chunk.mode === "comment") {
      // 评论 chunk 不算浏览篇数；计划/实际用"篇"口径会误导看板。
      comments += chunk.interactions.comment ?? 0;
      summary.anomalyCount += chunk.anomalies.length;
      continue;
    }
    summary.plannedTotal += chunk.plannedCount;
    summary.browsedTotal += chunk.browsed;
    if (chunk.mode === "search") summary.searchBrowsed += chunk.browsed;
    else summary.homeBrowsed += chunk.browsed;
    summary.interactions.like += chunk.interactions.like;
    summary.interactions.collect += chunk.interactions.collect;
    summary.interactions.follow += chunk.interactions.follow;
    summary.anomalyCount += chunk.anomalies.length;
  }
  if (comments > 0) summary.interactions.comment = comments;
  if (startedAt && completedAt) {
    const duration = Date.parse(completedAt) - Date.parse(startedAt);
    summary.durationMs = Number.isFinite(duration)
      ? Math.max(0, duration)
      : null;
  }
  return summary;
}

/**
 * Allowance unlocked by cumulative planned browsing for the day. Using floor
 * once over the cumulative total prevents small chunks from each rounding a
 * fractional interaction up to one.
 */
export function computeChunkQuota(
  config: XhsOpsInteractionConfig,
  used: XhsOpsInteractionCounts,
  _totalChunks: number,
  /** 当日截至本 chunk 的累计计划篇数；省略时只应用每日上限。 */
  cumulativePlannedCount?: number,
): XhsOpsChunkQuota {
  const entry = (rule: XhsOpsInteractionRule, usedCount: number) => {
    if (!rule.enabled || rule.dailyCap <= 0) {
      return { enabled: false, max: 0, targetTypes: rule.targetTypes };
    }
    const remaining = Math.max(0, rule.dailyCap - usedCount);
    let max = remaining;
    if (cumulativePlannedCount !== undefined) {
      // 运营文档「触发比例」：比例为 0 视为本 chunk 不互动。
      const ratioCap =
        rule.ratioPercent > 0
          ? Math.floor((cumulativePlannedCount * rule.ratioPercent) / 100)
          : 0;
      max = Math.min(max, Math.max(0, ratioCap - usedCount));
    }
    return { enabled: max > 0, max, targetTypes: rule.targetTypes };
  };
  return {
    like: entry(config.like, used.like),
    collect: entry(config.collect, used.collect),
    follow: entry(config.follow, used.follow),
  };
}

/**
 * Step budget per chunk. The phone's `maxSteps` schema caps at 100.
 *
 * Home-feed chunks need more headroom than search chunks: the model skips
 * ads/live/low-comment cards before finding a countable post, and every skip
 * costs 5–8 steps. Measured on the 2026-09-06 HONOR run (4 posts planned):
 * search chunks used 25 and 42 steps, home chunks 22, 33, 50 and one hit the
 * old 60 cap at 2/4 browsed. Search keeps 20 + 10/post; home gets 30 + 12/post.
 */
export function chunkMaxSteps(
  plannedCount: number,
  mode: "search" | "home" | "comment" = "search",
): number {
  if (mode === "comment") return XHS_COMMENT_CHUNK_MAX_STEPS;
  const budget =
    mode === "home" ? 30 + plannedCount * 12 : 20 + plannedCount * 10;
  return Math.min(100, budget);
}

/**
 * 评论任务结果 → chunk 字段。sent 且回执里小红书有生效点击 → completed +
 * interactions.comment=1；sent 但回执 0 次生效点击 → 不信，降为 failed 并记
 * 异常；failed → failed；skipped（帖子搜不到等）→ skipped。detail 进 observation。
 */
export function interpretCommentTaskResult(result: TaskResult): ChunkOutcome {
  const message = result.message ?? "";
  const json = parseCommentJson(message);
  const anomalies: XhsOpsAnomaly[] = [];
  const outcome: ChunkOutcome = {
    status: "failed",
    browsed: 0,
    skipped: 0,
    refreshCount: 0,
    interactions: { ...ZERO_COUNTS },
    anomalies,
    posts: [],
    observation: null,
    taskId: result.taskId,
    totalSteps: result.totalSteps ?? null,
    finalScreenshot: result.finalScreenshot ?? null,
    message: message ? message.slice(0, MAX_MESSAGE_CHARS) : null,
    error: null,
  };
  if (!json) {
    anomalies.push({ type: "other", detail: "手机未返回 COMMENT_JSON" });
    outcome.error = result.success
      ? "手机未返回结构化评论结果"
      : (message || "任务失败").slice(0, MAX_ERROR_CHARS);
    return outcome;
  }
  for (const a of json.anomalies) {
    anomalies.push({
      type: (
        [
          "no_results",
          "load_failed",
          "login_required",
          "account_restricted",
          "rate_limited",
          "content_mismatch",
          "interrupted",
          "other",
        ] as const
      ).includes(a.type as XhsOpsAnomalyType)
        ? (a.type as XhsOpsAnomalyType)
        : "other",
      detail: a.detail || a.type,
    });
  }
  outcome.observation = json.detail || null;
  if (json.status === "sent") {
    const clicks = parseReceiptClicks(message, XHS_PACKAGE);
    if (
      !result.success ||
      clicks === null ||
      clicks <= 0 ||
      anomalies.some((a) => SAFETY_STOP_TYPES.has(a.type))
    ) {
      anomalies.push({
        type: "other",
        detail: "缺少成功任务和小红书有效点击回执，发送结果待核验",
      });
      outcome.error = "汇报与回执不一致";
      return outcome;
    }
    outcome.status = "completed";
    outcome.interactions = { ...ZERO_COUNTS, comment: 1 };
    return outcome;
  }
  if (json.status === "skipped") {
    outcome.status = "skipped";
    outcome.error = json.detail || "未尝试评论";
    return outcome;
  }
  outcome.error = (json.detail || "评论未成功").slice(0, MAX_ERROR_CHARS);
  return outcome;
}

/** Turn a phone result into chunk fields (spec §4.3 + §6 fallback). */
export function interpretTaskResult(
  result: TaskResult,
  expected: XhsOpsTaskResultExpectation,
): ChunkOutcome {
  const message = result.message ?? "";
  const record = parseRecordJson(message);
  const anomalies: XhsOpsAnomaly[] = [];
  const outcome: ChunkOutcome = {
    status: "completed",
    browsed: 0,
    skipped: 0,
    refreshCount: 0,
    interactions: { ...ZERO_COUNTS },
    anomalies,
    posts: [],
    observation: null,
    taskId: result.taskId,
    totalSteps: result.totalSteps ?? null,
    finalScreenshot: result.finalScreenshot ?? null,
    message: message ? message.slice(0, MAX_MESSAGE_CHARS) : null,
    error: null,
  };
  if (record) {
    outcome.browsed = record.browsed;
    outcome.skipped = record.skipped;
    outcome.refreshCount = record.refreshCount;
    outcome.interactions = { ...record.interactions };
    anomalies.push(...record.anomalies);
    outcome.posts = record.posts;
    outcome.observation = record.observation;
  } else {
    const fallback = extractBrowsedFromMessage(message);
    if (fallback) outcome.browsed = fallback.browsed;
    anomalies.push({ type: "other", detail: "手机未返回结构化记录" });
    outcome.status = "failed";
    outcome.stopRun = true;
    outcome.error = "手机未返回可核验的结构化记录";
  }
  if (record) {
    const evidenceIssues: string[] = [];
    if (record.mode !== expected.mode) evidenceIssues.push("浏览模式不一致");
    if ((record.keyword ?? null) !== expected.keyword)
      evidenceIssues.push("关键词不一致");
    if (record.planned !== expected.plannedCount)
      evidenceIssues.push("计划篇数不一致");
    if (record.browsed > expected.plannedCount)
      evidenceIssues.push("实际浏览数超过计划");
    if (record.posts.length !== record.browsed)
      evidenceIssues.push("帖子明细数与实际浏览数不一致");
    if (record.posts.some((post) => !post.title.trim() && !post.author.trim()))
      evidenceIssues.push("帖子缺少标题和作者证据");
    if (record.posts.some((post) => post.dwellSeconds < expected.dwellSecMin))
      evidenceIssues.push("存在停留时长不足的帖子");
    if (record.posts.some((post) => !post.commentsComplete))
      evidenceIssues.push("存在未确认读完评论区的帖子");
    const reportedDwellSeconds = record.posts.reduce(
      (total, post) => total + post.dwellSeconds,
      0,
    );
    const elapsedSeconds = Math.max(0, Math.floor(expected.elapsedMs / 1000));
    if (reportedDwellSeconds > elapsedSeconds + 2)
      evidenceIssues.push("逐篇停留总时长超过任务实际耗时");
    if (expected.mode === "search" && record.refreshCount !== 0)
      evidenceIssues.push("搜索任务不应记录首页刷新");
    const minimumRefreshes = Math.floor(record.browsed / 5);
    if (expected.mode === "home" && record.refreshCount < minimumRefreshes) {
      evidenceIssues.push("首页刷新次数不足");
    }
    for (const key of ["like", "collect", "follow"] as const) {
      if (record.interactions[key] > expected.quota[key].max) {
        evidenceIssues.push(`${key} 互动数超过本块上限`);
      }
    }
    if (evidenceIssues.length > 0) {
      const detail = `结构化记录校验失败：${evidenceIssues.join("；")}`;
      anomalies.push({ type: "other", detail });
      outcome.status = "failed";
      outcome.stopRun = true;
      outcome.error = detail.slice(0, MAX_ERROR_CHARS);
    }
  }
  if (!result.success) {
    outcome.status = "failed";
    const head = message.slice(0, MAX_ERROR_CHARS);
    anomalies.push({ type: "interrupted", detail: head });
    outcome.error = head || "手机任务未成功完成";
  }
  return outcome;
}

export class XhsOpsRunService {
  private readonly active = new Map<string, RunController>();
  private readonly deviceTransitions = new Map<string, Promise<unknown>>();
  /** P2-4 设备队列：deviceId → 等待启动的 runId（FIFO）。进程内状态，重启即清。 */
  private readonly deviceQueues = new Map<string, string[]>();
  private readonly store: XhsOpsStore;
  private readonly deviceControl: XhsOpsDeviceControl;
  private readonly idlePollIntervalMs: number;
  private readonly idleWaitTimeoutMs: number;
  private readonly offlineAfterMs: number;
  private readonly now: () => number;

  constructor(deps: XhsOpsRunServiceDeps) {
    this.store = deps.store;
    this.deviceControl = deps.deviceControl;
    this.idlePollIntervalMs =
      deps.options?.idlePollIntervalMs ?? XHS_OPS_DEFAULT_IDLE_POLL_MS;
    this.idleWaitTimeoutMs =
      deps.options?.idleWaitTimeoutMs ?? XHS_OPS_DEFAULT_IDLE_WAIT_MS;
    this.offlineAfterMs =
      deps.options?.offlineAfterMs ?? XHS_OPS_DEFAULT_OFFLINE_AFTER_MS;
    this.now = deps.options?.now ?? (() => Date.now());
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private withDeviceTransition<T>(
    deviceId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.deviceTransitions.get(deviceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.deviceTransitions.set(deviceId, next);
    void next
      .finally(() => {
        if (this.deviceTransitions.get(deviceId) === next)
          this.deviceTransitions.delete(deviceId);
      })
      .catch(() => undefined);
    return next;
  }

  // ─── Lifecycle API ─────────────────────────────────────────────────────────

  /** Plan a run (status `planned`). 404 unknown project/account, 400 no device. */
  /** 为项目下每个已绑设备的账号生成当日计划建议（确定性，见 xhs-ops-plan-suggest.ts）。 */
  async suggestPlans(projectId: string): Promise<XhsOpsPlanSuggestion[]> {
    const project = await this.store.getProject(projectId);
    if (!project) throw new XhsOpsError(404, "项目不存在");
    const accounts = await this.store.listAccountsByProject(projectId);
    const plans: XhsOpsPlanSuggestion[] = [];
    for (const account of accounts) {
      if (!account.deviceId) continue;
      const runs = await this.store.listRuns({ accountId: account.id });
      plans.push(
        ...suggestDailyPlans(
          account,
          runs,
          localDateString(new Date(this.now())),
        ),
      );
    }
    return plans;
  }

  async createRun(
    input: XhsOpsRunCreate,
    options?: { onCreated?: () => void },
  ): Promise<XhsOpsRun> {
    if (
      input.plan.kind === "comment" ||
      (input.plan.comments?.length ?? 0) > 0
    ) {
      throw new XhsOpsError(400, "评论任务必须从已审核评论入口创建");
    }
    return this.createRunInternal(input, false, options);
  }

  private async createRunInternal(
    input: XhsOpsRunCreate,
    claimComments = false,
    options?: { onCreated?: () => void },
  ): Promise<XhsOpsRun> {
    const project = await this.store.getProject(input.projectId);
    if (!project) throw new XhsOpsError(404, "项目不存在");
    const account = await this.store.getAccount(input.accountId);
    if (!account || account.projectId !== project.id) {
      throw new XhsOpsError(404, "账号不存在或不属于该项目");
    }
    if (!account.deviceId) {
      throw new XhsOpsError(400, "账号未绑定设备，无法创建运行计划");
    }
    if ((input.plan.kind ?? "browse") === "browse")
      assertNurtureReady(account, project, input.plan);
    await this.store.assertDeviceBinding(account.id, account.deviceId);
    if (input.segment && input.segment.index > input.segment.count) {
      throw new XhsOpsError(400, "计划分段序号不能超过总段数");
    }
    if (input.plan.kind === "comment") {
      if ((input.plan.comments ?? []).length === 0) {
        throw new XhsOpsError(400, "评论任务至少要有一条已批准的评论");
      }
    } else if (
      input.plan.keywords.length === 0 &&
      input.plan.homeFeedCount <= 0
    ) {
      throw new XhsOpsError(400, "浏览计划至少包含关键词或首页浏览");
    }
    const chunks = buildRunChunks(input.plan);
    const seed: XhsOpsRunSeed = {
      projectId: project.id,
      accountId: account.id,
      deviceId: account.deviceId,
      accountLabel: account.label,
      date: input.date ?? localDateString(new Date(this.now())),
      status: "planned",
      plan: input.plan,
      segment: input.segment ?? null,
      queuedBehindRunId: null,
      chunks,
      summary: summarizeRun(chunks, null, null),
      notes: "",
      error: null,
      startedAt: null,
      completedAt: null,
    };
    return this.store.createRun(seed, {
      claimComments,
      reuseActive: input.reuseActive === true,
      onCreated: options?.onCreated,
      validate: (current) => {
        const bound = current.accounts.find((a) => a.id === account.id);
        if (
          !bound ||
          bound.deviceId !== seed.deviceId ||
          current.accounts.some(
            (a) => a.id !== bound.id && a.deviceId === seed.deviceId,
          )
        ) {
          throw new XhsOpsError(409, "账号设备绑定已变化或存在重复绑定");
        }
        if ((seed.plan.kind ?? "browse") === "browse") {
          const currentProject = current.projects.find(
            (candidate) => candidate.id === seed.projectId,
          );
          assertNurtureReady(bound, currentProject ?? null, seed.plan);
        }
        if (claimComments) this.validateCommentPlan(seed, current);
      },
    });
  }

  private validateCommentPlan(
    run: XhsOpsRunSeed,
    current: XhsOpsStoreData,
    chunkDraftId?: string,
    runId?: string,
  ): void {
    const now = new Date(this.now());
    const today = localDateString(now);
    const account = current.accounts.find((a) => a.id === run.accountId);
    if (!account || account.deviceId !== run.deviceId)
      throw new XhsOpsError(409, "评论账号绑定已变化");
    if (
      run.date !== today ||
      now.getHours() < XHS_COMMENT_WINDOW_START_HOUR ||
      now.getHours() >= XHS_COMMENT_WINDOW_END_HOUR
    ) {
      throw new XhsOpsError(409, "评论计划仅可在当日 08:00 至 23:00 执行");
    }
    const runs = current.runs.filter((r) => r.accountId === account.id);
    const lastBrowseEnd = runs
      .filter((r) => r.plan.kind !== "comment" && r.completedAt)
      .reduce(
        (latest, r) => Math.max(latest, Date.parse(r.completedAt ?? "") || 0),
        0,
      );
    if (
      lastBrowseEnd > 0 &&
      this.now() - lastBrowseEnd < XHS_COMMENT_MIN_GAP_AFTER_BROWSE_MS
    ) {
      throw new XhsOpsError(409, "浏览刚结束，请间隔 10 分钟后再发评论");
    }
    const quota = computeCommentQuota({
      account,
      date: today,
      runs,
      drafts: current.comments,
    });
    // Failed/ambiguous attempts consume budget too, so retries cannot exceed the cap.
    const attempted = runs
      .filter((r) => r.date === today && r.plan.kind === "comment")
      .flatMap((r) => r.chunks)
      .filter((c) => c.startedAt && c.commentDraftId !== chunkDraftId).length;
    const entries = (run.plan.comments ?? []).filter(
      (entry) => !chunkDraftId || entry.draftId === chunkDraftId,
    );
    const otherReserved = current.comments.filter(
      (d) =>
        d.accountId === account.id &&
        d.status === "approved" &&
        d.sentRunId &&
        d.sentRunId !== runId,
    ).length;
    if (
      !quota.enabled ||
      Math.max(quota.sentToday, attempted) + otherReserved + entries.length >
        quota.cap
    ) {
      throw new XhsOpsError(409, "评论开关已关闭或当日评论配额不足");
    }
    const forbidden =
      current.projects.find((p) => p.id === run.projectId)?.opsNotes
        .forbiddenTopics ?? [];
    for (const entry of entries) {
      const draft = current.comments.find((d) => d.id === entry.draftId);
      if (
        !draft ||
        draft.status !== "approved" ||
        draft.sentRunId !== (runId ?? null) ||
        draft.accountId !== run.accountId ||
        draft.projectId !== run.projectId ||
        draft.deviceId !== run.deviceId ||
        !draft.reviewedAt ||
        localDateString(new Date(draft.reviewedAt)) !== today ||
        draft.text !== entry.text ||
        draft.post.title !== entry.postTitle ||
        draft.post.author !== entry.postAuthor ||
        validateCommentText(entry.text, forbidden)
      ) {
        throw new XhsOpsError(
          409,
          "评论审核已失效或草稿内容已变化，请重新审核",
        );
      }
    }
  }

  private async validateCommentRun(
    run: XhsOpsRun,
    chunkDraftId?: string,
  ): Promise<void> {
    const account = await this.store.assertDeviceBinding(
      run.accountId,
      run.deviceId,
    );
    const project = await this.store.getProject(run.projectId);
    this.validateCommentPlan(
      run,
      {
        schemaVersion: 1,
        accounts: [account],
        projects: project ? [project] : [],
        runs: await this.store.listRuns({ accountId: run.accountId }),
        comments: await this.store.listComments({ accountId: run.accountId }),
      },
      chunkDraftId,
      run.id,
    );
  }

  /**
   * P3-1 D2：把该账号已批准、尚未派发的评论草稿打成一个评论 run（每条一个
   * chunk），认领草稿（sentRunId）后创建。时间窗 08:00–23:00；距最近一次浏览
   * run 结束 ≥10 分钟（评审拍板）。不在这里 start——调用方决定何时启动。
   */
  async createCommentRun(input: {
    projectId: string;
    accountId: string;
    draftIds?: string[];
  }): Promise<XhsOpsRun> {
    const account = await this.store.getAccount(input.accountId);
    if (!account || account.projectId !== input.projectId) {
      throw new XhsOpsError(404, "账号不存在或不属于该项目");
    }
    if (!account.deviceId) {
      throw new XhsOpsError(400, "账号未绑定设备，无法发评论");
    }
    const now = new Date(this.now());
    const hour = now.getHours();
    if (
      hour < XHS_COMMENT_WINDOW_START_HOUR ||
      hour >= XHS_COMMENT_WINDOW_END_HOUR
    ) {
      throw new XhsOpsError(
        409,
        `评论只在 ${String(XHS_COMMENT_WINDOW_START_HOUR).padStart(2, "0")}:00–${XHS_COMMENT_WINDOW_END_HOUR}:00 之间派发`,
      );
    }
    const today = localDateString(now);
    const todayRuns = await this.store.listRuns({
      accountId: account.id,
      date: today,
    });
    const lastBrowseEnd = todayRuns
      .filter((r) => r.plan.kind !== "comment" && r.completedAt)
      .map((r) => Date.parse(r.completedAt as string))
      .filter((t) => Number.isFinite(t))
      .reduce((max, t) => Math.max(max, t), 0);
    if (
      lastBrowseEnd > 0 &&
      this.now() - lastBrowseEnd < XHS_COMMENT_MIN_GAP_AFTER_BROWSE_MS
    ) {
      const wait = Math.ceil(
        (XHS_COMMENT_MIN_GAP_AFTER_BROWSE_MS - (this.now() - lastBrowseEnd)) /
          60_000,
      );
      throw new XhsOpsError(
        409,
        `浏览刚结束，${wait} 分钟后再发评论（与浏览间隔 ≥10 分钟）`,
      );
    }
    const approved = (
      await this.store.listComments({
        accountId: account.id,
        status: "approved",
      })
    )
      .filter((d) => !d.sentRunId && d.text)
      .filter((d) => !input.draftIds || input.draftIds.includes(d.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, 5);
    if (approved.length === 0) {
      throw new XhsOpsError(400, "没有已批准且未派发的评论");
    }
    const run = await this.createRunInternal(
      {
        projectId: input.projectId,
        accountId: account.id,
        date: today,
        segment: null,
        plan: {
          kind: "comment",
          keywords: [],
          homeFeedCount: 0,
          dwellSecMin: account.browseDefaults.dwellSecMin,
          dwellSecMax: account.browseDefaults.dwellSecMax,
          interaction: account.interaction,
          comments: approved.map((d) => ({
            draftId: d.id,
            postTitle: d.post.title,
            postAuthor: d.post.author,
            text: d.text as string,
          })),
        },
      },
      true,
    );
    logger.info(
      { runId: run.id, accountId: account.id, comments: approved.length },
      "xhs-ops: comment run created",
    );
    return run;
  }

  /** Kick off the executor; returns immediately with the run in `running`. */
  async startRun(runId: string): Promise<XhsOpsRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new XhsOpsError(404, "运行记录不存在");
    return this.withDeviceTransition(run.deviceId, async () => {
      try {
        return await this.startRunLocked(runId);
      } catch (error) {
        const current = await this.store.getRun(runId);
        if (
          current?.plan.kind === "comment" &&
          current.status === "planned" &&
          !this.queuedRunIds(current.deviceId).includes(runId) &&
          error instanceof XhsOpsError
        ) {
          await this.cancelRunLocked(runId);
        }
        throw error;
      }
    });
  }

  private async startRunLocked(runId: string): Promise<XhsOpsRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new XhsOpsError(404, "运行记录不存在");
    if (run.status !== "planned" || this.active.has(runId)) {
      throw new XhsOpsError(
        409,
        run.status === "running"
          ? "运行已在进行中"
          : "运行已结束，不能重新启动",
      );
    }
    const account = await this.store.assertDeviceBinding(
      run.accountId,
      run.deviceId,
    );
    if ((run.plan.kind ?? "browse") === "browse") {
      assertNurtureReady(
        account,
        await this.store.getProject(run.projectId),
        run.plan,
      );
    }
    await this.assertDeviceSafe(run);
    // 同一手机上已有 xhs-ops run 在跑：排队，前一个结束后自动启动（P2-4）。
    // 否则两个 run 各自 3s 轮询设备空闲，会一起冲进 TASK_ALREADY_RUNNING。
    const busyRunId = this.activeRunOnDevice(run.deviceId);
    if (busyRunId !== null && busyRunId !== runId) {
      const queue = this.deviceQueues.get(run.deviceId) ?? [];
      if (queue.includes(runId)) throw new XhsOpsError(409, "运行已在队列中");
      const now = this.nowIso();
      const queued = await this.store.updateRun(runId, (current) => ({
        ...current,
        queuedBehindRunId: busyRunId,
        updatedAt: now,
      }));
      if (!queued) throw new XhsOpsError(404, "运行记录不存在");
      queue.push(runId);
      this.deviceQueues.set(run.deviceId, queue);
      logger.info(
        {
          runId,
          deviceId: run.deviceId,
          behind: busyRunId,
          position: queue.length,
        },
        "xhs-ops: run queued behind another run on the same device",
      );
      return queued;
    }
    if (run.segment && run.segment.index > 1) {
      const predecessors = (
        await this.store.listRuns({ accountId: run.accountId, date: run.date })
      ).filter(
        (r) =>
          r.plan.kind !== "comment" &&
          r.segment?.index === (run.segment?.index ?? 0) - 1 &&
          r.segment.count === run.segment?.count,
      );
      if (predecessors[0]?.status !== "completed")
        throw new XhsOpsError(409, "前一分段尚未成功完成，不能执行后续分段");
    }
    if (run.plan.kind === "comment") await this.validateCommentRun(run);
    const startedAt = this.nowIso();
    const started = await this.store.updateRun(runId, (current) => ({
      ...current,
      status: "running",
      queuedBehindRunId: null,
      startedAt,
      completedAt: null,
      error: null,
      updatedAt: startedAt,
    }));
    if (!started) throw new XhsOpsError(404, "运行记录不存在");

    const controller: RunController = {
      cancelled: false,
      deviceId: started.deviceId,
      done: Promise.resolve(),
    };
    this.active.set(runId, controller);
    controller.done = this.execute(started, account, controller)
      .catch((error: unknown) => {
        // The loop guards every await; this only fires on a bug in the loop
        // itself. Still never leave the run stuck in `running`.
        logger.error(
          { runId, error: describe(error) },
          "xhs-ops: run executor crashed",
        );
        return this.finalizeRun(
          runId,
          controller,
          `执行器异常：${describe(error)}`,
        );
      })
      .catch((error: unknown) => {
        logger.error(
          { runId, error: describe(error) },
          "xhs-ops: run finalization failed",
        );
      })
      .finally(() =>
        this.withDeviceTransition(started.deviceId, async () => {
          this.active.delete(runId);
          const finished = await this.store.getRun(runId);
          // A transport failure can leave the phone executing after the
          // controller has stopped receiving the RPC. Keep comment claims
          // reserved while the run remains open so a late phone result cannot
          // overlap a newly dispatched comment.
          if (finished?.status !== "running") {
            await this.releaseUnprocessedDrafts(runId);
          }
          if (finished?.status === "completed")
            await this.drainDeviceQueue(started.deviceId);
          else
            await this.stopDeviceQueue(
              started.deviceId,
              "前一任务未成功完成，后续任务已停止",
            );
        }),
      )
      .catch((error: unknown) => {
        logger.error(
          { runId, error: describe(error) },
          "xhs-ops: queue cleanup failed",
        );
      });
    logger.info(
      { runId, deviceId: started.deviceId, chunks: started.chunks.length },
      "xhs-ops: run started",
    );
    return started;
  }

  /** Cancel queued work; an accepted phone chunk must finish before closing. */
  async cancelRun(runId: string): Promise<XhsOpsRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new XhsOpsError(404, "运行记录不存在");
    return this.withDeviceTransition(run.deviceId, () =>
      this.cancelRunLocked(runId),
    );
  }

  private async cancelRunLocked(runId: string): Promise<XhsOpsRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new XhsOpsError(404, "运行记录不存在");
    if (run.status === "planned") {
      // 还在设备队列里等着：出队即取消，不碰手机。
      const queue = this.deviceQueues.get(run.deviceId);
      if (queue) {
        const idx = queue.indexOf(runId);
        if (idx >= 0) queue.splice(idx, 1);
        if (queue.length === 0) this.deviceQueues.delete(run.deviceId);
      }
      const now = this.nowIso();
      const dequeued = await this.store.updateRun(runId, (current) => ({
        ...current,
        status: "cancelled",
        queuedBehindRunId: null,
        chunks: current.chunks.map((chunk) =>
          chunk.status === "pending"
            ? { ...chunk, status: "cancelled" }
            : chunk,
        ),
        completedAt: now,
        updatedAt: now,
      }));
      if (!dequeued) throw new XhsOpsError(404, "运行记录不存在");
      await this.releaseUnprocessedDrafts(runId);
      logger.info(
        { runId, deviceId: run.deviceId },
        "xhs-ops: queued run cancelled",
      );
      return dequeued;
    }
    if (run.status !== "running") {
      throw new XhsOpsError(409, "运行未在进行中，无法取消");
    }
    const controller = this.active.get(runId);
    if (!controller) {
      throw new XhsOpsError(
        409,
        "手机任务结果待核验，确认手机任务结束后才能取消运行",
      );
    }
    if (controller) controller.cancelled = true;
    const now = this.nowIso();
    const cancelled = await this.store.updateRun(runId, (current) => ({
      ...current,
      status: controller ? "running" : "cancelled",
      error: controller
        ? "取消请求已提交，当前手机任务块结束后停止"
        : current.error,
      chunks: current.chunks.map((chunk) =>
        chunk.status === "pending" ? { ...chunk, status: "cancelled" } : chunk,
      ),
      // No executor holds this run (e.g. it belonged to a previous process
      // instance), so nothing else will ever close it out.
      ...(controller ? {} : { completedAt: now }),
      updatedAt: now,
    }));
    if (!cancelled) throw new XhsOpsError(404, "运行记录不存在");
    logger.info({ runId, deviceId: run.deviceId }, "xhs-ops: run cancelled");
    // The RPC exposes taskId only at completion. "current" could belong to an
    // unrelated caller, so it cannot be used as proof of cancellation ownership.
    await this.stopDeviceQueue(
      run.deviceId,
      "前序任务已请求取消，后续任务已停止",
    );
    if (!controller) await this.releaseUnprocessedDrafts(runId);
    return cancelled;
  }

  /** Startup sweep: recover completed stops and preserve unconfirmed phone work. */
  async recoverInterruptedRuns(): Promise<number> {
    const runs = await this.store.listRuns();
    const queuedRuns: XhsOpsRun[] = [];
    let recovered = 0;
    for (const run of runs) {
      const unconfirmedChunkIndexes = new Set<number>();
      let preparationCancellationUnconfirmed = false;
      if (!this.active.has(run.id)) {
        for (const chunk of run.chunks) {
          if (
            chunk.status === "running" &&
            (Boolean(chunk.taskId) || chunk.error?.includes("待核验") === true)
          ) {
            // A CALL_USER chunk can outlive the desktop process. Stop only
            // the owned task; never send a cancellation for "current".
            if (
              !chunk.taskId ||
              !(await this.stopPreparationTask(run.deviceId, chunk.taskId))
            ) {
              unconfirmedChunkIndexes.add(chunk.index);
            }
          }
        }
      }
      if (
        !this.active.has(run.id) &&
        run.preparation?.status === "running" &&
        (Boolean(run.preparation.taskId) ||
          run.preparation.reasonCode === "dispatch_failed")
      ) {
        // Only interaction tasks have an ID persisted while still running.
        // Never substitute "current" or replay the login task after a crash.
        preparationCancellationUnconfirmed =
          !run.preparation.taskId ||
          !(await this.stopPreparationTask(
            run.deviceId,
            run.preparation.taskId,
          ));
      }
      if (
        unconfirmedChunkIndexes.size > 0 ||
        preparationCancellationUnconfirmed
      ) {
        const now = this.nowIso();
        await this.store.updateRun(run.id, (current) => {
          const chunks = current.chunks.map((chunk): XhsOpsRunChunk => {
            if (chunk.status !== "running") return chunk;
            if (unconfirmedChunkIndexes.has(chunk.index)) {
              return {
                ...chunk,
                error: "控制器重启后手机任务停止未确认，同设备后续任务已隔离",
              };
            }
            return {
              ...chunk,
              status: "failed",
              completedAt: now,
              error: "控制器重启，任务块被中断",
              anomalies: [
                ...chunk.anomalies,
                { type: "interrupted", detail: "控制器重启" },
              ],
            };
          });
          return {
            ...current,
            preparation:
              current.preparation?.status !== "running"
                ? current.preparation
                : preparationCancellationUnconfirmed
                  ? {
                      ...current.preparation,
                      reason:
                        "控制器重启后启动检查停止未确认，同设备后续任务已隔离",
                    }
                  : interruptPreparation(current.preparation, now),
            chunks,
            error: "控制器重启后手机任务停止未确认，同设备后续任务已隔离",
            summary: summarizeRun(
              chunks,
              current.startedAt,
              current.completedAt,
            ),
            updatedAt: now,
          };
        });
        continue;
      }
      if (run.status === "planned" && run.plan.kind === "comment") {
        await this.cancelRun(run.id);
        continue;
      }
      if (run.status === "planned" && run.queuedBehindRunId) {
        queuedRuns.push(run);
        continue;
      }
      if (run.status !== "running" || this.active.has(run.id)) {
        if (run.status !== "planned" && !this.active.has(run.id)) {
          if (
            run.chunks.some((chunk) => chunk.status === "running") ||
            run.preparation?.status === "running"
          ) {
            await this.store.updateRun(run.id, (current) => {
              const chunks = current.chunks.map(
                (chunk): XhsOpsRunChunk =>
                  chunk.status === "running"
                    ? {
                        ...chunk,
                        status: "failed",
                        completedAt: this.nowIso(),
                        error: "控制器重启，发送或互动结果待核验",
                        anomalies: [
                          ...chunk.anomalies,
                          {
                            type: "interrupted",
                            detail: "任务结束后仍存在未收口的任务块",
                          },
                        ],
                      }
                    : chunk,
              );
              return {
                ...current,
                preparation:
                  current.preparation?.status === "running"
                    ? interruptPreparation(current.preparation, this.nowIso())
                    : current.preparation,
                status:
                  current.status === "completed"
                    ? "interrupted"
                    : current.status,
                chunks,
                summary: summarizeRun(
                  chunks,
                  current.startedAt,
                  current.completedAt,
                ),
              };
            });
          }
          await this.releaseUnprocessedDrafts(run.id);
        }
        continue;
      }
      const now = this.nowIso();
      const updated = await this.store.updateRun(run.id, (current) => {
        const chunks = current.chunks.map((chunk): XhsOpsRunChunk => {
          if (chunk.status === "running") {
            return {
              ...chunk,
              status: "failed",
              completedAt: now,
              error: "控制器重启，任务块被中断",
              anomalies: [
                ...chunk.anomalies,
                { type: "interrupted", detail: "控制器重启" },
              ],
            };
          }
          return chunk.status === "pending"
            ? { ...chunk, status: "skipped" }
            : chunk;
        });
        return {
          ...current,
          status: "interrupted",
          preparation:
            current.preparation?.status === "running"
              ? interruptPreparation(current.preparation, now)
              : current.preparation,
          chunks,
          error: current.error ?? "控制器重启，运行被中断",
          completedAt: now,
          summary: summarizeRun(chunks, current.startedAt, now),
          updatedAt: now,
        };
      });
      if (updated) recovered += 1;
      await this.releaseUnprocessedDrafts(run.id);
    }
    // Resolve predecessors only after all interrupted executors are persisted.
    queuedRuns.sort(
      (a, b) =>
        a.accountId.localeCompare(b.accountId) ||
        (a.segment?.index ?? 0) - (b.segment?.index ?? 0) ||
        a.createdAt.localeCompare(b.createdAt),
    );
    for (const run of queuedRuns) {
      const predecessor = await this.store.getRun(run.queuedBehindRunId ?? "");
      if (
        predecessor?.status === "completed" &&
        run.date === localDateString(new Date(this.now()))
      ) {
        try {
          await this.startRun(run.id);
          continue;
        } catch (error) {
          logger.warn(
            { runId: run.id, error: describe(error) },
            "xhs-ops: could not recover queued run",
          );
        }
      }
      await this.cancelRun(run.id);
      await this.store.updateRun(run.id, (current) => ({
        ...current,
        error: "控制器重启，前序任务未成功完成或排队任务已失效",
      }));
    }
    if (recovered > 0) {
      logger.warn(
        { recovered },
        "xhs-ops: marked leftover running runs interrupted",
      );
    }
    return recovered;
  }

  isRunning(runId: string): boolean {
    return this.active.has(runId);
  }

  /** runId of the run currently executing on `deviceId`, if any. */
  activeRunOnDevice(deviceId: string): string | null {
    for (const [runId, controller] of this.active) {
      if (controller.deviceId === deviceId) return runId;
    }
    return null;
  }

  /** Queued runIds for `deviceId`, in start order. */
  queuedRunIds(deviceId: string): readonly string[] {
    return this.deviceQueues.get(deviceId) ?? [];
  }

  /** After a run drains, start the next planned run waiting on the same phone. */
  private async drainDeviceQueue(deviceId: string): Promise<void> {
    const queue = this.deviceQueues.get(deviceId);
    if (!queue) return;
    while (queue.length > 0) {
      const nextId = queue.shift();
      if (!nextId) break;
      const next = await this.store.getRun(nextId).catch(() => null);
      if (!next || next.status !== "planned") continue;
      try {
        await this.startRunLocked(nextId);
        logger.info(
          { runId: nextId, deviceId, remaining: queue.length },
          "xhs-ops: queued run started",
        );
        break;
      } catch (error: unknown) {
        logger.warn(
          { runId: nextId, deviceId, error: describe(error) },
          "xhs-ops: starting queued run failed, stopping queue",
        );
        queue.unshift(nextId);
        await this.stopDeviceQueue(
          deviceId,
          `排队任务无法启动：${describe(error)}`,
        );
        break;
      }
    }
    if (queue.length === 0) this.deviceQueues.delete(deviceId);
  }

  private async stopDeviceQueue(
    deviceId: string,
    reason: string,
  ): Promise<void> {
    const queue = this.deviceQueues.get(deviceId) ?? [];
    this.deviceQueues.delete(deviceId);
    for (const runId of queue) {
      await this.store.updateRun(runId, (run) =>
        run.status !== "planned"
          ? run
          : {
              ...run,
              status: "cancelled",
              queuedBehindRunId: null,
              error: reason,
              chunks: run.chunks.map((c) =>
                c.status === "pending" ? { ...c, status: "cancelled" } : c,
              ),
              completedAt: this.nowIso(),
              updatedAt: this.nowIso(),
            },
      );
      await this.releaseUnprocessedDrafts(runId);
    }
  }

  private async assertDeviceSafe(run: XhsOpsRun): Promise<void> {
    const today = localDateString(new Date(this.now()));
    // A new browse run can repair a missing login in preparation. Restrictions
    // and rate limits still stop the entire day, including preparation failures.
    const blocksRun = (type: string) =>
      isPreparationSafetyStop(type) ||
      (run.plan.kind === "comment" && type === "login_required");
    const history = await this.store.listRuns();
    const hasUnconfirmedTask = history.some(
      (previous) =>
        previous.id !== run.id &&
        previous.deviceId === run.deviceId &&
        !this.active.has(previous.id) &&
        (previous.preparation?.status === "running" ||
          previous.chunks.some((chunk) => chunk.status === "running")),
    );
    if (hasUnconfirmedTask) {
      throw new XhsOpsError(
        409,
        "该设备仍有停止未确认的手机任务，请确认任务结束后重启桌面端再试",
      );
    }
    const unsafe = history.some(
      (previous) =>
        (previous.deviceId === run.deviceId ||
          previous.accountId === run.accountId) &&
        ((previous.preparation?.reasonCode != null &&
          blocksRun(previous.preparation.reasonCode) &&
          localDateString(
            new Date(
              previous.preparation.completedAt ??
                previous.preparation.startedAt,
            ),
          ) === today) ||
          previous.chunks.some(
            (chunk) =>
              localDateString(
                new Date(
                  chunk.completedAt ?? chunk.startedAt ?? previous.updatedAt,
                ),
              ) === today && chunk.anomalies.some((a) => blocksRun(a.type)),
          )),
    );
    if (unsafe)
      throw new XhsOpsError(
        409,
        "该账号或设备今日触发安全停机，后续任务已暂停",
      );
  }

  private async dailyQuota(
    run: XhsOpsRun,
    chunk: XhsOpsRunChunk,
    currentBrowsedOrPlanned = chunk.plannedCount,
  ): Promise<XhsOpsChunkQuota> {
    const account = await this.store.assertDeviceBinding(
      run.accountId,
      run.deviceId,
    );
    const today = localDateString(new Date(this.now()));
    const used = { ...ZERO_COUNTS };
    let cumulativeEligiblePosts = 0;
    for (const previous of await this.store.listRuns()) {
      if (
        previous.accountId !== run.accountId &&
        previous.deviceId !== run.deviceId
      )
        continue;
      for (const recorded of previous.chunks) {
        const isCurrentChunk =
          previous.id === run.id && recorded.index === chunk.index;
        const isCurrentOrEarlierChunk =
          previous.id === run.id && recorded.index <= chunk.index;
        const activityAt =
          recorded.completedAt ??
          recorded.startedAt ??
          (isCurrentOrEarlierChunk ? this.nowIso() : previous.createdAt);
        if (localDateString(new Date(activityAt)) !== today) continue;
        if (recorded.mode !== "comment") {
          cumulativeEligiblePosts += isCurrentChunk
            ? currentBrowsedOrPlanned
            : recorded.browsed;
        }
        used.like += recorded.interactions.like;
        used.collect += recorded.interactions.collect;
        used.follow += recorded.interactions.follow;
        if (
          recorded.startedAt &&
          recorded.status !== "completed" &&
          recorded.mode !== "comment" &&
          !isCurrentChunk
        ) {
          const plannedThroughRecorded = previous.chunks
            .filter(
              (candidate) =>
                candidate.mode !== "comment" &&
                candidate.index <= recorded.index,
            )
            .reduce((total, candidate) => total + candidate.plannedCount, 0);
          const reserved = computeChunkQuota(
            previous.plan.interaction,
            ZERO_COUNTS,
            previous.chunks.length,
            plannedThroughRecorded,
          );
          used.like += Math.max(
            0,
            reserved.like.max - recorded.interactions.like,
          );
          used.collect += Math.max(
            0,
            reserved.collect.max - recorded.interactions.collect,
          );
          used.follow += Math.max(
            0,
            reserved.follow.max - recorded.interactions.follow,
          );
        }
      }
    }
    const constrain = (
      key: "like" | "collect" | "follow",
    ): XhsOpsInteractionRule => {
      const planRule = run.plan.interaction[key];
      const accountRule = account.interaction[key];
      const allowedTargets = new Set(accountRule.targetTypes ?? []);
      return {
        enabled: planRule.enabled && accountRule.enabled,
        dailyCap: Math.min(planRule.dailyCap, accountRule.dailyCap),
        ratioPercent: Math.min(planRule.ratioPercent, accountRule.ratioPercent),
        targetTypes:
          key === "follow"
            ? (planRule.targetTypes ?? []).filter((target) =>
                allowedTargets.has(target),
              )
            : undefined,
      };
    };
    return computeChunkQuota(
      {
        ...account.interaction,
        like: constrain("like"),
        collect: constrain("collect"),
        follow: constrain("follow"),
      },
      used,
      run.chunks.length,
      cumulativeEligiblePosts,
    );
  }

  /** Resolves once the executor for `runId` has drained (immediately if idle). */
  async waitForRun(runId: string): Promise<void> {
    await this.active.get(runId)?.done;
  }

  // ─── Executor ──────────────────────────────────────────────────────────────

  private async stopPreparationTask(
    deviceId: string,
    taskId: string,
  ): Promise<boolean> {
    if (!taskId || taskId === "current") return false;
    try {
      return (
        (await this.deviceControl.cancelTask(deviceId, { taskId }))
          ?.cancelled === true
      );
    } catch {
      return false;
    }
  }

  private async prepareOnDevice(
    run: XhsOpsRun,
    account: XhsOpsAccount,
    controller: RunController,
  ): Promise<string | null> {
    const startedAt = this.nowIso();
    let preparation: XhsOpsPreparation = {
      status: "running",
      reasonCode: null,
      reason: null,
      taskId: null,
      startedAt,
      completedAt: null,
    };
    await this.store.updateRun(run.id, (current) => ({
      ...current,
      preparation,
    }));
    const fail = (code: XhsOpsPreparationCode) => {
      const reasonCode = isPreparationSafetyStop(preparation.reasonCode)
        ? preparation.reasonCode
        : code;
      preparation = {
        ...preparation,
        status: "failed",
        reasonCode,
        reason: preparationReason(reasonCode),
      };
    };
    let cancellationUnconfirmed = false;
    try {
      const idle = await this.waitForIdle(controller);
      if (!idle.ok) {
        fail("device_unavailable");
      } else if (!controller.cancelled) {
        await this.store.assertDeviceBinding(run.accountId, run.deviceId);
        if (!controller.cancelled) {
          let { result } = await this.deviceControl.executeTask(
            run.deviceId,
            buildPreparationRequest(XHS_PACKAGE, account.platformAccountId),
          );
          if (
            result.success &&
            !result.needsInteraction &&
            !controller.cancelled &&
            interpretPreparationResult(result).reasonCode === "invalid_result"
          ) {
            // The first task is terminal. Recheck only the profile screen; do
            // not replay installation, SMS requests or login side effects.
            await this.store.updateRun(run.id, (current) => ({
              ...current,
              preparation: {
                ...preparation,
                taskId: result.taskId,
                reason: "正在复核登录状态并补全验证回执",
              },
            }));
            const idle = await this.waitForIdle(controller);
            if (!idle.ok) {
              fail("device_unavailable");
            } else if (!controller.cancelled) {
              ({ result } = await this.deviceControl.executeTask(
                run.deviceId,
                buildPreparationVerificationRequest(
                  XHS_PACKAGE,
                  account.platformAccountId,
                ),
              ));
            }
          }
          if (
            result.status === "aborted" &&
            result.errorCode === "USER_CANCELLED"
          )
            controller.cancelled = true;
          preparation = {
            ...preparation,
            ...(preparation.reasonCode === "device_unavailable"
              ? {}
              : interpretPreparationResult(result)),
            taskId: result.taskId,
          };
          if (result.needsInteraction) {
            // CALL_USER returns before the phone task ends. Stop this owned task
            // so the phone cannot resume login when its human-wait timer expires.
            try {
              await this.store.updateRun(run.id, (current) => ({
                ...current,
                preparation: { ...preparation, status: "running" },
              }));
            } finally {
              // A persistence failure must not leave a CALL_USER task able to resume.
              const stopped = await this.stopPreparationTask(
                run.deviceId,
                result.taskId,
              );
              if (!stopped) {
                cancellationUnconfirmed = true;
                const reasonCode = isPreparationSafetyStop(
                  preparation.reasonCode,
                )
                  ? preparation.reasonCode
                  : "dispatch_failed";
                preparation = {
                  ...preparation,
                  status: "running",
                  reasonCode,
                  reason: CANCELLATION_UNCONFIRMED,
                };
              } else {
                preparation = {
                  ...preparation,
                  status: "blocked",
                  reasonCode: isPreparationSafetyStop(preparation.reasonCode)
                    ? preparation.reasonCode
                    : "verification_required",
                  reason: preparationReason(
                    isPreparationSafetyStop(preparation.reasonCode)
                      ? preparation.reasonCode
                      : "verification_required",
                  ),
                };
              }
            }
          }
        }
      }
    } catch {
      // Login task errors may contain phone numbers/codes. Never persist/log them.
      // The RPC may have accepted the task before transport failed. Keep the
      // preparation open so recovery can reconcile the phone instead of
      // immediately allowing a duplicate login attempt.
      if (!cancellationUnconfirmed) {
        preparation = {
          ...preparation,
          status: "running",
          reasonCode: "dispatch_failed",
          reason: "手机任务结果待核验，请确认手机状态后重试",
        };
      }
    }
    if (controller.cancelled && !cancellationUnconfirmed) {
      // Cancellation must not erase a phone-reported restriction/day lock.
      const code = isPreparationSafetyStop(preparation.reasonCode)
        ? preparation.reasonCode
        : "cancelled";
      preparation = {
        ...preparation,
        status: "cancelled",
        reasonCode: code,
        reason: preparationReason(code),
      };
    }
    preparation = {
      ...preparation,
      completedAt: preparation.status === "running" ? null : this.nowIso(),
    };
    await this.store.updateRun(run.id, (current) => ({
      ...current,
      preparation,
    }));
    logger.info(
      {
        runId: run.id,
        status: preparation.status,
        reasonCode: preparation.reasonCode,
      },
      "xhs-ops: preparation finished",
    );
    return preparation.status === "ready" ? null : preparation.reason;
  }

  private async execute(
    run: XhsOpsRun,
    account: XhsOpsAccount,
    controller: RunController,
  ): Promise<void> {
    let consecutiveFailures = 0;
    let stopReason: string | null = null;

    if (run.plan.kind !== "comment" && !controller.cancelled) {
      stopReason = await this.prepareOnDevice(run, account, controller);
    }

    for (const chunk of run.chunks) {
      if (controller.cancelled) {
        await this.patchChunk(run.id, chunk.index, (c) =>
          c.status === "pending" ? { ...c, status: "cancelled" } : c,
        );
        continue;
      }
      if (stopReason !== null) {
        await this.patchChunk(run.id, chunk.index, (c) => ({
          ...c,
          status: "skipped",
        }));
        continue;
      }

      const idle = await this.waitForIdle(controller);
      if (controller.cancelled) {
        await this.patchChunk(run.id, chunk.index, (c) => ({
          ...c,
          status: "cancelled",
          completedAt: this.nowIso(),
        }));
        continue;
      }
      if (!idle.ok) {
        stopReason = idle.error;
        await this.patchChunk(run.id, chunk.index, (c) => ({
          ...c,
          status: "failed",
          completedAt: this.nowIso(),
          error: idle.error,
        }));
        logger.warn(
          { runId: run.id, chunk: chunk.index, error: idle.error },
          "xhs-ops: device not ready, stopping run",
        );
        continue;
      }

      await this.assertDeviceSafe(run);
      if (chunk.mode !== "comment") {
        try {
          const currentAccount = await this.store.assertDeviceBinding(
            run.accountId,
            run.deviceId,
          );
          assertNurtureReady(
            currentAccount,
            await this.store.getProject(run.projectId),
            run.plan,
          );
        } catch (error: unknown) {
          stopReason = error instanceof Error ? error.message : String(error);
          await this.patchChunk(run.id, chunk.index, (current) => ({
            ...current,
            status: "failed",
            completedAt: this.nowIso(),
            error: stopReason,
          }));
          continue;
        }
      }
      const quota = await this.dailyQuota(run, chunk);
      if (chunk.mode === "comment")
        await this.validateCommentRun(run, chunk.commentDraftId ?? undefined);
      if (controller.cancelled) continue;
      // Persist intent before dispatch. A restart cannot safely replay this chunk.
      await this.patchChunk(run.id, chunk.index, (c) => ({
        ...c,
        status: "running",
        startedAt: this.nowIso(),
      }));
      if (controller.cancelled) {
        await this.patchChunk(run.id, chunk.index, (c) => ({
          ...c,
          status: "cancelled",
          startedAt: null,
        }));
        continue;
      }
      const { stopRun: stopAfterChunk, ...outcome } =
        await this.runChunkOnDevice(run, account, chunk, quota, controller);

      await this.patchChunk(run.id, chunk.index, (c) => ({
        ...c,
        ...outcome,
        completedAt: outcome.status === "running" ? null : this.nowIso(),
      }));
      if (chunk.mode === "comment") {
        await this.recordCommentOutcome(run.id, chunk, outcome);
      }
      logger.info(
        {
          runId: run.id,
          chunk: chunk.index,
          mode: chunk.mode,
          keyword: chunk.keyword,
          status: outcome.status,
          browsed: outcome.browsed,
          anomalies: outcome.anomalies.map((a) => a.type),
        },
        "xhs-ops: chunk finished",
      );
      if (controller.cancelled) continue;

      const fatal = outcome.anomalies.find((a) =>
        SAFETY_STOP_TYPES.has(a.type),
      );
      if (fatal) {
        stopReason = `安全停机：手机报告 ${fatal.type}${fatal.detail ? `（${fatal.detail}）` : ""}`;
        continue;
      }
      if (stopAfterChunk) {
        stopReason = outcome.error ?? "手机任务需要人工处理，后续任务已暂停";
        continue;
      }
      if (outcome.status === "failed") {
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stopReason = `连续 ${MAX_CONSECUTIVE_FAILURES} 个任务块失败，已停止执行`;
        }
      } else {
        consecutiveFailures = 0;
      }
    }

    await this.finalizeRun(run.id, controller, stopReason);
  }

  /** 评论 chunk 收尾：把结果写回草稿（sent / failed），供队列和看板展示。 */
  private async recordCommentOutcome(
    runId: string,
    chunk: XhsOpsRunChunk,
    outcome: ChunkOutcome,
  ): Promise<void> {
    const draftId = chunk.commentDraftId;
    if (!draftId) return;
    if (outcome.status === "running") return;
    const now = this.nowIso();
    const sent =
      outcome.status === "completed" && (outcome.interactions.comment ?? 0) > 0;
    await this.store.updateComment(draftId, (cur) => {
      if (cur.sentRunId !== runId || cur.status !== "approved") return cur;
      return {
        ...cur,
        status: sent ? "sent" : "failed",
        sentRunId: runId,
        sentAt: sent ? now : cur.sentAt,
        sendResult: (
          outcome.error ??
          outcome.observation ??
          (sent ? "已发出" : "未发出")
        ).slice(0, 300),
        updatedAt: now,
      };
    });
  }

  /** 评论 run 结束时，认领了但没处理到的草稿（取消/中断）放回 approved 池。 */
  private async releaseUnprocessedDrafts(runId: string): Promise<void> {
    await this.store.settleCommentClaims(runId);
  }

  private async runChunkOnDevice(
    run: XhsOpsRun,
    account: XhsOpsAccount | null,
    chunk: XhsOpsRunChunk,
    quota: XhsOpsChunkQuota,
    controller: RunController,
  ): Promise<ChunkOutcome> {
    const base = {
      label: run.accountLabel,
      positioning: account?.positioning ?? "",
      persona: formatPersona(account?.persona),
      dwellSecMin: run.plan.dwellSecMin,
      dwellSecMax: run.plan.dwellSecMax,
      quota,
    };
    const comment =
      chunk.mode === "comment"
        ? (run.plan.comments ?? []).find(
            (c) => c.draftId === chunk.commentDraftId,
          )
        : undefined;
    if (chunk.mode === "comment" && !comment) {
      return {
        status: "failed",
        browsed: 0,
        skipped: 0,
        refreshCount: 0,
        interactions: { ...ZERO_COUNTS },
        anomalies: [{ type: "other", detail: "评论 chunk 找不到对应草稿" }],
        posts: [],
        observation: null,
        taskId: null,
        totalSteps: null,
        finalScreenshot: null,
        message: null,
        error: "评论 chunk 找不到对应草稿",
      };
    }
    const task = comment
      ? buildCommentChunkTask({
          label: base.label,
          positioning: base.positioning,
          persona: base.persona,
          postTitle: comment.postTitle,
          postAuthor: comment.postAuthor,
          text: comment.text,
        })
      : chunk.mode === "search"
        ? buildSearchChunkTask({
            ...base,
            keyword: chunk.keyword ?? "",
            count: chunk.plannedCount,
          })
        : buildHomeChunkTask({ ...base, count: chunk.plannedCount });
    const body: DeviceExecuteTaskBody = {
      task,
      maxSteps: chunkMaxSteps(chunk.plannedCount, chunk.mode),
      timeout: XHS_CHUNK_TIMEOUT_MS,
      allowedApps: [XHS_PACKAGE],
      // 评论 chunk：手机策略放开评论但只放行这一条审核原文（逐字白名单）。
      taskPolicy: comment ? commentTaskPolicy(comment.text) : XHS_TASK_POLICY,
    };

    let outcome: ChunkOutcome;
    try {
      const taskStartedAt = this.now();
      const { result } = await this.deviceControl.executeTask(
        run.deviceId,
        body,
      );
      const record = comment ? null : parseRecordJson(result.message);
      const evidenceQuota = comment
        ? quota
        : await this.dailyQuota(
            run,
            chunk,
            Math.min(record?.browsed ?? 0, chunk.plannedCount),
          );
      outcome = comment
        ? interpretCommentTaskResult(result)
        : interpretTaskResult(result, {
            mode: chunk.mode === "home" ? "home" : "search",
            keyword: chunk.keyword,
            plannedCount: chunk.plannedCount,
            dwellSecMin: run.plan.dwellSecMin,
            elapsedMs: this.now() - taskStartedAt,
            quota: evidenceQuota,
          });
      if (
        result.status === "aborted" &&
        result.errorCode === "USER_CANCELLED"
      ) {
        controller.cancelled = true;
      } else if (result.needsInteraction) {
        // CALL_USER is not a terminal result: the phone can otherwise resume
        // after its human-wait timer. Keep this chunk running until stop is acked.
        let stopped = false;
        try {
          await this.patchChunk(run.id, chunk.index, (current) => ({
            ...current,
            taskId: result.taskId,
            error: "手机需要人工处理，正在等待手机停止确认",
          }));
        } finally {
          stopped = await this.stopPreparationTask(run.deviceId, result.taskId);
        }
        outcome.status = stopped ? "failed" : "running";
        outcome.stopRun = true;
        outcome.error = stopped
          ? "手机需要人工处理，已确认停止，后续养号任务已暂停"
          : "手机需要人工处理，但尚未确认停止；请在手机上检查任务状态";
      }
    } catch (error: unknown) {
      const reason = describe(error).slice(0, MAX_ERROR_CHARS);
      outcome = {
        status: "running",
        stopRun: true,
        browsed: 0,
        skipped: 0,
        refreshCount: 0,
        interactions: { ...ZERO_COUNTS },
        anomalies: [{ type: "interrupted", detail: reason }],
        posts: [],
        observation: null,
        taskId: null,
        totalSteps: null,
        finalScreenshot: null,
        message: null,
        error: `手机任务结果待核验：${reason}`,
      };
      logger.warn(
        { runId: run.id, chunk: chunk.index, error: reason },
        "xhs-ops: device task dispatch failed",
      );
    }
    if (controller.cancelled && outcome.status !== "running") {
      outcome.status = "cancelled";
    }
    return outcome;
  }

  /**
   * Poll the device until idle (spec §4.1). Missing/offline devices fail
   * immediately; a device that stays busy fails at the deadline.
   */
  private async waitForIdle(
    controller: RunController,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const deadline = this.now() + this.idleWaitTimeoutMs;
    let lastProbeError: string | null = null;
    for (;;) {
      if (controller.cancelled) return { ok: false, error: "已取消" };
      let device: DeviceInfo | null | undefined;
      try {
        device = await this.deviceControl.getDevice(controller.deviceId);
      } catch (error: unknown) {
        if (
          error instanceof DeviceControlRpcError &&
          error.code === "DEVICE_NOT_FOUND"
        ) {
          return { ok: false, error: DEVICE_UNAVAILABLE };
        }
        lastProbeError = describe(error);
        device = undefined;
      }
      if (device === null) return { ok: false, error: DEVICE_UNAVAILABLE };
      if (device) {
        if (this.now() - device.lastSeen > this.offlineAfterMs) {
          return { ok: false, error: DEVICE_UNAVAILABLE };
        }
        if (device.status === "idle") return { ok: true };
      }
      if (this.now() >= deadline) {
        return {
          ok: false,
          error: device
            ? "等待设备空闲超时"
            : `${DEVICE_UNAVAILABLE}（无法查询设备状态：${lastProbeError ?? "unknown"}）`,
        };
      }
      await sleep(this.idlePollIntervalMs);
    }
  }

  private async patchChunk(
    runId: string,
    index: number,
    patch: (chunk: XhsOpsRunChunk) => XhsOpsRunChunk,
  ): Promise<void> {
    const updated = await this.store.updateRun(runId, (current) => ({
      ...current,
      chunks: current.chunks.map((chunk) =>
        chunk.index === index ? patch(chunk) : chunk,
      ),
      updatedAt: this.nowIso(),
    }));
    if (!updated) throw new XhsOpsError(404, "运行记录不存在");
  }

  private async finalizeRun(
    runId: string,
    controller: RunController,
    stopReason: string | null,
  ): Promise<void> {
    const completedAt = this.nowIso();
    const finished = await this.store.updateRun(runId, (current) => {
      const hasUnconfirmedWork =
        current.preparation?.status === "running" ||
        current.chunks.some((chunk) => chunk.status === "running");
      const failure =
        stopReason ??
        (current.chunks.some((chunk) => chunk.status === "failed")
          ? "部分任务块执行失败"
          : null);
      if (hasUnconfirmedWork && !controller.cancelled) {
        return {
          ...current,
          status: "running",
          error: current.error ?? failure,
          completedAt: null,
          updatedAt: completedAt,
        };
      }
      const status = controller.cancelled
        ? "cancelled"
        : failure !== null
          ? "failed"
          : "completed";
      return {
        ...current,
        status,
        error: controller.cancelled ? current.error : failure,
        chunks: current.chunks.map((chunk) =>
          chunk.status === "running"
            ? chunk
            : chunk.status === "pending"
              ? {
                  ...chunk,
                  status: controller.cancelled ? "cancelled" : "skipped",
                  completedAt,
                }
              : chunk,
        ),
        completedAt,
        summary: summarizeRun(current.chunks, current.startedAt, completedAt),
        updatedAt: completedAt,
      };
    });
    logger.info(
      {
        runId,
        status: finished?.status ?? "missing",
        error: finished?.error ?? null,
        summary: finished?.summary ?? null,
      },
      "xhs-ops: run finished",
    );
  }
}
