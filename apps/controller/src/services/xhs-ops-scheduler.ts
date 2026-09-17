import type {
  XhsOpsPlanSuggestion,
  XhsOpsProject,
  XhsOpsRun,
  XhsOpsRunCreate,
} from "@nexu/shared";
import { logger } from "../lib/logger.js";
import type { XhsOpsStore } from "../store/xhs-ops-store.js";
import { XhsOpsError, localDateString } from "./xhs-ops-run-service.js";

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
  suggestPlans(projectId: string): Promise<XhsOpsPlanSuggestion[]>;
  createRun(
    input: XhsOpsRunCreate,
    options?: { onCreated?: () => void },
  ): Promise<XhsOpsRun>;
  startRun(runId: string): Promise<XhsOpsRun>;
};

export interface XhsOpsSchedulerDeps {
  store: XhsOpsStore;
  runService: XhsOpsSchedulerRunService;
  now?: () => number;
  intervalMs?: number;
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
  private readonly now: () => number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<string>();

  constructor(deps: XhsOpsSchedulerDeps) {
    this.store = deps.store;
    this.runService = deps.runService;
    this.now = deps.now ?? (() => Date.now());
    this.intervalMs = deps.intervalMs ?? XHS_OPS_SCHEDULER_INTERVAL_MS;
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
      const plans = await this.runService.suggestPlans(projectId);
      const result: XhsOpsScheduleTriggerResult = {
        projectId,
        date,
        planned: plans.length,
        created: 0,
        started: 0,
        queued: 0,
        skipped: [],
        summary: "",
      };
      let dispatchComplete = true;
      const blockedAccounts = new Set<string>();

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
        const label = `${run.accountLabel}${run.segment && run.segment.count > 1 ? ` 第${run.segment.index}/${run.segment.count}段` : ""}`;
        await start(run, label);
      }

      for (const plan of plans) {
        const label = `${plan.accountLabel}${plan.segment && plan.segment.count > 1 ? ` 第${plan.segment.index}/${plan.segment.count}段` : ""}`;
        const key = dispatchKey(plan);
        if (runsByKey.has(key)) continue;
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
      await this.store.updateProject(projectId, {
        schedule: {
          ...(latestProject?.schedule ?? project.schedule),
          lastTriggeredDate: dispatchComplete
            ? date
            : (latestProject?.schedule.lastTriggeredDate ??
              project.schedule.lastTriggeredDate),
          lastResult:
            `${date} ${localClock(new Date(this.now()))} ${opts.reason === "manual" ? "手动" : "定时"}：${result.summary}${result.skipped.length > 0 ? `（${result.skipped.join("；")}）` : ""}`.slice(
              0,
              500,
            ),
        },
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
