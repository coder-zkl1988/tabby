import {
  XHS_TAKEOVER_AUDIT_RUNNING_MESSAGE,
  XHS_TAKEOVER_DEVICE_HOLD_MESSAGE,
  XHS_TAKEOVER_NO_NURTURE_TODAY_MESSAGE,
  type XhsOpsAccount,
  type XhsOpsPlanSkip,
  type XhsOpsPlanSuggestion,
  type XhsOpsProject,
  type XhsOpsRun,
  type XhsOpsRunCreate,
  xhsOpsTakeoverPausedMessage,
} from "@nexu/shared";
import { logger } from "../lib/logger.js";
import type { XhsOpsStore } from "../store/xhs-ops-store.js";
import type { XhsOpsChangeOrderService } from "./xhs-ops-change-order-service.js";
import { XhsOpsError, localDateString } from "./xhs-ops-run-service.js";
import type { XhsOpsTakeoverRecoveryState } from "./xhs-ops-takeover-recovery.js";

/**
 * P2-4 每日自动执行的胶水。OpenClaw cron 只能投递 agentTurn、带不了账目，所以
 * controller 自己每分钟看一眼：项目 `schedule.enabled` 且本地时间到了 `time`
 * 且今天还没触发 → 对项目下每个已绑设备的账号 plan-suggest → createRun →
 * startRun。同一手机上的多个 run（多账号 / 多段）由 XhsOpsRunService 的设备
 * 队列串行，这里只管"点火"。每次派发先用持久化 run 对账，补启动未入队的
 * planned run，并按项目/日期/账号/分段幂等创建缺失 run；全部处理完成后才记录
 * `lastTriggeredDate`。进程内另加 in-flight 锁避免 tick 重叠。
 */

export const XHS_OPS_SCHEDULER_INTERVAL_MS = 60_000;

export type XhsOpsSchedulerRunService = {
  suggestPlans(
    projectId: string,
    options?: { onSkipped?: (skip: XhsOpsPlanSkip) => void },
  ): Promise<XhsOpsPlanSuggestion[]>;
  createRun(
    input: XhsOpsRunCreate,
    options?: { onCreated?: () => void },
  ): Promise<XhsOpsRun>;
  startRun(runId: string): Promise<XhsOpsRun>;
};

export interface XhsOpsSchedulerDeps {
  store: XhsOpsStore;
  runService: XhsOpsSchedulerRunService;
  /**
   * Lists a takeover account's change orders, which lazily expires a stale
   * precheck and with it activeChangeOrderId (§6.1). Absent: no refresh.
   */
  changeOrders?: Pick<XhsOpsChangeOrderService, "listChangeOrders">;
  /**
   * The takeover startup recovery (§2.6): nothing is dispatched for a
   * takeover account until it settled. Absent means none is pending.
   */
  takeoverRecovery?: XhsOpsTakeoverRecoveryState;
  now?: () => number;
  intervalMs?: number;
}

/** Why a takeover account sits out this dispatch (§6.1); `retry`: worth another tick today. */
interface TakeoverSkip {
  reason: string;
  retry: boolean;
}

const TAKEOVER_RECOVERY_PENDING =
  "控制器刚重启，接管任务的恢复检查还没完成，稍后自动重试";

/**
 * The scheduler-side half of the takeover maintenance gate (§6.1 bullet 4):
 * a safety pause, a device hold, a running audit or a public-profile change
 * today keeps the account out of the day's dispatch. The first three can
 * clear the same day, so the project is tried again on the next tick; a
 * change today keeps nurture off until tomorrow (MT-03).
 */
function takeoverSkip(
  account: XhsOpsAccount,
  context: { auditRunning: boolean; today: string },
): TakeoverSkip | null {
  const takeover = account.takeover;
  if (!takeover) return null;
  if (takeover.safetyPause)
    return {
      reason: xhsOpsTakeoverPausedMessage(takeover.safetyPause.reason),
      retry: true,
    };
  if (takeover.deviceHold)
    return { reason: XHS_TAKEOVER_DEVICE_HOLD_MESSAGE, retry: true };
  if (context.auditRunning)
    return { reason: XHS_TAKEOVER_AUDIT_RUNNING_MESSAGE, retry: true };
  if (takeover.noNurtureDates.includes(context.today))
    return { reason: XHS_TAKEOVER_NO_NURTURE_TODAY_MESSAGE, retry: false };
  return null;
}

export interface XhsOpsScheduleTriggerResult {
  projectId: string;
  date: string;
  /** Suggestions the planner produced (one per remaining account segment). */
  planned: number;
  created: number;
  /** Runs that went straight to `running`. */
  started: number;
  /** Runs parked in a device queue behind another run on the same phone. */
  queued: number;
  /** Human-readable reasons for plans that could not be dispatched. */
  skipped: string[];
  summary: string;
}

export function localClock(now: Date): string {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** A lastResult without its HH:MM: two ticks with the same outcome compare equal. */
function withoutClock(lastResult: string): string {
  return lastResult.replace(/^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2} /, "$1 ");
}

/** True when the schedule should fire at `now`: enabled, time reached, not yet fired today. */
export function isScheduleDue(project: XhsOpsProject, now: Date): boolean {
  const schedule = project.schedule;
  if (!schedule?.enabled) return false;
  const today = localDateString(now);
  if (schedule.lastTriggeredDate === today) return false;
  return localClock(now) >= schedule.time;
}

function dispatchKey(run: Pick<XhsOpsRun, "accountId" | "segment">): string {
  return run.segment
    ? `${run.accountId}:${run.segment.index}/${run.segment.count}`
    : `${run.accountId}:single`;
}

export class XhsOpsScheduler {
  private readonly store: XhsOpsStore;
  private readonly runService: XhsOpsSchedulerRunService;
  private readonly changeOrders: XhsOpsSchedulerDeps["changeOrders"];
  private readonly takeoverRecovery: XhsOpsTakeoverRecoveryState | undefined;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<string>();

  constructor(deps: XhsOpsSchedulerDeps) {
    this.store = deps.store;
    this.runService = deps.runService;
    this.changeOrders = deps.changeOrders;
    this.takeoverRecovery = deps.takeoverRecovery;
    this.now = deps.now ?? (() => Date.now());
    this.intervalMs = deps.intervalMs ?? XHS_OPS_SCHEDULER_INTERVAL_MS;
  }

  /**
   * The takeover accounts of a project that sit out this dispatch, keyed by
   * account id. Until the startup recovery settled every takeover account
   * waits; afterwards each one's change orders are listed first, so a stale
   * precheck has expired before the account is evaluated.
   */
  private async takeoverSkips(
    projectId: string,
    today: string,
  ): Promise<Map<string, TakeoverSkip>> {
    const skips = new Map<string, TakeoverSkip>();
    const takeovers = (
      await this.store.listAccountsByProject(projectId)
    ).filter((account) => account.takeover !== null);
    for (const listed of takeovers) {
      if (this.takeoverRecovery?.settled === false) {
        skips.set(listed.id, {
          reason: TAKEOVER_RECOVERY_PENDING,
          retry: true,
        });
        continue;
      }
      if (this.changeOrders) {
        try {
          await this.changeOrders.listChangeOrders(listed.id);
        } catch (error: unknown) {
          logger.warn(
            {
              accountId: listed.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "xhs-ops: refreshing a takeover's change orders before dispatch failed",
          );
        }
      }
      const account = (await this.store.getAccount(listed.id)) ?? listed;
      const skip = takeoverSkip(account, {
        auditRunning: Boolean(account.takeover?.activeAuditId),
        today,
      });
      if (skip) skips.set(account.id, skip);
    }
    return skips;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "xhs-ops: scheduler tick failed",
        );
      });
    }, this.intervalMs);
    this.timer.unref?.();
    logger.info({ intervalMs: this.intervalMs }, "xhs-ops: scheduler started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over all projects; fires every schedule that is due. */
  async tick(): Promise<XhsOpsScheduleTriggerResult[]> {
    const now = new Date(this.now());
    const projects = await this.store.listProjects();
    const fired: XhsOpsScheduleTriggerResult[] = [];
    for (const project of projects) {
      if (!isScheduleDue(project, now)) continue;
      try {
        fired.push(
          await this.triggerProject(project.id, { reason: "schedule" }),
        );
      } catch (error: unknown) {
        logger.warn(
          {
            projectId: project.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "xhs-ops: scheduled trigger failed",
        );
      }
    }
    return fired;
  }

  /**
   * Dispatch today's plans for one project now. `reason: "manual"` is the
   * 「立即执行一次」 button and ignores enabled/time, but still records the
   * trigger so the scheduled pass does not run the same day twice.
   */
  async triggerProject(
    projectId: string,
    opts: { reason: "schedule" | "manual" } = { reason: "manual" },
  ): Promise<XhsOpsScheduleTriggerResult> {
    const project = await this.store.getProject(projectId);
    if (!project) throw new XhsOpsError(404, "项目不存在");
    if (this.inFlight.has(projectId)) {
      throw new XhsOpsError(409, "该项目的自动执行正在派发中");
    }
    this.inFlight.add(projectId);
    const date = localDateString(new Date(this.now()));
    try {
      const existingRuns = (
        await this.store.listRuns({ projectId, date })
      ).filter((run) => (run.plan.kind ?? "browse") === "browse");
      const runsByKey = new Map<string, XhsOpsRun>();
      for (const run of existingRuns) {
        const key = dispatchKey(run);
        if (!runsByKey.has(key)) runsByKey.set(key, run);
      }
      const takeoverSkips = await this.takeoverSkips(projectId, date);
      const suggestSkips: XhsOpsPlanSkip[] = [];
      const plans = await this.runService.suggestPlans(projectId, {
        onSkipped: (skip) => suggestSkips.push(skip),
      });
      const result: XhsOpsScheduleTriggerResult = {
        projectId,
        date,
        planned: plans.length,
        created: 0,
        started: 0,
        queued: 0,
        // A 409 like 兴趣池不足 waits for the operator, as an empty pool does.
        skipped: suggestSkips.map(
          (skip) => `${skip.accountLabel}：${skip.reason}`,
        ),
        summary: "",
      };
      let dispatchComplete = true;
      const blockedAccounts = new Set<string>();
      const reportedTakeoverSkips = new Set<string>();
      /** A takeover account that sits this dispatch out: say why once, retry if it may clear today. */
      const skipTakeover = (accountId: string, label: string): boolean => {
        const skip = takeoverSkips.get(accountId);
        if (!skip) return false;
        if (skip.retry) dispatchComplete = false;
        if (!reportedTakeoverSkips.has(accountId)) {
          reportedTakeoverSkips.add(accountId);
          result.skipped.push(`${label}：${skip.reason}`);
        }
        return true;
      };

      const recordDispatch = (run: XhsOpsRun): boolean => {
        runsByKey.set(dispatchKey(run), run);
        if (run.status === "running") {
          result.started += 1;
          return true;
        }
        if (run.status === "planned" && Boolean(run.queuedBehindRunId)) {
          result.queued += 1;
          return true;
        }
        return false;
      };

      const start = async (run: XhsOpsRun, label: string): Promise<void> => {
        if (recordDispatch(run)) return;
        try {
          const started = await this.runService.startRun(run.id);
          if (!recordDispatch(started)) {
            dispatchComplete = false;
            blockedAccounts.add(run.accountId);
            result.skipped.push(`${label}：启动后仍未运行或排队`);
          }
        } catch (error: unknown) {
          if (error instanceof XhsOpsError && error.status === 409) {
            const latest = await this.store.getRun(run.id);
            if (latest && recordDispatch(latest)) return;
          }
          // A conflict is retryable unless the persisted run proves that it
          // is already running or explicitly queued behind another run.
          dispatchComplete = false;
          blockedAccounts.add(run.accountId);
          result.skipped.push(
            `${label}：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      const runsToResume = [...runsByKey.values()]
        .filter(
          (run) => run.status === "planned" && run.queuedBehindRunId === null,
        )
        .sort(
          (left, right) =>
            left.accountId.localeCompare(right.accountId) ||
            (left.segment?.index ?? 0) - (right.segment?.index ?? 0),
        );
      for (const run of runsToResume) {
        if (blockedAccounts.has(run.accountId)) continue;
        if (skipTakeover(run.accountId, run.accountLabel)) continue;
        const label = `${run.accountLabel}${run.segment && run.segment.count > 1 ? ` 第${run.segment.index}/${run.segment.count}段` : ""}`;
        await start(run, label);
      }

      for (const plan of plans) {
        const label = `${plan.accountLabel}${plan.segment && plan.segment.count > 1 ? ` 第${plan.segment.index}/${plan.segment.count}段` : ""}`;
        const key = dispatchKey(plan);
        if (runsByKey.has(key)) continue;
        if (skipTakeover(plan.accountId, plan.accountLabel)) continue;
        if (blockedAccounts.has(plan.accountId)) {
          result.skipped.push(`${label}：同账号前序分段启动失败，暂停派发`);
          continue;
        }
        if (plan.keywords.length === 0 && plan.homeFeedCount === 0) {
          result.skipped.push(`${label}：兴趣池为空，没有可执行的关键词`);
          continue;
        }
        try {
          const created = await this.runService.createRun(
            {
              projectId,
              accountId: plan.accountId,
              reuseActive: true,
              date,
              segment: plan.segment ?? null,
              plan: {
                keywords: plan.keywords,
                homeFeedCount: plan.homeFeedCount,
                dwellSecMin: plan.dwellSecMin,
                dwellSecMax: plan.dwellSecMax,
                interaction: plan.interaction,
              },
            },
            {
              onCreated: () => {
                result.created += 1;
              },
            },
          );
          runsByKey.set(key, created);
          await start(created, label);
        } catch (error: unknown) {
          dispatchComplete = false;
          blockedAccounts.add(plan.accountId);
          result.skipped.push(
            `${label}：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      result.summary =
        plans.length === 0 &&
        result.started === 0 &&
        result.queued === 0 &&
        result.skipped.length === 0
          ? "没有可执行的计划（无已绑定手机的账号，或今日各段已执行）"
          : `${result.started} 个开始、${result.queued} 个排队${result.skipped.length > 0 ? `、${result.skipped.length} 个未派发` : ""}`;
      const latestProject = await this.store.getProject(projectId);
      const schedule = latestProject?.schedule ?? project.schedule;
      const lastTriggeredDate = dispatchComplete
        ? date
        : (latestProject?.schedule.lastTriggeredDate ??
          project.schedule.lastTriggeredDate);
      const lastResult =
        `${date} ${localClock(new Date(this.now()))} ${opts.reason === "manual" ? "手动" : "定时"}：${result.summary}${result.skipped.length > 0 ? `（${result.skipped.join("；")}）` : ""}`.slice(
          0,
          500,
        );
      // A dispatch still waiting on the same thing — a paused or held
      // takeover, the startup recovery, a run that keeps answering 409 — is
      // tried again on every tick. Writing that same outcome under a new
      // clock each minute would move the project's updatedAt all day (all
      // through a 48-hour pause) and fail every card that saves with it as
      // expectedUpdatedAt, so a scheduled pass that changed nothing writes
      // nothing; lastResult keeps the time this outcome was first seen.
      const unchanged =
        opts.reason === "schedule" &&
        lastTriggeredDate === schedule.lastTriggeredDate &&
        schedule.lastResult !== null &&
        withoutClock(schedule.lastResult) === withoutClock(lastResult);
      if (!unchanged)
        await this.store.updateProject(projectId, {
          schedule: { ...schedule, lastTriggeredDate, lastResult },
        });
      logger.info(
        { reason: opts.reason, ...result, skipped: result.skipped.length },
        "xhs-ops: daily schedule triggered",
      );
      return result;
    } finally {
      this.inFlight.delete(projectId);
    }
  }
}
