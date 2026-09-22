import { createHash } from "node:crypto";
import type {
  ChannelType,
  CreateScheduleInput,
  ScheduleResponse,
  UpdateScheduleInput,
} from "@nexu/shared";
import { HTTPException } from "hono/http-exception";
import { resolveOpenClawChannelKey } from "../lib/channel-binding-compiler.js";
import { logger } from "../lib/logger.js";
import type { SessionsRuntime } from "../runtime/sessions-runtime.js";
import type { NexuConfigStore } from "../store/nexu-config-store.js";
import {
  type CronEvent,
  type CronJobCreateInput,
  type OpenClawCronGateway,
  deliveryTargetFromSessionKey,
  mapCronJobToScheduleItem,
  mergeCronJobRuntimeState,
} from "./openclaw-cron-gateway.js";
import type { OpenClawSyncService } from "./openclaw-sync-service.js";

function buildDedupKey(s: ScheduleResponse): string {
  return `${s.botId}|${s.name}|${s.cron}`;
}

const RECONCILE_RUN_PAGE_SIZE = 100;
const RECONCILE_RUN_MAX_PAGES = 10;

export class ScheduleService {
  private readonly outputDeliveryQueues = new Map<string, Promise<void>>();
  private registration: Promise<void> | null = null;
  private reconciliation: Promise<void> | null = null;
  private hasBootstrapped = false;

  constructor(
    private readonly configStore: NexuConfigStore,
    private readonly cronGateway: OpenClawCronGateway,
    private readonly syncService: OpenClawSyncService,
    private readonly sessionsRuntime: SessionsRuntime,
  ) {
    this.cronGateway.onEvent((event) => {
      void this.queueCronEvent(event);
    });
  }

  private queueCronEvent(event: CronEvent): Promise<void> {
    if (
      event.action !== "finished" ||
      event.status !== "ok" ||
      !event.summary?.trim() ||
      event.runAtMs === undefined ||
      !Number.isFinite(event.runAtMs)
    ) {
      return Promise.resolve();
    }
    const previous = this.outputDeliveryQueues.get(event.jobId);
    const work = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.deliverChangedOutput(event));
    const tracked = work
      .catch((error) => {
        logger.warn(
          {
            jobId: event.jobId,
            error: error instanceof Error ? error.message : String(error),
          },
          "schedule_changed_output_delivery_failed",
        );
      })
      .finally(() => {
        if (this.outputDeliveryQueues.get(event.jobId) === tracked) {
          this.outputDeliveryQueues.delete(event.jobId);
        }
      });
    this.outputDeliveryQueues.set(event.jobId, tracked);
    return tracked;
  }

  private async deliverChangedOutput(event: CronEvent): Promise<void> {
    const config = await this.configStore.getConfig();
    const schedule = (config.schedules ?? []).find(
      (entry) => entry.externalId === event.jobId,
    );
    if (
      !schedule?.onlyNotifyOnChange ||
      !event.summary ||
      event.runAtMs === undefined
    ) {
      return;
    }

    const normalizedOutput = event.summary.trim().replaceAll("\r\n", "\n");
    const fingerprint = createHash("sha256")
      .update(normalizedOutput)
      .digest("hex");
    const observedAt = new Date(event.runAtMs).toISOString();
    const lastObservedAtMs = schedule.lastOutputObservedAt
      ? Date.parse(schedule.lastOutputObservedAt)
      : Number.NaN;
    if (Number.isFinite(lastObservedAtMs) && event.runAtMs < lastObservedAtMs) {
      return;
    }
    if (
      schedule.lastOutputFingerprint === fingerprint &&
      schedule.lastOutputNotificationStatus !== "failed"
    ) {
      await this.configStore.recordScheduleOutputNotification(schedule.id, {
        fingerprint,
        observedAt,
        status: "suppressed",
      });
      return;
    }

    const deliveryTo = await this.resolveLatestChannelTarget(
      schedule.botId,
      schedule.channelType,
      schedule.channelId,
    );
    if (!schedule.channelType || !deliveryTo) {
      await this.configStore.recordScheduleOutputNotification(schedule.id, {
        fingerprint,
        observedAt,
        status: "failed",
        error: "No channel delivery target is available",
      });
      return;
    }

    const idempotencyKey = createHash("sha256")
      .update(
        [
          "nexu-schedule-output",
          schedule.id,
          String(event.runAtMs),
          fingerprint,
        ].join(":"),
      )
      .digest("hex");
    try {
      await this.cronGateway.sendOutput({
        channel: resolveOpenClawChannelKey(schedule.channelType as ChannelType),
        to: deliveryTo,
        message: normalizedOutput,
        accountId: schedule.channelId,
        sessionKey: schedule.sessionKey,
        idempotencyKey,
      });
      await this.configStore.recordScheduleOutputNotification(schedule.id, {
        fingerprint,
        observedAt,
        status: "delivered",
      });
    } catch (error) {
      await this.configStore.recordScheduleOutputNotification(schedule.id, {
        fingerprint,
        observedAt,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildCronJobInput(
    schedule: ScheduleResponse,
    deliveryTo?: string,
  ): CronJobCreateInput {
    this.assertNotificationTarget(schedule, deliveryTo);
    return {
      name: schedule.name,
      agentId: schedule.botId,
      enabled: schedule.enabled,
      cron: schedule.cron,
      timezone: schedule.timezone,
      prompt: schedule.prompt,
      channelType: schedule.channelType,
      channelId: schedule.channelId,
      deliveryTo,
      scheduleId: schedule.id,
      modelId: schedule.modelId,
      onlyNotifyOnChange: schedule.onlyNotifyOnChange,
      failureAlertEnabled: schedule.failureAlertEnabled,
      failureAlertAfter: schedule.failureAlertAfter,
    };
  }

  private assertNotificationTarget(
    schedule: Pick<
      ScheduleResponse,
      "channelType" | "onlyNotifyOnChange" | "failureAlertEnabled"
    >,
    deliveryTo?: string,
  ): void {
    if (
      (schedule.onlyNotifyOnChange || schedule.failureAlertEnabled) &&
      (!schedule.channelType?.trim() || !deliveryTo?.trim())
    ) {
      throw new HTTPException(400, {
        message:
          "Change and failure notifications require an active channel conversation.",
      });
    }
  }

  /**
   * Resolve the announce delivery target for a channel automation by picking
   * the most-recently-active real conversation on that bot+channel and
   * extracting its peer from the session key. This lets UI automations push
   * to "the latest conversation" without the user pasting a raw chatId.
   * Returns undefined when no eligible session exists (or channelType unset).
   */
  private async resolveLatestChannelTarget(
    botId: string,
    channelType?: string,
    channelId?: string,
  ): Promise<string | undefined> {
    if (!channelType) return undefined;
    // Session channelType is inconsistent across channels: Feishu sessions use
    // the channel-type name ("feishu") while WeChat sessions use the plugin id
    // ("openclaw-weixin") even though the schedule/channels API says "wechat".
    // Match against both the raw type and its OpenClaw plugin key.
    const openclawKey = resolveOpenClawChannelKey(channelType as ChannelType);
    const channelMatches = (sct?: string | null): boolean =>
      sct === channelType || sct === openclawKey;
    let target: string | undefined;
    try {
      const sessions = await this.sessionsRuntime.listSessions();
      const candidates = sessions
        .filter((s) => s.botId === botId && channelMatches(s.channelType))
        .map((s) => ({
          to: deliveryTargetFromSessionKey(s.sessionKey ?? ""),
          at: s.lastMessageAt ? Date.parse(s.lastMessageAt) : 0,
          accountRank:
            !channelId || s.channelId === channelId ? 1 : s.channelId ? -1 : 0,
        }))
        .filter(
          (candidate): candidate is typeof candidate & { to: string } =>
            candidate.to !== null && candidate.accountRank >= 0,
        )
        .sort(
          (left, right) =>
            right.accountRank - left.accountRank || right.at - left.at,
        );
      target = candidates[0]?.to;
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "schedule_resolve_delivery_target_failed",
      );
    }
    // WeChat: OpenClaw lowercases the session id, but the outbound contextToken
    // is keyed by the original-case @im.wechat id. Recover the correct case so
    // the token lookup hits (otherwise the push is silently dropped).
    if (target?.endsWith("@im.wechat") && channelId) {
      target = await this.cronGateway.resolveWechatDeliveryTarget(
        channelId,
        target,
      );
    }
    if (!target) {
      logger.warn(
        { botId, channelType },
        "schedule_no_channel_session_for_delivery_target",
      );
    }
    return target;
  }

  private async registerPendingSchedules(): Promise<void> {
    const config = await this.configStore.getConfig();
    const schedules = config.schedules ?? [];

    for (const s of schedules) {
      if (s.externalId || !s.enabled) continue;
      try {
        const deliveryTo = await this.resolveLatestChannelTarget(
          s.botId,
          s.channelType,
          s.channelId,
        );
        const externalId = await this.cronGateway.createJob(
          this.buildCronJobInput(s, deliveryTo),
        );
        await this.configStore.setScheduleExternalId(s.id, externalId);
      } catch (err) {
        logger.warn(
          {
            scheduleId: s.id,
            error: err instanceof Error ? err.message : String(err),
          },
          "schedule_bootstrap_register_failed",
        );
      }
    }
  }

  private async ensurePendingSchedulesRegistered(): Promise<void> {
    if (this.registration) {
      await this.registration;
      return;
    }

    const work = this.registerPendingSchedules();
    this.registration = work;
    try {
      await work;
    } finally {
      if (this.registration === work) {
        this.registration = null;
      }
    }
  }

  async bootstrap(): Promise<void> {
    this.hasBootstrapped = true;
    await this.ensurePendingSchedulesRegistered();
    await this.reconcileChangedOutputs();
  }

  async handleGatewayConnected(): Promise<void> {
    if (!this.hasBootstrapped) return;
    const activeRegistration = this.registration;
    if (activeRegistration) {
      await activeRegistration;
    }
    await this.ensurePendingSchedulesRegistered();
    await this.reconcileChangedOutputs();
  }

  async reconcileChangedOutputs(): Promise<void> {
    if (this.reconciliation) {
      await this.reconciliation;
      return;
    }

    const work = this.performChangedOutputReconciliation();
    this.reconciliation = work;
    try {
      await work;
    } finally {
      if (this.reconciliation === work) {
        this.reconciliation = null;
      }
    }
  }

  private async performChangedOutputReconciliation(): Promise<void> {
    const config = await this.configStore.getConfig();
    const schedules = (config.schedules ?? []).filter(
      (schedule) => schedule.onlyNotifyOnChange && schedule.externalId,
    );

    for (const schedule of schedules) {
      try {
        const events = await this.findMissedSuccessfulRuns(schedule);
        for (const event of events) {
          await this.queueCronEvent(event);
        }
      } catch (error) {
        logger.warn(
          {
            scheduleId: schedule.id,
            jobId: schedule.externalId,
            error: error instanceof Error ? error.message : String(error),
          },
          "schedule_changed_output_reconciliation_failed",
        );
      }
    }
  }

  private async findMissedSuccessfulRuns(
    schedule: ScheduleResponse,
  ): Promise<CronEvent[]> {
    if (!schedule.externalId) return [];

    const observedAtMs = schedule.lastOutputObservedAt
      ? Date.parse(schedule.lastOutputObservedAt)
      : Number.NaN;
    const hasObservedCursor = Number.isFinite(observedAtMs);
    const retryFailedCursor =
      hasObservedCursor && schedule.lastOutputNotificationStatus === "failed";
    const events = new Map<string, CronEvent>();
    let offset = 0;

    for (let page = 0; page < RECONCILE_RUN_MAX_PAGES; page += 1) {
      const result = await this.cronGateway.getRuns(schedule.externalId, {
        limit: RECONCILE_RUN_PAGE_SIZE,
        offset,
      });

      for (const entry of result.entries) {
        const runAtMs = entry.runAtMs ?? entry.ts;
        if (
          entry.status !== "ok" ||
          !entry.summary?.trim() ||
          !Number.isFinite(runAtMs)
        ) {
          continue;
        }
        if (
          hasObservedCursor &&
          (runAtMs < observedAtMs ||
            (runAtMs === observedAtMs && !retryFailedCursor))
        ) {
          continue;
        }

        const normalizedSummary = entry.summary.trim().replaceAll("\r\n", "\n");
        events.set(`${runAtMs}:${normalizedSummary}`, {
          action: "finished",
          jobId: schedule.externalId,
          status: "ok",
          summary: normalizedSummary,
          runAtMs,
          ...(entry.durationMs === undefined
            ? {}
            : { durationMs: entry.durationMs }),
          ...(entry.nextRunAtMs === undefined
            ? {}
            : { nextRunAtMs: entry.nextRunAtMs }),
        });
      }

      if (!hasObservedCursor || !result.hasMore) break;
      const nextOffset = result.nextOffset ?? offset + result.entries.length;
      if (nextOffset <= offset) break;
      offset = nextOffset;
    }

    const ordered = [...events.values()].sort(
      (left, right) => (left.runAtMs ?? 0) - (right.runAtMs ?? 0),
    );
    return hasObservedCursor ? ordered : ordered.slice(-1);
  }

  async listSchedules(): Promise<ScheduleResponse[]> {
    const config = await this.configStore.getConfig();
    const uiSchedules: ScheduleResponse[] = config.schedules ?? [];
    const jobs = await this.cronGateway.listJobs();
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const hydratedUiSchedules = uiSchedules.map((schedule) => {
      const job = schedule.externalId
        ? jobsById.get(schedule.externalId)
        : undefined;
      return job
        ? mergeCronJobRuntimeState(schedule, job)
        : { ...schedule, enabled: false };
    });
    const uiIds = new Set(hydratedUiSchedules.map((s) => s.id));
    const uiDedupKeys = new Set(hydratedUiSchedules.map(buildDedupKey));

    const activeBotIds = new Set(
      config.bots.filter((bot) => bot.status === "active").map((bot) => bot.id),
    );
    const agentSchedules: ScheduleResponse[] = [];

    for (const job of jobs) {
      if (!job.agentId || !activeBotIds.has(job.agentId)) continue;
      const item = mapCronJobToScheduleItem(job);
      if (!item) continue;

      // Primary dedup: nexuScheduleId in description
      if (item.description) {
        const match = item.description.match(/nexuScheduleId:(\S+)/);
        const scheduleId = match?.[1];
        if (scheduleId && uiIds.has(scheduleId)) continue;
      }

      // Fallback dedup: same botId + name + cron
      if (uiDedupKeys.has(buildDedupKey(item))) continue;

      agentSchedules.push(item);
    }

    return [...hydratedUiSchedules, ...agentSchedules];
  }

  async createSchedule(input: CreateScheduleInput): Promise<ScheduleResponse> {
    const deliveryTo = await this.resolveLatestChannelTarget(
      input.botId,
      input.channelType,
      input.channelId,
    );
    this.assertNotificationTarget(
      {
        channelType: input.channelType,
        onlyNotifyOnChange: input.onlyNotifyOnChange ?? false,
        failureAlertEnabled: input.failureAlertEnabled ?? false,
      },
      deliveryTo,
    );
    const schedule = await this.configStore.createSchedule(input);

    // Register directly with OpenClaw so the cron job runs immediately
    // without waiting for the agent to process SCHEDULE.md.
    let externalId: string | undefined;
    try {
      externalId = await this.cronGateway.createJob(
        this.buildCronJobInput(schedule, deliveryTo),
      );
      // Store the externalId for future updates/deletes
      await this.configStore.setScheduleExternalId(schedule.id, externalId);
    } catch (err) {
      if (externalId) {
        await this.cronGateway.removeJob(externalId).catch(() => {});
      }
      if (schedule.onlyNotifyOnChange || schedule.failureAlertEnabled) {
        await this.configStore.deleteSchedule(schedule.id);
        throw new HTTPException(502, {
          message: "OpenClaw could not register the notification schedule.",
          cause: err,
        });
      }
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "schedule_cron_register_failed_job_will_be_registered_on_sync",
      );
    }

    this.syncService.syncAll().catch(() => {});
    return schedule;
  }

  async updateSchedule(
    id: string,
    input: UpdateScheduleInput,
  ): Promise<ScheduleResponse | null> {
    // Resolve the schedule to determine source
    const existing = await this.findSchedule(id);
    if (!existing) return null;

    if (
      existing.source === "agent" &&
      (input.onlyNotifyOnChange !== undefined ||
        input.failureAlertEnabled !== undefined ||
        input.failureAlertAfter !== undefined)
    ) {
      throw new HTTPException(400, {
        message: "Agent-created notification settings are managed by OpenClaw.",
      });
    }

    const notificationConfig = {
      channelType: input.channelType ?? existing.channelType,
      onlyNotifyOnChange:
        input.onlyNotifyOnChange ?? existing.onlyNotifyOnChange,
      failureAlertEnabled:
        input.failureAlertEnabled ?? existing.failureAlertEnabled,
    };
    const notificationPolicyChanged =
      input.onlyNotifyOnChange !== undefined ||
      input.failureAlertEnabled !== undefined ||
      input.failureAlertAfter !== undefined;
    const notificationDeliveryTo =
      notificationConfig.onlyNotifyOnChange ||
      notificationConfig.failureAlertEnabled
        ? await this.resolveLatestChannelTarget(
            existing.botId,
            notificationConfig.channelType,
            input.channelId ?? existing.channelId,
          )
        : undefined;
    this.assertNotificationTarget(notificationConfig, notificationDeliveryTo);

    if (existing.source === "agent" && existing.externalId) {
      // Agent-created: patch the OpenClaw job in place (cron.update). Delivery
      // stays agent-managed — only nexu-editable fields are patched.
      const merged = {
        ...existing,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.cron !== undefined ? { cron: input.cron } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.modelId !== undefined
          ? { modelId: input.modelId || undefined }
          : {}),
      };
      const patchesPayload =
        input.prompt !== undefined || input.modelId !== undefined;
      // Preserve the job's payload kind — agent jobs may be systemEvent.
      let payloadPatch:
        | { kind: "systemEvent"; text: string }
        | { kind: "agentTurn"; message: string; model: string | null }
        | undefined;
      if (patchesPayload) {
        const jobs = await this.cronGateway.listJobs();
        const job = jobs.find((entry) => entry.id === existing.externalId);
        payloadPatch =
          job?.payload.kind === "systemEvent"
            ? { kind: "systemEvent", text: merged.prompt }
            : {
                kind: "agentTurn",
                message: merged.prompt,
                model: merged.modelId?.trim() ? merged.modelId : null,
              };
      }
      await this.cronGateway.updateJob(existing.externalId, {
        ...(input.name !== undefined ? { name: merged.name } : {}),
        ...(input.enabled !== undefined ? { enabled: merged.enabled } : {}),
        ...(input.cron !== undefined || input.timezone !== undefined
          ? {
              schedule: {
                kind: "cron" as const,
                expr: merged.cron,
                tz: merged.timezone,
              },
            }
          : {}),
        ...(payloadPatch ? { payload: payloadPatch } : {}),
      });
      return { ...merged, updatedAt: new Date().toISOString() };
    }

    // UI-created: update config store, then patch the cron job in place.
    const updated = await this.configStore.updateSchedule(id, input);
    if (updated) {
      try {
        const deliveryTo =
          notificationDeliveryTo ??
          (await this.resolveLatestChannelTarget(
            updated.botId,
            updated.channelType,
            updated.channelId,
          ));
        const jobInput = this.buildCronJobInput(updated, deliveryTo);
        if (updated.externalId && existing.botId === updated.botId) {
          // In-place edit (OpenClaw >=2026.7.1): keeps job id + run history.
          await this.cronGateway.updateJobFromSchedule(
            updated.externalId,
            jobInput,
          );
        } else {
          // No job yet, or the bot changed (agentId is part of the job's
          // session identity) → recreate.
          if (updated.externalId) {
            try {
              await this.cronGateway.removeJob(updated.externalId);
            } catch {
              // Non-fatal: old job may already be gone
            }
          }
          const externalId = await this.cronGateway.createJob(jobInput);
          await this.configStore.setScheduleExternalId(updated.id, externalId);
        }
      } catch (err) {
        if (notificationPolicyChanged) {
          await this.configStore.updateSchedule(id, {
            name: existing.name,
            cron: existing.cron,
            timezone: existing.timezone,
            prompt: existing.prompt,
            enabled: existing.enabled,
            source: existing.source,
            sessionKey: existing.sessionKey ?? "",
            channelType: existing.channelType ?? "",
            channelId: existing.channelId ?? "",
            description: existing.description ?? "",
            modelId: existing.modelId ?? "",
            onlyNotifyOnChange: existing.onlyNotifyOnChange,
            failureAlertEnabled: existing.failureAlertEnabled,
            failureAlertAfter: existing.failureAlertAfter,
          });
          if (
            existing.lastOutputFingerprint &&
            existing.lastOutputObservedAt &&
            existing.lastOutputNotificationStatus
          ) {
            await this.configStore.recordScheduleOutputNotification(id, {
              fingerprint: existing.lastOutputFingerprint,
              observedAt: existing.lastOutputObservedAt,
              status: existing.lastOutputNotificationStatus,
              ...(existing.lastOutputNotificationError
                ? { error: existing.lastOutputNotificationError }
                : {}),
            });
          }
          throw new HTTPException(502, {
            message: "OpenClaw could not apply the notification settings.",
            cause: err,
          });
        }
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "schedule_cron_update_failed",
        );
      }
      this.syncService.syncAll().catch(() => {});
    }
    return updated;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const existing = await this.findSchedule(id);

    if (existing?.source === "agent" && existing.externalId) {
      try {
        await this.cronGateway.removeJob(existing.externalId);
        return true;
      } catch {
        return false;
      }
    }

    // UI-created: delete from config and remove cron job
    const success = await this.configStore.deleteSchedule(id);
    if (success) {
      if (existing?.externalId) {
        try {
          await this.cronGateway.removeJob(existing.externalId);
        } catch {
          // Non-fatal: gateway may be disconnected
        }
      }
      this.syncService.syncAll().catch(() => {});
    }
    if (success) {
      this.syncService.syncAll().catch(() => {});
    }
    return success;
  }

  async listRuns(
    scheduleId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{
    entries: import("./openclaw-cron-gateway.js").CronRunEntry[];
    total: number;
    hasMore: boolean;
  } | null> {
    const schedule = await this.findSchedule(scheduleId);
    if (!schedule?.externalId) return null;
    const result = await this.cronGateway.getRuns(schedule.externalId, opts);
    return {
      entries: result.entries,
      total: result.total,
      hasMore: result.hasMore,
    };
  }

  /**
   * Full conversation transcript for one automation run.
   *
   * OpenClaw >=2026.7 isolated cron runs write per-run transcripts keyed
   * `agent:<botId>:cron:<jobId>:run:<runUuid>` without a sessions.json entry,
   * so they never surface as regular sessions. Returns null when the
   * schedule/job is unknown, the run has no transcript key, or the
   * transcript file is already archived by the 24h cron session reaper.
   */
  async getRunTranscript(
    scheduleId: string,
    runTs: number,
    limit?: number,
  ): Promise<{
    messages: import("./../runtime/sessions-runtime.js").ChatMessage[];
    sessionKey: string;
  } | null> {
    const schedule = await this.findSchedule(scheduleId);
    if (!schedule?.externalId) return null;
    const result = await this.cronGateway.getRuns(schedule.externalId, {
      limit: RECONCILE_RUN_PAGE_SIZE,
      offset: 0,
    });
    const entry = result.entries.find((candidate) => candidate.ts === runTs);
    const sessionKey = entry?.sessionKey;
    if (!sessionKey) return null;
    const match = /^agent:([^:]+):cron:[^:]+:run:([^:]+)$/.exec(sessionKey);
    const runSessionId = match?.[2];
    if (!runSessionId || match[1] !== schedule.botId) return null;
    const messages = await this.sessionsRuntime.getRunTranscriptMessages(
      schedule.botId,
      runSessionId,
      limit,
      sessionKey,
    );
    if (messages === null) return null;
    return { messages, sessionKey };
  }

  private async findSchedule(id: string): Promise<ScheduleResponse | null> {
    // Check NexuConfig first
    const config = await this.configStore.getConfig();
    const uiMatch = (config.schedules ?? []).find((s) => s.id === id);
    if (uiMatch) return uiMatch;

    // Check agent schedules
    const allSchedules = await this.listSchedules();
    return allSchedules.find((s) => s.id === id) ?? null;
  }
}
