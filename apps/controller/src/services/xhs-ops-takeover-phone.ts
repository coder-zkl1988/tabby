import path from "node:path";
import {
  type DeviceExecuteTaskBody,
  type DeviceInfo,
  type TaskResult,
  xhsOpsDevicePolicyModeIssue,
} from "@nexu/shared";
import { logger } from "../lib/logger.js";
import {
  DeviceControlRpcError,
  type DeviceControlService,
  DeviceControlTimeoutError,
  dispatchRejectionReason,
} from "./device-control-service.js";

// Phone-task plumbing of the takeover change orders (§3.1 表二, §5.2): one
// dispatch whose outcome says whether the task provably never reached the
// phone, finished, or was lost while the phone may still be working, and a
// stop by the task's own id that only counts once the phone confirmed it.
// The audit service keeps its own private copy of the dispatch rules; the
// policy-mode checks below (§5.2 前提) are shared by every takeover dispatch
// site — the run service, the audit service and the change orders.

export type XhsOpsTakeoverPhoneControl = Pick<
  DeviceControlService,
  "getDevice" | "executeTask"
> &
  Partial<Pick<DeviceControlService, "cancelTask" | "getTaskResults">>;

/** Recorded in a device hold when the phone never named its task. */
export const XHS_TAKEOVER_UNKNOWN_TASK_ID = "unknown";

const POLICY_BLOCKED = "POLICY_ACTION_NOT_ALLOWED";

/** A takeover task the phone ran in a policy mode other than enforce (§5.2 前提). */
export interface XhsOpsTakeoverPolicyBreach {
  mode: "off" | "audit";
  /** The phone task it was seen on; null when the device named none. */
  taskId: string | null;
  /** The task is known to have ended: its stop was confirmed, or the call came back terminal. */
  stopped: boolean;
  /** Fixed text for the step's record and the pause; nothing of the account. */
  reason: string;
}

export type XhsOpsTakeoverPhoneOutcome =
  | { kind: "result"; result: TaskResult }
  /** The dispatch provably never reached the phone. */
  | { kind: "rejected"; reason: string }
  /** The answer was lost (timeout, transport): the phone may still be working. */
  | { kind: "lost"; taskId: string | null; timedOut: boolean }
  /**
   * The phone reported a policy mode other than enforce for this task and
   * the task was stopped by id at once; `result` is what the call returned,
   * null when its answer was lost.
   */
  | {
      kind: "policy";
      breach: XhsOpsTakeoverPolicyBreach;
      result: TaskResult | null;
    };

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "TIMEOUT: task <id> made no progress…", "NO_FIRST_STEP: device … accepted task <id> …". */
export function taskIdFromError(error: unknown): string | null {
  const match = /\btask\s+([^\s,;:]+)/.exec(describeError(error));
  return match?.[1] ?? null;
}

/** The phone ended the task on an action its policy does not allow. */
export function policyBlocked(result: TaskResult): boolean {
  return (
    result.errorCode === POLICY_BLOCKED ||
    (!result.success && (result.message ?? "").includes(POLICY_BLOCKED))
  );
}

export function takeoverScreenshotUrl(
  file: string | null | undefined,
): string | null {
  const trimmed = file?.trim();
  return trimmed ? `/api/v1/media/screenshots/${path.basename(trimmed)}` : null;
}

/**
 * Dispatch one task. tabby-control only names a task when it ends, so with
 * `onTaskId` the device is asked for its current task while the call is
 * pending — under the exclusive lock, on a phone checked idle, that is ours —
 * and the id is persisted before the result is in. Every task sent this way
 * is a takeover task, so the first-progress policy check runs alongside
 * (watchTakeoverPolicyMode): a mode other than enforce stops the task at once
 * and the outcome is "policy"; `onPolicyBreach` records the pause.
 */
export async function runTakeoverPhoneTask(
  control: XhsOpsTakeoverPhoneControl,
  input: {
    deviceId: string;
    body: DeviceExecuteTaskBody;
    pollIntervalMs?: number;
    onTaskId?: (taskId: string) => Promise<void>;
    onPolicyBreach?: (breach: XhsOpsTakeoverPolicyBreach) => Promise<void>;
  },
): Promise<XhsOpsTakeoverPhoneOutcome> {
  const watch: { settled: boolean; taskId: string | null } = {
    settled: false,
    taskId: null,
  };
  if (input.onTaskId && input.pollIntervalMs !== undefined)
    void watchTaskId(control, input.deviceId, watch, {
      pollIntervalMs: input.pollIntervalMs,
      onTaskId: input.onTaskId,
    });
  const policy = watchTakeoverPolicyMode(control, {
    deviceId: input.deviceId,
    pollIntervalMs: input.pollIntervalMs,
    onBreach: input.onPolicyBreach,
  });
  try {
    const { result } = await control.executeTask(input.deviceId, input.body);
    watch.settled = true;
    const breach = await policy.finish({ kind: "result", result });
    return breach
      ? { kind: "policy", breach, result }
      : { kind: "result", result };
  } catch (error) {
    watch.settled = true;
    const rejected = dispatchRejectionReason(error);
    if (rejected) {
      await policy.finish({ kind: "rejected" });
      return { kind: "rejected", reason: rejected };
    }
    const taskId = watch.taskId ?? taskIdFromError(error);
    const breach = await policy.finish({ kind: "lost", taskId });
    if (breach) return { kind: "policy", breach, result: null };
    return {
      kind: "lost",
      taskId,
      timedOut:
        error instanceof DeviceControlTimeoutError ||
        /^(TIMEOUT|NO_FIRST_STEP)\b/.test(describeError(error)),
    };
  } finally {
    watch.settled = true;
  }
}

// ─── Policy mode (§5.2 前提) ────────────────────────────────────────────────

const unreportedModeLogged = new Set<string>();

/**
 * Why no takeover task may go to this phone now, or null (§5.2 前提). Every
 * takeover dispatch site asks this right before it sends: the run service's
 * identity gate and chunks of existing accounts, the audit service, the
 * change orders. A reported mode other than enforce refuses — the phone's
 * mechanical gates then block nothing. A mode not reported yet (before the
 * phone's first task) is the documented residual: let through, and logged
 * once per device, with nothing of the account.
 */
export function takeoverDispatchRefusal(
  device: Pick<DeviceInfo, "deviceId" | "devicePolicyMode">,
): string | null {
  const issue = xhsOpsDevicePolicyModeIssue(device);
  if (issue) return issue;
  if (
    device.devicePolicyMode === undefined &&
    !unreportedModeLogged.has(device.deviceId)
  ) {
    unreportedModeLogged.add(device.deviceId);
    logger.info(
      { deviceId: device.deviceId },
      "xhs-ops: phone has not reported its policy mode yet; takeover task let through (known residual)",
    );
  }
  return null;
}

export function takeoverPolicyBreachReason(mode: "off" | "audit"): string {
  return `手机端策略模式是 ${mode}，不是 enforce，不会拦截任何越界操作；任务已停止，请换用 enforce 构建的 TabbyApp`;
}

function reportedNonEnforceMode(
  device: DeviceInfo | null | undefined,
): "off" | "audit" | null {
  const mode = device?.devicePolicyMode;
  return mode === "off" || mode === "audit" ? mode : null;
}

/** How a watched dispatch ended, for the last look at the device. */
export type XhsOpsTakeoverCallEnd =
  | { kind: "result"; result: TaskResult }
  | { kind: "lost"; taskId: string | null }
  | { kind: "rejected" };

export interface XhsOpsTakeoverPolicyWatch {
  /**
   * Stop polling once the call settled. A breach seen while it ran is
   * returned; otherwise the device is looked at once more, for a task too
   * short for the poll. null = no breach.
   */
  finish(
    call: XhsOpsTakeoverCallEnd,
  ): Promise<XhsOpsTakeoverPolicyBreach | null>;
}

/**
 * The first-progress check of a takeover dispatch (§5.2 前提, P0 #6). The
 * phone reports its policy mode from TASK_START on and tabby-control keeps
 * it on the device's status, so while the call is pending the device is
 * polled. A dispatch only went out after takeoverDispatchRefusal passed —
 * the last report was enforce or none — and tabby-control only takes a new
 * mode from the progress of the device's active task, so a mode other than
 * enforce seen now is this task's own report: the task is stopped by id at
 * once and `onBreach` runs (the site writes safetyPause manual). A stop that
 * goes unconfirmed is left to the site's own stop-or-hold handling.
 */
export function watchTakeoverPolicyMode(
  control: XhsOpsTakeoverPhoneControl,
  input: {
    deviceId: string;
    /** Absent: no polling, only the look after the call. */
    pollIntervalMs?: number;
    onBreach?: (breach: XhsOpsTakeoverPolicyBreach) => Promise<void> | void;
  },
): XhsOpsTakeoverPolicyWatch {
  const state: {
    settled: boolean;
    breach: XhsOpsTakeoverPolicyBreach | null;
    raising: Promise<void> | null;
  } = { settled: false, breach: null, raising: null };
  const raise = async (
    mode: "off" | "audit",
    taskId: string | null,
    running: boolean,
  ): Promise<void> => {
    const stopped = running
      ? await stopTakeoverPhoneTask(control, input.deviceId, taskId)
      : true;
    const breach: XhsOpsTakeoverPolicyBreach = {
      mode,
      taskId,
      stopped,
      reason: takeoverPolicyBreachReason(mode),
    };
    state.breach = breach;
    logger.warn(
      { deviceId: input.deviceId, taskId, mode, stopped },
      "xhs-ops: phone reported a policy mode other than enforce; takeover task stopped",
    );
    try {
      await input.onBreach?.(breach);
    } catch (error) {
      logger.warn(
        { deviceId: input.deviceId, taskId, error: describeError(error) },
        "xhs-ops: recording a policy-mode breach failed",
      );
    }
  };
  const poll = async (intervalMs: number): Promise<void> => {
    while (!state.settled) {
      await sleep(intervalMs);
      if (state.settled) return;
      let device: DeviceInfo | null;
      try {
        device = await control.getDevice(input.deviceId);
      } catch {
        continue;
      }
      // finish() looks at the device itself once the call settled.
      if (state.settled) return;
      const mode = reportedNonEnforceMode(device);
      if (!mode) continue;
      const taskId =
        device?.status === "busy" ? (device.currentTaskId ?? null) : null;
      state.raising = raise(mode, taskId, true);
      return;
    }
  };
  if (input.pollIntervalMs !== undefined) void poll(input.pollIntervalMs);
  return {
    async finish(call) {
      state.settled = true;
      if (state.raising) await state.raising;
      if (state.breach) {
        // The call came back terminal: whatever the stop said, it ended.
        if (
          call.kind === "result" &&
          !call.result.needsInteraction &&
          !state.breach.stopped
        )
          state.breach = { ...state.breach, stopped: true };
        return state.breach;
      }
      if (call.kind === "rejected") return null;
      let device: DeviceInfo | null;
      try {
        device = await control.getDevice(input.deviceId);
      } catch {
        return null;
      }
      const mode = reportedNonEnforceMode(device);
      if (!mode) return null;
      // A CALL_USER answer or a lost one may leave the task running. A lost
      // call often names no task; the busy device's current task is then
      // ours (the dispatch holds the device), so the stop still has an id.
      const running =
        call.kind === "lost" || call.result.needsInteraction === true;
      const taskId =
        (call.kind === "result" ? call.result.taskId : call.taskId) ??
        (device?.status === "busy" ? (device.currentTaskId ?? null) : null);
      await raise(mode, taskId, running);
      return state.breach;
    },
  };
}

async function watchTaskId(
  control: XhsOpsTakeoverPhoneControl,
  deviceId: string,
  watch: { settled: boolean; taskId: string | null },
  options: {
    pollIntervalMs: number;
    onTaskId: (taskId: string) => Promise<void>;
  },
): Promise<void> {
  while (!watch.settled && !watch.taskId) {
    await sleep(options.pollIntervalMs);
    if (watch.settled || watch.taskId) return;
    let device: DeviceInfo | null;
    try {
      device = await control.getDevice(deviceId);
    } catch {
      continue;
    }
    const taskId = device?.status === "busy" ? device.currentTaskId : undefined;
    if (!taskId || watch.settled || watch.taskId) continue;
    watch.taskId = taskId;
    try {
      await options.onTaskId(taskId);
    } catch {
      // The id only helps a restart reconcile; losing it is not fatal here.
    }
  }
}

/**
 * Stop an owned task by id (never "current"). Confirmed when the phone
 * acknowledges the cancel, or when tabby-control already holds the task's
 * terminal result — it ended by itself.
 */
export async function stopTakeoverPhoneTask(
  control: XhsOpsTakeoverPhoneControl,
  deviceId: string,
  taskId: string | null,
): Promise<boolean> {
  if (
    !taskId ||
    taskId === "current" ||
    taskId === XHS_TAKEOVER_UNKNOWN_TASK_ID
  )
    return false;
  if (control.cancelTask) {
    try {
      if ((await control.cancelTask(deviceId, { taskId }))?.cancelled === true)
        return true;
    } catch {
      // CANCEL_NOT_CONFIRMED may mean the task had already finished.
    }
  }
  const fetch = control.getTaskResults;
  if (!fetch) return false;
  try {
    const entries = await fetch.call(control, { taskId, deviceId });
    return entries.some(
      (entry) => entry.taskId === taskId && entry.deviceId === deviceId,
    );
  } catch {
    return false;
  }
}

/** null = not connected; "unknown" = the status could not be queried. */
export async function probeTakeoverDevice(
  control: XhsOpsTakeoverPhoneControl,
  deviceId: string,
  input: { now: number; offlineAfterMs: number },
): Promise<DeviceInfo | null | "unknown"> {
  let device: DeviceInfo | null;
  try {
    device = await control.getDevice(deviceId);
  } catch (error) {
    if (
      error instanceof DeviceControlRpcError &&
      error.code === "DEVICE_NOT_FOUND"
    )
      return null;
    return "unknown";
  }
  if (!device || input.now - device.lastSeen > input.offlineAfterMs)
    return null;
  return device;
}
