import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type DeviceExecuteTaskBody,
  XHS_PROFILE_FIELD_LABEL,
  XHS_TAKEOVER_CHANGE_BUDGET,
  XHS_TAKEOVER_CHANGE_ORDER_STATUS_LABEL,
  XHS_TAKEOVER_DEVICE_HOLD_MESSAGE,
  XHS_TAKEOVER_IMAGE_MAX_BYTES,
  XHS_TAKEOVER_IMAGE_UNSUPPORTED_MESSAGE,
  XHS_TAKEOVER_OBSERVATION_HOURS,
  XHS_TAKEOVER_ROLLBACK_SOURCE_STATUSES,
  type XhsOpsAccount,
  type XhsOpsAccountAudit,
  type XhsOpsChangeOrder,
  type XhsOpsChangeOrderAckKey,
  type XhsOpsChangeOrderField,
  type XhsOpsChangeOrderStatus,
  type XhsOpsObservationSignal,
  type XhsOpsRun,
  type XhsOpsSafetyPause,
  type XhsOpsStoreData,
  type XhsOpsTakeover,
  type XhsOpsTakeoverProfileField,
  compareXhsOpsAudits,
  xhsOpsChangeOrderCancelBodySchema,
  xhsOpsChangeOrderChangedFields,
  xhsOpsChangeOrderConfirmBodySchema,
  xhsOpsChangeOrderCreateBodySchema,
  xhsOpsChangeOrderImageBodySchema,
  xhsOpsChangeOrderManualCheckBodySchema,
  xhsOpsChangeOrderMissingAcks,
  xhsOpsChangeOrderPrecheckBodySchema,
  xhsOpsChangeOrderPreviousReviewWarned,
  xhsOpsChangeOrderVerifyBodySchema,
  xhsOpsChangeOrderVisualCheckBodySchema,
  xhsOpsDeviceSupportsTakeoverImages,
  xhsOpsHeaderCountFlags,
  xhsOpsIsTakeoverImageField,
  xhsOpsObservationReviewBodySchema,
  xhsOpsObservationVerdict,
  xhsOpsProfileFieldLabels,
  xhsOpsSameProfileText,
  xhsOpsTakeoverFieldBudgetState,
  xhsOpsTakeoverFirstObservationIssue,
  xhsOpsTakeoverPausedMessage,
} from "@nexu/shared";
import type { z } from "zod";
import { logger } from "../lib/logger.js";
import { XhsOpsError, localDateString } from "../lib/xhs-ops-common.js";
import type { XhsOpsStore } from "../store/xhs-ops-store.js";
import {
  type XhsOpsChangeOrderSeed,
  type XhsOpsTakeoverPauseInput,
  raiseTakeoverPause,
  takeoverExpectedFieldValue,
} from "../store/xhs-ops-takeover-records.js";
import type { XhsOpsAuditService } from "./xhs-ops-audit-service.js";
import {
  XHS_CHANGE_ORDER_PRECHECK_TTL_MS,
  XHS_CHANGE_ORDER_TASK_PENDING,
  closeChangeOrder,
  takeoverProfileField,
  withObservationWindow,
} from "./xhs-ops-change-order-rules.js";
import { takeoverProfileValueIssue } from "./xhs-ops-diagnosis-service.js";
import { buildTakeoverIdentityGateRequest } from "./xhs-ops-preparation.js";
import type { XhsOpsProfileService } from "./xhs-ops-profile-service.js";
import {
  XHS_AUDIT_TASK_POLICY,
  XHS_OPS_DEFAULT_IDLE_POLL_MS,
  XHS_OPS_DEFAULT_IDLE_WAIT_MS,
  XHS_OPS_DEFAULT_OFFLINE_AFTER_MS,
  XHS_PACKAGE,
} from "./xhs-ops-run-service.js";
import {
  XHS_TAKEOVER_UNKNOWN_TASK_ID,
  type XhsOpsTakeoverPhoneControl,
  type XhsOpsTakeoverPhoneOutcome,
  type XhsOpsTakeoverPolicyBreach,
  describeError,
  policyBlocked,
  probeTakeoverDevice,
  runTakeoverPhoneTask,
  stopTakeoverPhoneTask,
  takeoverDispatchRefusal,
  takeoverScreenshotUrl,
} from "./xhs-ops-takeover-phone.js";
import {
  REPORT_AUDIT_CONTRADICTED,
  XHS_TAKEOVER_TASK_LIMITS,
  type XhsOpsTakeoverProfileReadback,
  type XhsOpsTakeoverProfileVerification,
  type XhsOpsTakeoverVerifyField,
  buildTakeoverProfileReadbackTask,
  buildTakeoverProfileVerificationTask,
  parseTakeoverProfileReadbackJson,
  parseTakeoverProfileVerificationJson,
} from "./xhs-ops-task-builder.js";

// 老号接管的公开资料变更单（takeover design §5.2, §6.4, §6.5, §8.1）. One
// order changes at most two public fields: precheck (read-only readback with
// the 号码核对 and the header counts) → human confirmation against the
// precheck digest → apply (the profile service, preparation "none") →
// verification of the changed fields only → human checks → observation →
// review. Each phone step holds the exclusive device lock and follows §3.1
// 表二: a task that may still run is stopped by id, and a stop nobody
// confirmed holds the device. Steps run in the background; the card polls.
// The 小红书号 and field values never reach a log line or an event.

export interface XhsOpsChangeOrderServiceOptions {
  idlePollIntervalMs?: number;
  /** How long the verification after an apply waits for the phone to turn idle. */
  idleWaitTimeoutMs?: number;
  offlineAfterMs?: number;
  /** How often a dispatched task is looked up on the device to learn its id. */
  taskIdPollIntervalMs?: number;
  now?: () => number;
  /** Apply operation ids; the album names carry the first eight characters. */
  genId?: () => string;
}

export interface XhsOpsChangeOrderServiceDeps {
  store: XhsOpsStore;
  deviceControl: XhsOpsTakeoverPhoneControl;
  profile: Pick<XhsOpsProfileService, "applyChangeOrder" | "reconcile">;
  /** The observation review runs an audit with the order's fields in part one (§6.4). */
  audits: Pick<XhsOpsAuditService, "startAudit" | "waitForAudit">;
  /** OpenClaw media root; uploads go to <mediaRoot>/xhs-takeover/<orderId>/. */
  mediaRoot: string;
  options?: XhsOpsChangeOrderServiceOptions;
}

/** Shape of xhsOpsChangeOrderActionResponseSchema. */
export interface XhsOpsChangeOrderActionResult {
  order: XhsOpsChangeOrder;
  account: XhsOpsAccount;
}

/** What the startup reconcile did with one order store.recoverInterruptedTakeoverWork() moved. */
export interface XhsOpsChangeOrderReconcileOutcome {
  orderId: string;
  /**
   * ended — nothing of the order runs on the phone any more;
   * stopped — its task was still running and is now stopped;
   * held — that could not be proved, so the device is held;
   * error — the reconcile and the fallback hold both failed.
   */
  outcome: "ended" | "stopped" | "held" | "error";
  taskId: string | null;
}

type ImageField = "avatar" | "cover";
type OrderField = XhsOpsChangeOrderField;

const TAKEOVER_MEDIA_DIR = "xhs-takeover";
const MAX_NO_NURTURE_DATES = 14;
const MAX_REASON_CHARS = 200;
const MAX_OBSERVATION_NOTE_CHARS = 120;
const MAX_OBSERVATION_NOTES = 6;
const DEFAULT_TASK_ID_POLL_MS = 2_000;
const HOUR_MS = 3_600_000;

const DEVICE_UNAVAILABLE = "手机不在线，请确认手机已连接后重试";
const DEVICE_UNKNOWN = "无法查询手机状态，请稍后重试";
const DEVICE_BUSY = "手机正在执行其他任务，请等它结束后再试";
const STOP_UNCONFIRMED =
  "手机任务停止未确认；请到手机上确认任务已结束，再在接管卡片解除";
const MISMATCH_PAUSE_REASON =
  "手机上当前登录的不是锁定的小红书号，请账号本人在手机上切换回来";
const IMAGE_MISMATCH_REASON = "图片与原图不一致，请立即在手机上手动换回";

const IMAGE_TYPES = {
  png: {
    ext: ".png",
    magic: (bytes: Buffer) => bytes.subarray(0, 8).equals(PNG_MAGIC),
  },
  jpeg: {
    ext: ".jpg",
    magic: (bytes: Buffer) =>
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  webp: {
    ext: ".webp",
    magic: (bytes: Buffer) =>
      bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      bytes.subarray(8, 12).toString("latin1") === "WEBP",
  },
} as const;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const STATUS_LABEL = XHS_TAKEOVER_CHANGE_ORDER_STATUS_LABEL;

const ACK_LABEL: Record<XhsOpsChangeOrderAckKey, string> = {
  photoPermission: "照片权限说明",
  screenshotPrivacy: "截图隐私说明",
  cleanup: "相册清理提醒",
  l2SecondCheck: "昵称或地区的二次确认",
  warnAcknowledged: "上一张单复查为 warn 的额外确认",
};

/** Statuses after which the next order may start (§5.2 step 2). */
const FINISHED_STATUSES: ReadonlySet<XhsOpsChangeOrderStatus> = new Set([
  "draft",
  "completed",
  "failed",
  "cancelled",
]);

const OBSERVATION_SIGNALS: ReadonlySet<string> = new Set([
  "rate_limited",
  "account_restricted",
  "login_required",
]);

function clip(text: string, max = MAX_REASON_CHARS): string {
  return text.length > max ? text.slice(0, max) : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${localDateString(date)} ${hours}:${minutes}`;
}

function bumpUpdatedAt(previous: string, now: string): string {
  return new Date(
    Math.max(Date.parse(now), Date.parse(previous) + 1),
  ).toISOString();
}

function label(field: OrderField["field"]): string {
  return XHS_PROFILE_FIELD_LABEL[field];
}

function labels(fields: readonly OrderField["field"][]): string {
  return xhsOpsProfileFieldLabels(fields);
}

/** The order's fields a takeover may change, in the order's order. */
function orderFields(order: XhsOpsChangeOrder): XhsOpsTakeoverProfileField[] {
  return order.fields.flatMap((entry) => {
    const field = takeoverProfileField(entry.field);
    return field ? [field] : [];
  });
}

function hasImage(order: XhsOpsChangeOrder): boolean {
  return order.fields.some((entry) => xhsOpsIsTakeoverImageField(entry.field));
}

function textValue(
  values: XhsOpsTakeoverProfileReadback["values"],
  field: OrderField["field"],
): string | null {
  switch (field) {
    case "nickname":
    case "bio":
    case "occupation":
    case "region":
      return values[field];
    default:
      return null;
  }
}

function precheckExpired(order: XhsOpsChangeOrder, nowMs: number): boolean {
  return (
    order.status === "awaiting_confirm" &&
    order.precheck !== null &&
    Date.parse(order.precheck.expiresAt) <= nowMs
  );
}

/** A receipt only counts from a finished task, or one the phone's report audit downgraded (§3.4 rule 4). */
function receiptAccepted(result: { success: boolean; errorCode?: string }) {
  return result.success || result.errorCode === REPORT_AUDIT_CONTRADICTED;
}

function requireTakeoverAccount(
  account: XhsOpsAccount | null,
): XhsOpsAccount & { takeover: XhsOpsTakeover } {
  if (!account) throw new XhsOpsError(404, "账号不存在");
  const takeover = account.takeover;
  if (account.entryMode !== "existing" || !takeover?.authorizedAt)
    throw new XhsOpsError(409, "请先在接管卡片上授权接管该账号");
  return { ...account, takeover };
}

/** Planned nurture or comment runs today, and any that started (MT-03: 资料变更当天不养号). */
function nurtureRunToday(
  runs: readonly XhsOpsRun[],
  accountId: string,
  today: string,
): boolean {
  return runs.some(
    (run) =>
      run.accountId === accountId &&
      run.date === today &&
      (run.status === "planned" || run.startedAt !== null),
  );
}

export type XhsOpsChangeOrderBudgetEntry = {
  field: XhsOpsTakeoverProfileField;
  used: number;
  maxChanges: number;
  blockedUntil: string | null;
};

/**
 * Budget of each field of `order` (§8.1) over the orders of the same
 * 小红书号. `optimistic` leaves out uncertain text fields: the readback
 * about to run may prove them unchanged, and only then is the check strict.
 * A rollback is exempt from the self-limit; platform notices still block it.
 */
export function changeOrderBudget(
  order: XhsOpsChangeOrder,
  account: XhsOpsAccount,
  orders: readonly XhsOpsChangeOrder[],
  nowMs: number,
  options: { optimistic?: boolean } = {},
): XhsOpsChangeOrderBudgetEntry[] {
  const ledger = orders
    .filter(
      (entry) =>
        entry.id !== order.id &&
        entry.accountId === account.id &&
        entry.platformAccountId === order.platformAccountId,
    )
    .map((entry) =>
      options.optimistic
        ? {
            ...entry,
            fields: entry.fields.map((field) =>
              field.outcome === "uncertain" &&
              !xhsOpsIsTakeoverImageField(field.field)
                ? { ...field, outcome: "skipped" as const }
                : field,
            ),
          }
        : entry,
    );
  const notices = account.takeover?.platformLimitNotices ?? [];
  return orderFields(order).map((field) => {
    const state = xhsOpsTakeoverFieldBudgetState(
      field,
      { orders: ledger, notices },
      nowMs,
      { rollback: order.rollbackOfId !== null },
    );
    return {
      field,
      used: state.used,
      maxChanges: XHS_TAKEOVER_CHANGE_BUDGET[field].maxChanges,
      blockedUntil: state.blockedUntil,
    };
  });
}

function budgetIssue(
  budget: readonly XhsOpsChangeOrderBudgetEntry[],
): string | null {
  const blocked = budget.find((entry) => entry.blockedUntil !== null);
  if (!blocked?.blockedUntil) return null;
  return `${label(blocked.field)}在 ${formatLocalTime(blocked.blockedUntil)} 之前不能再改（接管自限额度或手机提示的平台限制）`;
}

/**
 * confirmDigest (§5.2 step 2): sha256 over the order's fields — before,
 * after and the uploaded image's sha256 — the 小红书号 and the budget
 * snapshot the confirm dialog shows.
 */
export function changeOrderConfirmDigest(
  order: XhsOpsChangeOrder,
  budget: readonly XhsOpsChangeOrderBudgetEntry[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        orderId: order.id,
        platformAccountId: order.platformAccountId,
        fields: order.fields.map((entry) => ({
          field: entry.field,
          before: entry.before,
          after: entry.after,
          imageSha256: entry.imageSha256,
        })),
        budget,
      }),
    )
    .digest("hex");
}

/**
 * The pauses a rollback runs through (§5.2 step 7): the ones its own original
 * raised to make it — observation_failed, and the manual pause of a picture
 * a human found mismatched. Anything else its original raised — a 号码
 * mismatch, a phone outside enforce mode — blocks the rollback too.
 */
function rollbackExemptPause(
  pause: XhsOpsSafetyPause,
  order: XhsOpsChangeOrder,
): boolean {
  if (order.rollbackOfId === null || pause.sourceRef !== order.rollbackOfId)
    return false;
  return (
    pause.code === "observation_failed" ||
    (pause.code === "manual" && pause.reason === IMAGE_MISMATCH_REASON)
  );
}

/**
 * Why `order` may not start a phone step now, or null (§5.2 step 2, §6.5).
 * A rollback skips "the previous order is finished", the observation window,
 * 「第一个观察期内不改」 and the pauses rollbackExemptPause names. `runs` null
 * skips MT-03, which only the store mutation can see.
 */
function dispatchIssue(input: {
  account: XhsOpsAccount;
  order: XhsOpsChangeOrder;
  orders: readonly XhsOpsChangeOrder[];
  runs: readonly XhsOpsRun[] | null;
  nowMs: number;
}): string | null {
  const { account, order, nowMs } = input;
  const takeover = account.takeover;
  if (account.entryMode !== "existing" || !takeover?.authorizedAt)
    return "请先在接管卡片上授权接管该账号";
  if (
    !takeover.identityConfirmedAt ||
    account.platformAccountId !== order.platformAccountId ||
    account.deviceId !== order.deviceId
  )
    return "小红书号或设备已变化，请先重新锁定身份";
  if (!takeover.baselineAuditId) return "请先完成只读盘点并确认基线";
  const rollback = order.rollbackOfId !== null;
  if (!rollback && !takeover.planConfirmedAt) return "请先确认接管方案";
  if (order.fields.some((entry) => !takeoverProfileField(entry.field)))
    return "变更单含有接管不修改的字段";
  const missingImage = order.fields.find(
    (entry) =>
      xhsOpsIsTakeoverImageField(entry.field) &&
      (!entry.imagePath || !entry.imageSha256),
  );
  if (missingImage) return `请先上传${label(missingImage.field)}的图片`;
  if (account.profileDraft.applyOperation?.status === "running")
    return "资料应用任务仍在执行";
  if (takeover.deviceHold) return XHS_TAKEOVER_DEVICE_HOLD_MESSAGE;
  const pause = takeover.safetyPause;
  if (pause && !rollbackExemptPause(pause, order))
    return xhsOpsTakeoverPausedMessage(pause.reason);
  if (!rollback) {
    // Orders of a 小红书号 no longer locked cannot be finished here and
    // never block the current one's.
    const open = input.orders.find(
      (entry) =>
        entry.id !== order.id &&
        entry.accountId === account.id &&
        entry.platformAccountId === order.platformAccountId &&
        !FINISHED_STATUSES.has(entry.status) &&
        !precheckExpired(entry, nowMs),
    );
    if (open)
      return open.status === "observing"
        ? "上一张变更单还在观察期，请先复查"
        : `上一张变更单还没结束（${STATUS_LABEL[open.status]}），请先处理完`;
    if (
      takeover.observationUntil &&
      Date.parse(takeover.observationUntil) > nowMs
    )
      return `观察期到 ${formatLocalTime(takeover.observationUntil)} 结束，期间不能开下一张公开变更单`;
    const firstObservation = xhsOpsTakeoverFirstObservationIssue(
      order,
      input.orders,
    );
    if (firstObservation) return firstObservation;
  }
  if (
    input.runs &&
    nurtureRunToday(input.runs, account.id, localDateString(new Date(nowMs)))
  )
    return "今天已经有养号或评论任务（已开始、已完成或计划中），按规则资料变更改到明天";
  return null;
}

/**
 * Why an interrupted order may not be verified now, or null (状态表
 * interrupted → verifying): the identity it was confirmed for is locked
 * again, nothing holds the device and no apply ledger is still unsettled.
 * The observation window and MT-03 do not apply: verify changes nothing.
 */
function verifyIssue(
  account: XhsOpsAccount,
  order: XhsOpsChangeOrder,
): string | null {
  const takeover = account.takeover;
  if (!takeover?.authorizedAt) return "请先在接管卡片上授权接管该账号";
  if (
    !takeover.identityConfirmedAt ||
    account.platformAccountId !== order.platformAccountId ||
    account.deviceId !== order.deviceId
  )
    return "小红书号或设备已变化，请先重新锁定身份后再补跑核验";
  if (takeover.deviceHold) return XHS_TAKEOVER_DEVICE_HOLD_MESSAGE;
  if (account.profileDraft.applyOperation?.status === "running")
    return "手机上的修改任务结果还没确认，请等手机空闲后再补跑核验";
  return null;
}

/**
 * Uncertain text fields of earlier orders that this readback settles (§8.1):
 * the phone shows the order's after — it went public, done — or its before —
 * unchanged, skipped and out of the budget. Anything else stays uncertain.
 */
function settleUncertainFields(
  orders: readonly XhsOpsChangeOrder[],
  self: XhsOpsChangeOrder,
  values: XhsOpsTakeoverProfileReadback["values"],
): XhsOpsChangeOrder[] {
  const changed: XhsOpsChangeOrder[] = [];
  for (const order of orders) {
    if (
      order.id === self.id ||
      order.accountId !== self.accountId ||
      order.platformAccountId !== self.platformAccountId
    )
      continue;
    let touched = false;
    const fields = order.fields.map((entry): OrderField => {
      const current = textValue(values, entry.field);
      if (entry.outcome !== "uncertain" || current === null) return entry;
      if (xhsOpsSameProfileText(current, entry.after)) {
        touched = true;
        return {
          ...entry,
          outcome: "done",
          note: clip("后续预检回读显示已是目标值"),
        };
      }
      if (xhsOpsSameProfileText(current, entry.before)) {
        touched = true;
        return {
          ...entry,
          outcome: "skipped",
          note: clip("后续预检回读证明没有改动"),
        };
      }
      return entry;
    });
    if (touched) changed.push({ ...order, fields });
  }
  return changed;
}

/** Latest completed audit of the 小红书号 before the order was confirmed: the review baseline (§6.4). */
function observationBaseAudit(
  audits: readonly XhsOpsAccountAudit[],
  order: XhsOpsChangeOrder,
): XhsOpsAccountAudit | null {
  const before = order.confirmedAt ?? order.createdAt;
  return (
    audits
      .filter(
        (audit) =>
          audit.accountId === order.accountId &&
          audit.platformAccountId === order.platformAccountId &&
          audit.status === "completed" &&
          (audit.completedAt ?? audit.startedAt) < before,
      )
      .sort((left, right) =>
        (right.completedAt ?? right.startedAt).localeCompare(
          left.completedAt ?? left.startedAt,
        ),
      )[0] ?? null
  );
}

/** Risk signals any run, audit or pause of the account raised since `since` (§6.4 fail). */
function observationSignals(input: {
  account: XhsOpsAccount;
  runs: readonly XhsOpsRun[];
  audits: readonly XhsOpsAccountAudit[];
  since: string;
}): XhsOpsObservationSignal[] {
  const sinceMs = Date.parse(input.since);
  const signals = new Set<XhsOpsObservationSignal>();
  const add = (code: string | null | undefined, at: string | null) => {
    const atMs = at ? Date.parse(at) : Number.NaN;
    if (!code || !Number.isFinite(atMs) || atMs < sinceMs) return;
    const mapped =
      code === "not_logged_in" || code === "phone_required"
        ? "login_required"
        : code;
    if (
      mapped === "rate_limited" ||
      mapped === "account_restricted" ||
      mapped === "login_required"
    )
      signals.add(mapped);
  };
  const pause = input.account.takeover?.safetyPause;
  if (pause && OBSERVATION_SIGNALS.has(pause.code))
    add(pause.code, pause.since);
  for (const run of input.runs) {
    if (run.accountId !== input.account.id) continue;
    if (run.preparation)
      add(
        run.preparation.reasonCode,
        run.preparation.completedAt ?? run.preparation.startedAt,
      );
    for (const chunk of run.chunks)
      for (const anomaly of chunk.anomalies)
        add(anomaly.type, chunk.completedAt ?? run.updatedAt);
  }
  for (const audit of input.audits) {
    if (audit.accountId !== input.account.id) continue;
    for (const part of [audit.profile, audit.home, audit.creator])
      add(part?.code, audit.completedAt ?? audit.updatedAt);
  }
  return [...signals];
}

/** A step's result: the account, the order and any other order it settled on the way. */
type XhsOpsOrderStep = {
  account: XhsOpsAccount;
  order: XhsOpsChangeOrder;
  /** The original a rollback's observation closed (closeRolledBackOriginal). */
  closed: XhsOpsChangeOrder[];
};

/** The records an order step reads besides the order itself. */
type XhsOpsOrderRecords = {
  audits: readonly XhsOpsAccountAudit[];
  changeOrders: readonly XhsOpsChangeOrder[];
};

const ROLLED_BACK_NOTE = "已回滚";

/**
 * A rollback that verified undid what its original changed (§5.2 step 7):
 * an original still observing would only read its before back at review and
 * fail. It is closed instead — failed with 「已回滚」, its observation over,
 * no pause raised; the rollback's own window and review take over.
 */
function closeRolledBackOriginal(
  orders: readonly XhsOpsChangeOrder[],
  rollback: XhsOpsChangeOrder,
): XhsOpsChangeOrder[] {
  if (rollback.rollbackOfId === null) return [];
  const original = orders.find((entry) => entry.id === rollback.rollbackOfId);
  if (
    !original?.observation ||
    original.status !== "observing" ||
    original.accountId !== rollback.accountId ||
    original.platformAccountId !== rollback.platformAccountId
  )
    return [];
  return [
    {
      ...original,
      status: "failed",
      error: ROLLED_BACK_NOTE,
      observation: {
        ...original.observation,
        notes: [
          clip(
            `${ROLLED_BACK_NOTE}：回滚单已核验，本单观察期结束，改由回滚单观察`,
            MAX_OBSERVATION_NOTE_CHARS,
          ),
        ],
      },
    },
  ];
}

/**
 * Enter observation (§5.2 step 6): the order's risk sets observationUntil —
 * L1 72 hours, L2 7 days — activeChangeOrderId lets go, and the review
 * baseline is fixed now. A rollback closes its still-observing original.
 */
function beginObservation(
  account: XhsOpsAccount & { takeover: XhsOpsTakeover },
  order: XhsOpsChangeOrder,
  records: XhsOpsOrderRecords,
  now: string,
): XhsOpsOrderStep {
  const takeover = withObservationWindow(account.takeover, order.risk, now);
  const until = new Date(
    Date.parse(now) + XHS_TAKEOVER_OBSERVATION_HOURS[order.risk] * HOUR_MS,
  ).toISOString();
  return {
    account: {
      ...account,
      takeover: {
        ...takeover,
        activeChangeOrderId:
          takeover.activeChangeOrderId === order.id
            ? null
            : takeover.activeChangeOrderId,
      },
    },
    order: {
      ...order,
      status: "observing",
      error: null,
      observation: {
        until,
        auditId: null,
        baseAuditId: observationBaseAudit(records.audits, order)?.id ?? null,
        visualChecks: {},
        verdict: "pending",
        notes: [],
      },
    },
    closed: closeRolledBackOriginal(records.changeOrders, order),
  };
}

/**
 * Where a verified order goes next (§5.2 状态表): an image field nobody
 * compared yet → awaiting_visual_check; a header count that moved and was
 * not checked → awaiting_manual_check; otherwise observing.
 */
function afterHumanChecks(
  account: XhsOpsAccount & { takeover: XhsOpsTakeover },
  order: XhsOpsChangeOrder,
  records: XhsOpsOrderRecords,
  now: string,
): XhsOpsOrderStep {
  if (
    order.fields.some(
      (entry) =>
        xhsOpsIsTakeoverImageField(entry.field) && entry.outcome === "done",
    )
  )
    return {
      account,
      order: { ...order, status: "awaiting_visual_check" },
      closed: [],
    };
  if (
    !order.manualCheckAt &&
    order.flags.some(
      (flag) => flag === "countsChanged" || flag === "possibleSelfLike",
    )
  )
    return {
      account,
      order: { ...order, status: "awaiting_manual_check" },
      closed: [],
    };
  return beginObservation(account, order, records, now);
}

/** Raise a pause (§6.5); an observation failure a stronger pause masks waits for that pause's 「恢复」. */
function withPause(
  account: XhsOpsAccount & { takeover: XhsOpsTakeover },
  input: XhsOpsTakeoverPauseInput,
  now: string,
): XhsOpsAccount {
  return {
    ...account,
    takeover: raiseTakeoverPause(account.takeover, input, now),
  };
}

function decodeImage(dataUrl: string): {
  bytes: Buffer;
  type: keyof typeof IMAGE_TYPES;
} {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(
    dataUrl,
  );
  const type = match?.[1];
  if (!match || (type !== "png" && type !== "jpeg" && type !== "webp"))
    throw new XhsOpsError(400, "只支持 png、jpeg 或 webp 图片");
  const bytes = Buffer.from(match[2] ?? "", "base64");
  if (bytes.length === 0) throw new XhsOpsError(400, "图片内容为空");
  if (bytes.length > XHS_TAKEOVER_IMAGE_MAX_BYTES)
    throw new XhsOpsError(400, "图片不能超过 10MB");
  if (!IMAGE_TYPES[type].magic(bytes))
    throw new XhsOpsError(400, "图片内容与声明的格式不符");
  return { bytes, type };
}

export class XhsOpsChangeOrderService {
  private readonly store: XhsOpsStore;
  private readonly deviceControl: XhsOpsTakeoverPhoneControl;
  private readonly profile: XhsOpsChangeOrderServiceDeps["profile"];
  private readonly audits: XhsOpsChangeOrderServiceDeps["audits"];
  private readonly mediaRoot: string;
  private readonly idlePollIntervalMs: number;
  private readonly idleWaitTimeoutMs: number;
  private readonly offlineAfterMs: number;
  private readonly taskIdPollIntervalMs: number;
  private readonly now: () => number;
  private readonly genId: () => string;
  /** Background phone steps by order id. */
  private readonly jobs = new Map<string, Promise<void>>();

  constructor(deps: XhsOpsChangeOrderServiceDeps) {
    this.store = deps.store;
    this.deviceControl = deps.deviceControl;
    this.profile = deps.profile;
    this.audits = deps.audits;
    this.mediaRoot = path.resolve(deps.mediaRoot);
    const options = deps.options ?? {};
    this.idlePollIntervalMs =
      options.idlePollIntervalMs ?? XHS_OPS_DEFAULT_IDLE_POLL_MS;
    this.idleWaitTimeoutMs =
      options.idleWaitTimeoutMs ?? XHS_OPS_DEFAULT_IDLE_WAIT_MS;
    this.offlineAfterMs =
      options.offlineAfterMs ?? XHS_OPS_DEFAULT_OFFLINE_AFTER_MS;
    this.taskIdPollIntervalMs =
      options.taskIdPollIntervalMs ?? DEFAULT_TASK_ID_POLL_MS;
    this.now = options.now ?? (() => Date.now());
    this.genId = options.genId ?? (() => randomUUID());
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  /** Newest first; a precheck past 30 minutes is turned back to draft first. */
  async listChangeOrders(accountId: string): Promise<XhsOpsChangeOrder[]> {
    if (!(await this.store.getAccount(accountId)))
      throw new XhsOpsError(404, "账号不存在");
    await this.refreshAccount(accountId);
    return this.store.listChangeOrders({ accountId });
  }

  async getChangeOrder(orderId: string): Promise<XhsOpsChangeOrder> {
    const order = await this.requireOrder(orderId);
    await this.refreshAccount(order.accountId);
    return this.requireOrder(orderId);
  }

  /** Resolves once the background step of `orderId` in this process has settled. */
  async waitForOrder(orderId: string): Promise<void> {
    await this.jobs.get(orderId);
  }

  // ─── Create ────────────────────────────────────────────────────────────────

  /**
   * A rollback or a manual order (§5.2 steps 1 and 7); plan drafts come from
   * the plan confirmation. A rollback's after is its original's before — an
   * image needs a new upload — and it runs precheck and confirmation like
   * any other order, never by itself. Image fields need Android 10+.
   */
  async createChangeOrder(
    accountId: string,
    input: z.input<typeof xhsOpsChangeOrderCreateBodySchema>,
  ): Promise<XhsOpsChangeOrderActionResult> {
    const body = xhsOpsChangeOrderCreateBodySchema.parse(input);
    const account = requireTakeoverAccount(
      await this.store.getAccount(accountId),
    );
    const takeover = account.takeover;
    const deviceId = account.deviceId;
    if (
      !takeover.identityConfirmedAt ||
      !account.platformAccountId.trim() ||
      !deviceId
    )
      throw new XhsOpsError(409, "请先读取并锁定手机上的小红书号");
    const baseline = takeover.baselineAuditId
      ? await this.store.getAudit(takeover.baselineAuditId)
      : null;
    const baselineValues = baseline?.profile?.values;
    if (!baselineValues)
      throw new XhsOpsError(409, "请先完成只读盘点并确认基线");
    const wanted = body.fields.map((entry) => entry.field);
    if (new Set(wanted).size !== wanted.length)
      throw new XhsOpsError(400, "同一字段只能出现一次");
    const orders = await this.store.listChangeOrders({ accountId });
    const original = body.rollbackOfId
      ? (orders.find((entry) => entry.id === body.rollbackOfId) ?? null)
      : null;
    if (body.rollbackOfId && !original)
      throw new XhsOpsError(404, "要回滚的变更单不存在");
    const fields = original
      ? this.rollbackFields(original, body.fields, account)
      : await this.manualFields(account, body.fields, orders, baseline);
    if (fields.some((entry) => xhsOpsIsTakeoverImageField(entry.field))) {
      // The phone's osVersion decides; an offline phone cannot vouch for one.
      const device = await probeTakeoverDevice(this.deviceControl, deviceId, {
        now: this.now(),
        offlineAfterMs: this.offlineAfterMs,
      });
      if (device === null) throw new XhsOpsError(409, DEVICE_UNAVAILABLE);
      if (device === "unknown") throw new XhsOpsError(409, DEVICE_UNKNOWN);
      if (!xhsOpsDeviceSupportsTakeoverImages(device))
        throw new XhsOpsError(409, XHS_TAKEOVER_IMAGE_UNSUPPORTED_MESSAGE);
    }
    const withBaseline = fields.map((entry) => ({
      ...entry,
      baselineValue: xhsOpsIsTakeoverImageField(entry.field)
        ? ""
        : (textValue(baselineValues, entry.field) ?? ""),
    }));
    const risk = withBaseline.some(
      (entry) => XHS_TAKEOVER_CHANGE_BUDGET[entry.field].risk === "L2",
    )
      ? "L2"
      : "L1";
    const firstField = withBaseline[0]?.field;
    const seed: XhsOpsChangeOrderSeed = {
      projectId: account.projectId,
      accountId: account.id,
      deviceId,
      platformAccountId: account.platformAccountId,
      diagnosisId: original?.diagnosisId ?? null,
      proposalIds: [],
      batchIndex:
        original?.batchIndex ??
        (firstField ? XHS_TAKEOVER_CHANGE_BUDGET[firstField].batch : 1),
      risk,
      fields: withBaseline,
      status: "draft",
      rollbackOfId: original?.id ?? null,
    };
    const created = await this.store.createChangeOrder(seed, {
      validate: (current) => {
        const latest = current.accounts.find(
          (entry) => entry.id === account.id,
        );
        if (
          !latest?.takeover?.identityConfirmedAt ||
          latest.platformAccountId !== account.platformAccountId ||
          latest.deviceId !== deviceId
        )
          throw new XhsOpsError(409, "小红书号或设备已变化，请刷新后重试");
        const open = current.changeOrders.find(
          (entry) =>
            entry.accountId === account.id &&
            entry.platformAccountId === account.platformAccountId &&
            entry.id !== original?.id &&
            !(
              entry.status === "completed" ||
              entry.status === "failed" ||
              entry.status === "cancelled"
            ) &&
            entry.fields.some((field) =>
              withBaseline.some(
                (wantedField) => wantedField.field === field.field,
              ),
            ),
        );
        if (open)
          throw new XhsOpsError(
            409,
            `这个字段已有未结束的变更单（${STATUS_LABEL[open.status]}），请先处理完`,
          );
        if (
          original &&
          current.changeOrders.some(
            (entry) =>
              entry.rollbackOfId === original.id &&
              entry.status !== "completed" &&
              entry.status !== "failed" &&
              entry.status !== "cancelled",
          )
        )
          throw new XhsOpsError(409, "这张单已有未结束的回滚单");
      },
    });
    logger.info(
      {
        orderId: created.id,
        accountId,
        rollbackOfId: created.rollbackOfId,
        fields: created.fields.map((entry) => entry.field),
      },
      "xhs-ops: change order created",
    );
    return { order: created, account: await this.requireAccount(accountId) };
  }

  /** §5.2 step 7: only fields the original may have changed, back to its before. */
  private rollbackFields(
    original: XhsOpsChangeOrder,
    wanted: ReadonlyArray<{
      field: XhsOpsTakeoverProfileField;
      after?: string;
    }>,
    account: XhsOpsAccount,
  ): Array<{ field: XhsOpsTakeoverProfileField; after: string }> {
    if (
      original.accountId !== account.id ||
      original.platformAccountId !== account.platformAccountId
    )
      throw new XhsOpsError(409, "要回滚的单不属于当前锁定的小红书号");
    if (original.rollbackOfId !== null)
      throw new XhsOpsError(409, "回滚单不能再回滚，请新建一张变更单");
    if (
      !XHS_TAKEOVER_ROLLBACK_SOURCE_STATUSES.has(original.status) ||
      !original.applyTaskId
    )
      throw new XhsOpsError(
        409,
        `这张单${STATUS_LABEL[original.status]}，只有执行过、已进入观察或已结束的单才能回滚`,
      );
    const changed = xhsOpsChangeOrderChangedFields(original);
    return wanted.map((entry) => {
      const source = changed.find((field) => field.field === entry.field);
      if (!source)
        throw new XhsOpsError(
          409,
          `${label(entry.field)}在这张单里没有被改过，无需回滚`,
        );
      if (xhsOpsIsTakeoverImageField(entry.field))
        return {
          field: entry.field,
          after:
            entry.after?.trim() ||
            `恢复${label(entry.field)}改前的图片（请重新上传原图）`,
        };
      const before = source.before.trim();
      if (!before)
        throw new XhsOpsError(
          409,
          `${label(entry.field)}改前为空，无法自动回滚，请在手机上手动修改`,
        );
      if (
        entry.after !== undefined &&
        !xhsOpsSameProfileText(entry.after, before)
      )
        throw new XhsOpsError(400, "回滚单的新值只能是原单改前的值");
      return { field: entry.field, after: before };
    });
  }

  /** A manual order holds to the proposal rules (§4.4 #6) and one fixed batch (MT-02). */
  private async manualFields(
    account: XhsOpsAccount & { takeover: XhsOpsTakeover },
    wanted: ReadonlyArray<{
      field: XhsOpsTakeoverProfileField;
      after?: string;
    }>,
    orders: readonly XhsOpsChangeOrder[],
    baseline: XhsOpsAccountAudit,
  ): Promise<Array<{ field: XhsOpsTakeoverProfileField; after: string }>> {
    if (!account.takeover.planConfirmedAt)
      throw new XhsOpsError(409, "请先确认接管方案，再新建变更单");
    const batches = new Set(
      wanted.map((entry) => XHS_TAKEOVER_CHANGE_BUDGET[entry.field].batch),
    );
    if (batches.size > 1)
      throw new XhsOpsError(
        400,
        "一张单只能改同一批的字段：简介和职业、昵称和地区、头像和背景图",
      );
    const project = await this.store.getProject(account.projectId);
    const forbidden = project?.opsNotes.forbiddenTopics ?? [];
    return wanted.map((entry) => {
      const after = entry.after?.trim() ?? "";
      const issue = takeoverProfileValueIssue(entry.field, after, forbidden);
      if (issue) throw new XhsOpsError(400, `${label(entry.field)}：${issue}`);
      if (!xhsOpsIsTakeoverImageField(entry.field)) {
        const expected = takeoverExpectedFieldValue(
          entry.field,
          account,
          orders,
          baseline,
        );
        if (xhsOpsSameProfileText(expected, after))
          throw new XhsOpsError(409, `手机上的${label(entry.field)}已是这个值`);
      }
      return { field: entry.field, after };
    });
  }

  // ─── Image upload ──────────────────────────────────────────────────────────

  /**
   * The picture of an image field (§5.2 step 1): png, jpeg or webp up to
   * 10 MB, written to <mediaRoot>/xhs-takeover/<orderId>/<field>.<ext> with
   * its sha256. Only a draft or awaiting_confirm order takes one, and a new
   * picture voids the precheck: the order is a draft again.
   */
  async uploadImage(
    orderId: string,
    field: string,
    input: z.input<typeof xhsOpsChangeOrderImageBodySchema>,
  ): Promise<XhsOpsChangeOrderActionResult> {
    const body = xhsOpsChangeOrderImageBodySchema.parse(input);
    if (field !== "avatar" && field !== "cover")
      throw new XhsOpsError(400, "只有头像和背景图需要上传图片");
    const imageField: ImageField = field;
    const order = await this.requireOrder(orderId);
    if (order.status !== "draft" && order.status !== "awaiting_confirm")
      throw new XhsOpsError(
        409,
        `变更单${STATUS_LABEL[order.status]}，不能再换图`,
      );
    if (order.updatedAt !== body.expectedUpdatedAt)
      throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
    if (!order.fields.some((entry) => entry.field === imageField))
      throw new XhsOpsError(400, `这张单不改${label(imageField)}`);
    if (path.basename(order.id) !== order.id)
      throw new XhsOpsError(400, "变更单编号不合法");
    const { bytes, type } = decodeImage(body.dataUrl);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const directory = path.join(this.mediaRoot, TAKEOVER_MEDIA_DIR, order.id);
    const target = path.join(
      directory,
      `${imageField}${IMAGE_TYPES[type].ext}`,
    );
    const staged = `${target}.${randomUUID()}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(staged, bytes);
    let previous: string | null = null;
    let settled: Awaited<ReturnType<XhsOpsStore["mutateTakeover"]>>;
    try {
      settled = await this.store.mutateTakeover(order.accountId, (snapshot) => {
        const stored = snapshot.changeOrders.find(
          (entry) => entry.id === order.id,
        );
        if (!stored) throw new XhsOpsError(404, "变更单不存在");
        if (stored.updatedAt !== body.expectedUpdatedAt)
          throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
        if (stored.status !== "draft" && stored.status !== "awaiting_confirm")
          throw new XhsOpsError(409, "变更单状态已变化，请刷新后重试");
        previous =
          stored.fields.find((entry) => entry.field === imageField)
            ?.imagePath ?? null;
        const next: XhsOpsChangeOrder = {
          ...stored,
          status: "draft",
          precheck: null,
          error: null,
          fields: stored.fields.map((entry) =>
            entry.field === imageField
              ? { ...entry, imagePath: target, imageSha256: sha256 }
              : entry,
          ),
        };
        const takeover = snapshot.account.takeover;
        return {
          account:
            takeover && takeover.activeChangeOrderId === order.id
              ? {
                  ...snapshot.account,
                  takeover: { ...takeover, activeChangeOrderId: null },
                }
              : undefined,
          changeOrders: [next],
          result: null,
        };
      });
    } catch (error) {
      await fs.rm(staged, { force: true });
      throw error;
    }
    await fs.rename(staged, target);
    if (previous && previous !== target)
      await fs.rm(previous, { force: true }).catch(() => undefined);
    const stored =
      settled.changeOrders[0] ?? (await this.requireOrder(orderId));
    logger.info(
      { orderId, field: imageField, bytes: bytes.length },
      "xhs-ops: change order image uploaded",
    );
    return { order: stored, account: settled.account };
  }

  // ─── Precheck ──────────────────────────────────────────────────────────────

  /**
   * 「预检」 (§5.2 step 2): every precondition, the phone ready, idle and in
   * enforce mode, then one store mutation checks unfinished device work,
   * takes the exclusive lock and moves the order to prechecking. The
   * readback runs in the background; a matched read without drift and
   * within budget leaves awaiting_confirm with a 30-minute digest.
   */
  async precheck(
    orderId: string,
    input: z.input<typeof xhsOpsChangeOrderPrecheckBodySchema>,
  ): Promise<XhsOpsChangeOrderActionResult> {
    const body = xhsOpsChangeOrderPrecheckBodySchema.parse(input);
    if (this.jobs.has(orderId))
      throw new XhsOpsError(409, "变更单正在执行手机任务，请稍候");
    const first = await this.requireOrder(orderId);
    // The revision the request names is the one before the lazy upkeep: a
    // precheck past its 30 minutes turning back to draft right here is the
    // point of pressing 「预检」 again, not someone else's change.
    if (first.updatedAt !== body.expectedUpdatedAt)
      throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
    const expired = precheckExpired(first, this.now());
    await this.refreshAccount(first.accountId);
    const order = await this.requireOrder(orderId);
    if (order.status !== "draft" && order.status !== "awaiting_confirm")
      throw new XhsOpsError(
        409,
        `变更单${STATUS_LABEL[order.status]}，不能预检`,
      );
    if (
      order.updatedAt !== first.updatedAt &&
      !(expired && order.status === "draft")
    )
      throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
    const expected = { expectedUpdatedAt: order.updatedAt };
    const account = requireTakeoverAccount(
      await this.store.getAccount(order.accountId),
    );
    const nowMs = this.now();
    const orders = await this.store.listChangeOrders({
      accountId: account.id,
    });
    const issue =
      dispatchIssue({ account, order, orders, runs: null, nowMs }) ??
      budgetIssue(
        changeOrderBudget(order, account, orders, nowMs, { optimistic: true }),
      );
    if (issue) throw new XhsOpsError(409, issue);
    await this.assertDeviceReady(order.deviceId, { images: hasImage(order) });
    await this.verifyImages(order);
    const { release, result } = await this.store.claimExclusiveDevice(
      account.id,
      order.deviceId,
      {
        purpose: "change_order",
        ownOrderId: order.id,
        claim: (current, latest) => {
          const stored = this.claimedOrder(current, order.id, expected);
          if (stored.status !== "draft" && stored.status !== "awaiting_confirm")
            throw new XhsOpsError(409, "变更单状态已变化，请刷新后重试");
          const now = this.nowIso();
          const accountOrders = current.changeOrders.filter(
            (entry) => entry.accountId === latest.id,
          );
          const claimIssue =
            dispatchIssue({
              account: latest,
              order: stored,
              orders: accountOrders,
              runs: current.runs,
              nowMs: Date.parse(now),
            }) ??
            budgetIssue(
              changeOrderBudget(
                stored,
                latest,
                accountOrders,
                Date.parse(now),
                {
                  optimistic: true,
                },
              ),
            );
          if (claimIssue) throw new XhsOpsError(409, claimIssue);
          const takeover = requireTakeoverAccount(latest).takeover;
          return this.writeClaim(current, now, {
            account: {
              ...latest,
              takeover: { ...takeover, activeChangeOrderId: stored.id },
            },
            order: {
              ...stored,
              status: "prechecking",
              precheck: null,
              precheckTaskId: null,
              error: null,
            },
          });
        },
      },
    );
    this.track(result.order.id, () => this.runPrecheck(result.order, release));
    logger.info(
      { orderId, accountId: account.id },
      "xhs-ops: change order precheck started",
    );
    return result;
  }

  private async runPrecheck(
    order: XhsOpsChangeOrder,
    release: () => void,
  ): Promise<void> {
    let held = false;
    try {
      const outcome = await this.runReadOnlyTask(
        order,
        {
          task: buildTakeoverProfileReadbackTask(
            order.platformAccountId,
            orderFields(order),
          ),
          maxSteps: XHS_TAKEOVER_TASK_LIMITS.precheck.maxSteps,
          timeout: XHS_TAKEOVER_TASK_LIMITS.precheck.timeoutMs,
          allowedApps: [XHS_PACKAGE],
          taskPolicy: XHS_AUDIT_TASK_POLICY,
        },
        (taskId) =>
          this.noteTaskId(order.id, "prechecking", "precheckTaskId", taskId),
      );
      held = await this.finishPrecheck(order, outcome);
    } catch (error) {
      logger.warn(
        { orderId: order.id, error: describeError(error) },
        "xhs-ops: change order precheck failed",
      );
      await this.precheckToDraft(
        order.id,
        clip(`预检执行出错：${describeError(error)}`),
      ).catch(() => undefined);
    } finally {
      if (!held) release();
    }
  }

  /** Returns whether an unconfirmed stop holds the device. */
  private async finishPrecheck(
    order: XhsOpsChangeOrder,
    outcome: XhsOpsTakeoverPhoneOutcome,
  ): Promise<boolean> {
    if (outcome.kind === "rejected") {
      await this.precheckToDraft(
        order.id,
        clip(`预检任务未下发到手机：${outcome.reason}`),
      );
      return false;
    }
    if (outcome.kind === "policy") {
      // The pause is written; a precheck changes nothing and costs no budget.
      const { breach } = outcome;
      const stopped =
        breach.stopped || (await this.stopOrHold(order, breach.taskId ?? null));
      await this.precheckToDraft(
        order.id,
        stopped ? breach.reason : STOP_UNCONFIRMED,
      );
      return !stopped;
    }
    if (outcome.kind === "lost" || outcome.result.needsInteraction) {
      const taskId =
        outcome.kind === "lost" ? outcome.taskId : outcome.result.taskId;
      const stopped = await this.stopOrHold(order, taskId);
      await this.precheckToDraft(
        order.id,
        stopped
          ? outcome.kind === "lost"
            ? "预检任务超时或连接中断，已停止；预检不改资料，请重试"
            : "手机出现需要人工处理的页面，预检任务已停止；请处理后重试"
          : STOP_UNCONFIRMED,
      );
      return !stopped;
    }
    const result = outcome.result;
    const receipt = parseTakeoverProfileReadbackJson(result.message);
    if (receipt?.status === "read" && !receipt.accountMatched) {
      await this.failForMismatch(order.id, "prechecking", result.taskId);
      return false;
    }
    if (!receiptAccepted(result) || !receipt) {
      await this.precheckToDraft(
        order.id,
        receiptAccepted(result)
          ? "预检没有返回可用回执，请重试"
          : policyBlocked(result)
            ? "预检被手机策略拦截，重试后仍失败"
            : "预检任务没有正常结束，请重试",
      );
      return false;
    }
    if (receipt.status === "unavailable") {
      await this.precheckToDraft(
        order.id,
        "「我」页显示手机号输入页或编辑主页打不开，预检未完成；请账号本人在手机上处理后重试",
      );
      return false;
    }
    await this.passPrecheck(order.id, result.taskId, receipt, {
      screenshotUrl: takeoverScreenshotUrl(result.finalScreenshot),
    });
    return false;
  }

  /**
   * A matched readback (§5.2 step 2): it settles earlier uncertain fields,
   * then refuses drift — a text field that is not what the phone should show
   * now — and a field already at its target; the strict budget comes last.
   * A rollback restores whatever the phone shows, so only the target check
   * applies to it.
   */
  private async passPrecheck(
    orderId: string,
    taskId: string,
    receipt: XhsOpsTakeoverProfileReadback,
    evidence: { screenshotUrl: string | null },
  ): Promise<void> {
    const { result } = await this.store.mutateTakeover(
      (await this.requireOrder(orderId)).accountId,
      (snapshot) => {
        const stored = snapshot.changeOrders.find(
          (entry) => entry.id === orderId,
        );
        const account = snapshot.account;
        const takeover = account.takeover;
        if (
          !stored ||
          stored.status !== "prechecking" ||
          !takeover ||
          account.platformAccountId !== stored.platformAccountId
        )
          return { result: null };
        const settledOthers = settleUncertainFields(
          snapshot.changeOrders,
          stored,
          receipt.values,
        );
        const orders = snapshot.changeOrders.map(
          (entry) =>
            settledOthers.find((settled) => settled.id === entry.id) ?? entry,
        );
        const baseline =
          snapshot.audits.find(
            (audit) => audit.id === takeover.baselineAuditId,
          ) ?? null;
        const drift: Array<{
          field: OrderField["field"];
          baseline: string;
          current: string;
        }> = [];
        const atTarget: Array<OrderField["field"]> = [];
        for (const entry of stored.fields) {
          const current = textValue(receipt.values, entry.field);
          if (current === null) continue;
          if (xhsOpsSameProfileText(current, entry.after)) {
            atTarget.push(entry.field);
            continue;
          }
          if (stored.rollbackOfId !== null) continue;
          const field = takeoverProfileField(entry.field);
          if (!field || xhsOpsIsTakeoverImageField(field)) continue;
          const expected = takeoverExpectedFieldValue(
            field,
            account,
            orders,
            baseline,
          );
          if (!xhsOpsSameProfileText(current, expected))
            drift.push({ field: entry.field, baseline: expected, current });
        }
        const budget = changeOrderBudget(
          stored,
          account,
          orders,
          Date.parse(snapshot.now),
        );
        const refusal =
          drift.length > 0
            ? `预检发现手机上的${labels(drift.map((entry) => entry.field))}与期望值不一致，可能有人在手机上手动改过；请先重新盘点并确认基线`
            : atTarget.length > 0
              ? `手机上的${labels(atTarget)}已是目标值，无需修改，请取消这张单`
              : budgetIssue(budget);
        if (refusal) {
          return {
            account: {
              ...account,
              takeover: {
                ...takeover,
                activeChangeOrderId:
                  takeover.activeChangeOrderId === stored.id
                    ? null
                    : takeover.activeChangeOrderId,
              },
            },
            changeOrders: [
              {
                ...stored,
                status: "draft",
                precheck: null,
                precheckTaskId: taskId,
                error: clip(refusal),
              },
              ...settledOthers,
            ],
            result: refusal,
          };
        }
        const fields = stored.fields.map(
          (entry): OrderField =>
            xhsOpsIsTakeoverImageField(entry.field)
              ? {
                  ...entry,
                  before: "",
                  beforeScreenshotUrl: evidence.screenshotUrl,
                }
              : {
                  ...entry,
                  before: textValue(receipt.values, entry.field) ?? "",
                },
        );
        const prepared: XhsOpsChangeOrder = { ...stored, fields };
        return {
          changeOrders: [
            {
              ...prepared,
              status: "awaiting_confirm",
              countsBefore: receipt.header,
              precheckTaskId: taskId,
              error: null,
              precheck: {
                taskId,
                readAt: snapshot.now,
                accountMatched: true,
                drift: [],
                confirmDigest: changeOrderConfirmDigest(prepared, budget),
                expiresAt: new Date(
                  Date.parse(snapshot.now) + XHS_CHANGE_ORDER_PRECHECK_TTL_MS,
                ).toISOString(),
              },
            },
            ...settledOthers,
          ],
          result: null,
        };
      },
    );
    logger.info(
      { orderId, taskId, passed: result === null },
      "xhs-ops: change order precheck finished",
    );
  }

  /** prechecking → draft (§5.2 状态表): a precheck changes nothing and costs no budget. */
  private async precheckToDraft(orderId: string, reason: string) {
    const order = await this.requireOrder(orderId);
    await this.store.mutateTakeover(order.accountId, (snapshot) => {
      const stored = snapshot.changeOrders.find(
        (entry) => entry.id === orderId,
      );
      if (!stored || stored.status !== "prechecking") return { result: null };
      const takeover = snapshot.account.takeover;
      return {
        account:
          takeover && takeover.activeChangeOrderId === orderId
            ? {
                ...snapshot.account,
                takeover: { ...takeover, activeChangeOrderId: null },
              }
            : undefined,
        changeOrders: [
          { ...stored, status: "draft", precheck: null, error: clip(reason) },
        ],
        result: null,
      };
    });
    logger.info({ orderId }, "xhs-ops: change order precheck back to draft");
  }

  // ─── Confirm and apply ─────────────────────────────────────────────────────

  /**
   * 「确认执行」 (§5.2 step 3): the digest the precheck produced, within its
   * 30 minutes, and every ack the order's content requires. Today goes into
   * noNurtureDates before anything is dispatched, whatever comes of it; the
   * profile draft takes the text values as reviewed (mvp 嫁接), and the
   * apply runs in the background through the profile service.
   */
  async confirm(
    orderId: string,
    input: z.input<typeof xhsOpsChangeOrderConfirmBodySchema>,
  ): Promise<XhsOpsChangeOrderActionResult> {
    const body = xhsOpsChangeOrderConfirmBodySchema.parse(input);
    if (this.jobs.has(orderId))
      throw new XhsOpsError(409, "变更单正在执行手机任务，请稍候");
    const first = await this.requireOrder(orderId);
    await this.refreshAccount(first.accountId);
    const order = await this.requireOrder(orderId);
    if (order.status !== "awaiting_confirm" || !order.precheck)
      throw new XhsOpsError(
        409,
        order.status === "draft"
          ? "请先预检；预检超过 30 分钟需要重新预检"
          : `变更单${STATUS_LABEL[order.status]}，不能确认`,
      );
    if (order.updatedAt !== body.expectedUpdatedAt)
      throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
    if (body.confirmDigest !== order.precheck.confirmDigest)
      throw new XhsOpsError(409, "确认内容与预检结果不一致，请重新预检");
    const account = requireTakeoverAccount(
      await this.store.getAccount(order.accountId),
    );
    const orders = await this.store.listChangeOrders({
      accountId: account.id,
    });
    const missing = xhsOpsChangeOrderMissingAcks(
      order.fields.map((entry) => entry.field),
      body.acks,
      { previousWarn: xhsOpsChangeOrderPreviousReviewWarned(orders, order) },
    );
    if (missing.length > 0)
      throw new XhsOpsError(
        409,
        `请逐项勾选确认：${missing.map((key) => ACK_LABEL[key]).join("、")}`,
      );
    const nowMs = this.now();
    const issue =
      dispatchIssue({ account, order, orders, runs: null, nowMs }) ??
      budgetIssue(changeOrderBudget(order, account, orders, nowMs));
    if (issue) throw new XhsOpsError(409, issue);
    await this.assertDeviceReady(order.deviceId, { images: hasImage(order) });
    await this.verifyImages(order);
    const operationId = this.genId();
    const albumKey = operationId.replace(/-/g, "").slice(0, 8);
    const { release, result } = await this.store.claimExclusiveDevice(
      account.id,
      order.deviceId,
      {
        purpose: "change_order",
        ownOrderId: order.id,
        claim: (current, latest) => {
          const stored = this.claimedOrder(current, order.id, body);
          const now = this.nowIso();
          const now_ms = Date.parse(now);
          if (
            stored.status !== "awaiting_confirm" ||
            !stored.precheck ||
            stored.precheck.confirmDigest !== body.confirmDigest
          )
            throw new XhsOpsError(409, "变更单已变化，请重新预检");
          if (precheckExpired(stored, now_ms))
            throw new XhsOpsError(409, "预检已超过 30 分钟，请重新预检");
          const accountOrders = current.changeOrders.filter(
            (entry) => entry.accountId === latest.id,
          );
          const claimIssue =
            dispatchIssue({
              account: latest,
              order: stored,
              orders: accountOrders,
              runs: current.runs,
              nowMs: now_ms,
            }) ??
            budgetIssue(
              changeOrderBudget(stored, latest, accountOrders, now_ms),
            );
          if (claimIssue) throw new XhsOpsError(409, claimIssue);
          const takeover = requireTakeoverAccount(latest).takeover;
          const today = localDateString(new Date(now_ms));
          const draft = { ...latest.profileDraft };
          for (const entry of stored.fields) {
            switch (entry.field) {
              case "nickname":
              case "bio":
              case "occupation":
              case "region":
                draft[entry.field] = entry.after;
                break;
              default:
                break;
            }
          }
          return this.writeClaim(current, now, {
            account: {
              ...latest,
              profileDraft: {
                ...draft,
                reviewedAt: now,
                applyOperation: {
                  operationId,
                  status: "running",
                  deviceId: stored.deviceId,
                  taskId: null,
                  accountUpdatedAt: latest.updatedAt,
                  startedAt: now,
                  completedAt: null,
                  changeOrderId: stored.id,
                },
              },
              takeover: {
                ...takeover,
                activeChangeOrderId: stored.id,
                noNurtureDates: [
                  ...new Set([...takeover.noNurtureDates, today]),
                ]
                  .sort()
                  .slice(-MAX_NO_NURTURE_DATES),
              },
            },
            order: {
              ...stored,
              status: "applying",
              confirmedAt: now,
              acks: body.acks,
              acksAt: now,
              applyTaskId: XHS_CHANGE_ORDER_TASK_PENDING,
              verificationTaskId: null,
              verificationScreenshotUrl: null,
              countsAfter: null,
              error: null,
              fields: stored.fields.map((entry) =>
                xhsOpsIsTakeoverImageField(entry.field)
                  ? {
                      ...entry,
                      mediaAlbum: `Tabby-${albumKey}-${entry.field === "avatar" ? "a" : "c"}`,
                    }
                  : entry,
              ),
            },
          });
        },
      },
    );
    this.track(result.order.id, () => this.runApply(result.order.id, release));
    logger.info(
      { orderId, accountId: account.id, rollback: order.rollbackOfId !== null },
      "xhs-ops: change order confirmed",
    );
    return result;
  }

  private async runApply(orderId: string, release: () => void) {
    let held = false;
    try {
      const applied = await this.profile.applyChangeOrder(orderId);
      held = applied.held;
      if (!held && applied.order.status === "verifying")
        held = await this.runVerification(applied.order);
    } catch (error) {
      logger.warn(
        { orderId, error: describeError(error) },
        "xhs-ops: change order apply failed",
      );
      await this.interrupt(
        orderId,
        clip(`执行出错：${describeError(error)}；本单字段可能已改，请补跑核验`),
      ).catch(() => undefined);
    } finally {
      if (!held) release();
    }
  }

  // ─── Verification ──────────────────────────────────────────────────────────

  /**
   * 「补跑核验」 (§5.2 step 5, 状态表 interrupted → verifying): only an
   * order that dispatched an apply, under the identity it was confirmed for;
   * one invalidated by an identity change waits for the re-lock, and one of
   * a 小红书号 no longer locked can never be verified and fails. A ledger
   * still running is reconciled first. Verifies every done and uncertain
   * field; nothing is pushed or written.
   */
  async verify(
    orderId: string,
    input: z.input<typeof xhsOpsChangeOrderVerifyBodySchema>,
  ): Promise<XhsOpsChangeOrderActionResult> {
    const body = xhsOpsChangeOrderVerifyBodySchema.parse(input);
    if (this.jobs.has(orderId))
      throw new XhsOpsError(409, "变更单正在执行手机任务，请稍候");
    let order = await this.requireOrder(orderId);
    if (order.status !== "interrupted")
      throw new XhsOpsError(
        409,
        `变更单${STATUS_LABEL[order.status]}，只有已中断的单需要补跑核验`,
      );
    if (order.updatedAt !== body.expectedUpdatedAt)
      throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
    if (!order.applyTaskId)
      throw new XhsOpsError(409, "这张单没有派发过修改任务，无需核验");
    let account = requireTakeoverAccount(
      await this.store.getAccount(order.accountId),
    );
    if (
      account.takeover.identityConfirmedAt &&
      account.platformAccountId !== order.platformAccountId
    )
      return this.failForeignOrder(order.id, "verify");
    if (
      !account.takeover.identityConfirmedAt ||
      account.deviceId !== order.deviceId
    )
      throw new XhsOpsError(
        409,
        "小红书号或设备已变化，请先重新锁定身份后再补跑核验",
      );
    const ledger = account.profileDraft.applyOperation;
    if (ledger?.status === "running" && ledger.changeOrderId === order.id) {
      // A phone that cannot be queried leaves the ledger running: the 409 below.
      await this.profile.reconcile(account.id).catch((error: unknown) => {
        logger.warn(
          { orderId, error: describeError(error) },
          "xhs-ops: change order ledger reconcile before verify failed",
        );
      });
      account = requireTakeoverAccount(await this.store.getAccount(account.id));
      if (account.profileDraft.applyOperation?.status === "running")
        throw new XhsOpsError(
          409,
          "手机上的修改任务结果还没确认，请等手机空闲后再补跑核验",
        );
      order = await this.requireOrder(orderId);
      if (order.status !== "interrupted")
        return { order, account: await this.requireAccount(account.id) };
    }
    const issue = verifyIssue(account, order);
    if (issue) throw new XhsOpsError(409, issue);
    await this.assertDeviceReady(order.deviceId, { images: false });
    const expected = order.updatedAt;
    const { release, result } = await this.store.claimExclusiveDevice(
      account.id,
      order.deviceId,
      {
        purpose: "change_order",
        ownOrderId: order.id,
        claim: (current, latest) => {
          const stored = this.claimedOrder(current, order.id, {
            expectedUpdatedAt: expected,
          });
          if (stored.status !== "interrupted")
            throw new XhsOpsError(409, "变更单状态已变化，请刷新后重试");
          const claimIssue = verifyIssue(latest, stored);
          if (claimIssue) throw new XhsOpsError(409, claimIssue);
          const takeover = requireTakeoverAccount(latest).takeover;
          return this.writeClaim(current, this.nowIso(), {
            account: {
              ...latest,
              takeover: { ...takeover, activeChangeOrderId: stored.id },
            },
            order: {
              ...stored,
              status: "verifying",
              verificationTaskId: null,
              error: null,
            },
          });
        },
      },
    );
    this.track(result.order.id, async () => {
      let held = false;
      try {
        held = await this.runVerification(result.order);
      } catch (error) {
        logger.warn(
          { orderId, error: describeError(error) },
          "xhs-ops: change order verification failed",
        );
        await this.interrupt(
          orderId,
          clip(`核验执行出错：${describeError(error)}`),
        ).catch(() => undefined);
      } finally {
        if (!held) release();
      }
    });
    return result;
  }

  /**
   * An interrupted or observing order of a 小红书号 no longer locked: it can
   * never be verified or reviewed, so it fails and blocks nothing any more.
   */
  private async failForeignOrder(
    orderId: string,
    step: "verify" | "review",
  ): Promise<XhsOpsChangeOrderActionResult> {
    const order = await this.requireOrder(orderId);
    const settled = await this.store.mutateTakeover(
      order.accountId,
      (snapshot) => {
        const stored = snapshot.changeOrders.find(
          (entry) => entry.id === orderId,
        );
        const takeover = snapshot.account.takeover;
        const from = step === "verify" ? "interrupted" : "observing";
        if (!stored || stored.status !== from || !takeover)
          return { result: null };
        return {
          account: {
            ...snapshot.account,
            takeover: {
              ...takeover,
              activeChangeOrderId:
                takeover.activeChangeOrderId === orderId
                  ? null
                  : takeover.activeChangeOrderId,
            },
          },
          changeOrders: [
            {
              ...stored,
              status: "failed",
              error: `手机上锁定的已是另一个小红书号，这张单无法再${step === "verify" ? "核验" : "复查"}`,
            },
          ],
          result: null,
        };
      },
    );
    return {
      order: settled.changeOrders[0] ?? (await this.requireOrder(orderId)),
      account: settled.account,
    };
  }

  /**
   * Verify the changed fields (§5.2 step 5, 状态表 核验所有 done 和
   * uncertain) with the takeover verification task, dispatched as the
   * identity gate request — read-only roles and actions, login forbidden.
   * The first verification after an apply checks the uncertain fields too: a
   * receipt that reported only some fields leaves the others possibly
   * changed. Returns whether an unconfirmed stop holds the device.
   */
  private async runVerification(order: XhsOpsChangeOrder): Promise<boolean> {
    const targets = order.fields.filter(
      (entry) => entry.outcome === "done" || entry.outcome === "uncertain",
    );
    const fields = targets.flatMap((entry): XhsOpsTakeoverVerifyField[] => {
      const field = takeoverProfileField(entry.field);
      if (!field) return [];
      return xhsOpsIsTakeoverImageField(field)
        ? [{ field }]
        : [{ field, after: entry.after }];
    });
    if (fields.length === 0) {
      await this.settleUnverifiable(order.id);
      return false;
    }
    const ready = await this.waitForIdle(order.deviceId);
    if (ready) {
      await this.interrupt(order.id, ready);
      return false;
    }
    const outcome = await this.runReadOnlyTask(
      order,
      {
        ...buildTakeoverIdentityGateRequest(
          XHS_PACKAGE,
          order.platformAccountId,
        ),
        task: buildTakeoverProfileVerificationTask({
          platformAccountId: order.platformAccountId,
          fields,
        }),
        maxSteps: XHS_TAKEOVER_TASK_LIMITS.verification.maxSteps,
        timeout: XHS_TAKEOVER_TASK_LIMITS.verification.timeoutMs,
      },
      (taskId) =>
        this.noteTaskId(order.id, "verifying", "verificationTaskId", taskId),
    );
    const keys = fields.map((entry) => entry.field);
    if (outcome.kind === "rejected") {
      await this.interrupt(
        order.id,
        clip(`核验任务未下发到手机：${outcome.reason}；请补跑核验`),
      );
      return false;
    }
    if (outcome.kind === "policy") {
      const { breach } = outcome;
      const stopped =
        breach.stopped || (await this.stopOrHold(order, breach.taskId ?? null));
      await this.interrupt(
        order.id,
        stopped
          ? clip(`${breach.reason}；换用 enforce 构建后请补跑核验`)
          : STOP_UNCONFIRMED,
      );
      return !stopped;
    }
    if (outcome.kind === "lost" || outcome.result.needsInteraction) {
      const taskId =
        outcome.kind === "lost" ? outcome.taskId : outcome.result.taskId;
      const stopped = await this.stopOrHold(order, taskId);
      await this.interrupt(
        order.id,
        stopped
          ? outcome.kind === "lost"
            ? "核验任务超时或连接中断，已停止；请补跑核验"
            : "手机出现需要人工处理的页面，核验任务已停止；请处理后补跑核验"
          : STOP_UNCONFIRMED,
      );
      return !stopped;
    }
    const result = outcome.result;
    const parsed = receiptAccepted(result)
      ? parseTakeoverProfileVerificationJson(result.message, {
          requiredFields: keys,
        })
      : null;
    if (!parsed) {
      await this.interrupt(
        order.id,
        policyBlocked(result)
          ? "核验被手机策略拦截，重试后仍失败；请补跑核验"
          : "核验没有返回可用回执，请补跑核验",
      );
      return false;
    }
    if (!parsed.accountMatched) {
      await this.failForMismatch(order.id, "verifying", result.taskId);
      return false;
    }
    await this.settleVerified(order.id, result.taskId, parsed, {
      keys,
      screenshotUrl: takeoverScreenshotUrl(result.finalScreenshot),
    });
    return false;
  }

  /**
   * A verification receipt (§5.2 step 5): text fields become verified or
   * mismatch — a mismatch fails the order — and pictures wait for a human
   * whatever the task saw. The header counts against countsBefore give the
   * graded flags.
   */
  private async settleVerified(
    orderId: string,
    taskId: string,
    parsed: XhsOpsTakeoverProfileVerification,
    input: {
      keys: readonly XhsOpsTakeoverProfileField[];
      screenshotUrl: string | null;
    },
  ): Promise<void> {
    const order = await this.requireOrder(orderId);
    const settled = await this.store.mutateTakeover(
      order.accountId,
      (snapshot) => {
        const stored = snapshot.changeOrders.find(
          (entry) => entry.id === orderId,
        );
        const takeover = snapshot.account.takeover;
        // An identity change interrupted it meanwhile: this read is void.
        if (!stored || stored.status !== "verifying" || !takeover)
          return { result: null };
        const flags = new Set(stored.flags);
        for (const flag of xhsOpsHeaderCountFlags(
          stored.countsBefore,
          parsed.header,
        ))
          flags.add(flag);
        const notAtTarget: Array<OrderField["field"]> = [];
        const fields = stored.fields.map((entry): OrderField => {
          const field = takeoverProfileField(entry.field);
          if (!field || !input.keys.includes(field)) return entry;
          const shown = parsed.fields[field] === true;
          if (xhsOpsIsTakeoverImageField(field))
            return {
              ...entry,
              outcome: "done",
              note: shown
                ? entry.note
                : clip("核验任务认为图片没有正常显示，请对照截图确认"),
            };
          if (shown) return { ...entry, outcome: "verified" };
          notAtTarget.push(entry.field);
          // A field the apply left uncertain may never have changed: it stays
          // uncertain, and in the budget, until a readback settles it (§8.1).
          return entry.outcome === "uncertain"
            ? {
                ...entry,
                note: clip(
                  "核验显示不是目标值，可能没有改动；下一次预检回读后结算",
                ),
              }
            : { ...entry, outcome: "mismatch" };
        });
        const next: XhsOpsChangeOrder = {
          ...stored,
          fields,
          flags: [...flags],
          countsAfter: parsed.header,
          verificationTaskId: taskId,
          verificationScreenshotUrl: input.screenshotUrl,
          error: null,
        };
        const account = { ...snapshot.account, takeover };
        const moved: XhsOpsOrderStep =
          notAtTarget.length > 0
            ? {
                ...closeChangeOrder(account, next, {
                  status: "failed",
                  error: `核验发现${labels(notAtTarget)}与目标值不一致`,
                  now: snapshot.now,
                }),
                closed: [],
              }
            : afterHumanChecks(account, next, snapshot, snapshot.now);
        return {
          account: moved.account,
          changeOrders: [moved.order, ...moved.closed],
          result: null,
        };
      },
    );
    const verified = settled.changeOrders.find((entry) => entry.id === orderId);
    logger.info(
      {
        orderId,
        taskId,
        status: verified?.status,
        flags: verified?.flags,
        closedOriginal: settled.changeOrders.some(
          (entry) => entry.id !== orderId,
        ),
      },
      "xhs-ops: change order verified",
    );
  }

  /** Nothing left to verify: the fields all failed or were skipped. */
  private async settleUnverifiable(orderId: string): Promise<void> {
    const order = await this.requireOrder(orderId);
    await this.store.mutateTakeover(order.accountId, (snapshot) => {
      const stored = snapshot.changeOrders.find(
        (entry) => entry.id === orderId,
      );
      if (!stored || stored.status !== "verifying") return { result: null };
      const moved = closeChangeOrder(snapshot.account, stored, {
        status: "failed",
        error: "本单没有改成的字段，无需核验",
        now: snapshot.now,
      });
      return {
        account: moved.account,
        changeOrders: [moved.order],
        result: null,
      };
    });
  }

  /** applying / verifying → interrupted (§5.2 状态表): the fields may have changed; verify re-checks them. */
  private async interrupt(orderId: string, reason: string): Promise<void> {
    const order = await this.requireOrder(orderId);
    await this.store.mutateTakeover(order.accountId, (snapshot) => {
      const stored = snapshot.changeOrders.find(
        (entry) => entry.id === orderId,
      );
      if (
        !stored ||
        (stored.status !== "applying" && stored.status !== "verifying")
      )
        return { result: null };
      return {
        changeOrders: [
          {
            ...stored,
            status: "interrupted",
            error: clip(reason),
            fields: stored.fields.map((entry) =>
              entry.outcome === "pending"
                ? { ...entry, outcome: "uncertain" as const }
                : entry,
            ),
          },
        ],
        result: null,
      };
    });
    logger.info({ orderId }, "xhs-ops: change order interrupted");
  }

  /** The phone shows another 小红书号: the order fails and the takeover pauses (account_mismatch). */
  private async failForMismatch(
    orderId: string,
    from: "prechecking" | "verifying",
    taskId: string,
  ): Promise<void> {
    const order = await this.requireOrder(orderId);
    await this.store.mutateTakeover(order.accountId, (snapshot) => {
      const stored = snapshot.changeOrders.find(
        (entry) => entry.id === orderId,
      );
      const takeover = snapshot.account.takeover;
      if (!stored || stored.status !== from || !takeover)
        return { result: null };
      const moved = closeChangeOrder(
        snapshot.account,
        from === "prechecking"
          ? { ...stored, precheckTaskId: taskId }
          : { ...stored, verificationTaskId: taskId },
        {
          status: "failed",
          error: "手机上当前登录的不是锁定的小红书号",
          now: snapshot.now,
        },
      );
      const account = requireTakeoverAccount(moved.account);
      return {
        account: withPause(
          account,
          {
            code: "account_mismatch",
            reason: MISMATCH_PAUSE_REASON,
            sourceRef: orderId,
          },
          snapshot.now,
        ),
        changeOrders: [moved.order],
        result: null,
      };
    });
    logger.warn(
      { orderId, step: from },
      "xhs-ops: change order identity mismatch, takeover paused",
    );
  }

  // ─── Human checks ──────────────────────────────────────────────────────────

  /**
   * 「图片一致 / 不一致」, one image field at a time (§5.2 step 5, §6.4).
   * After verification: match verifies the field, mismatch fails the order
   * and pauses the takeover (manual, sourceRef this order) so a rollback can
   * follow. After the observation review: the result goes into
   * observation.visualChecks and the verdict is decided once every picture
   * was compared.
   */
  async visualCheck(
    orderId: string,
    input: z.input<typeof xhsOpsChangeOrderVisualCheckBodySchema>,
  ): Promise<XhsOpsChangeOrderActionResult> {
    const body = xhsOpsChangeOrderVisualCheckBodySchema.parse(input);
    const order = await this.requireOrder(orderId);
    if (order.updatedAt !== body.expectedUpdatedAt)
      throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
    const entry = order.fields.find((field) => field.field === body.field);
    if (!entry) throw new XhsOpsError(400, `这张单不改${label(body.field)}`);
    if (order.status === "awaiting_visual_check") {
      if (entry.outcome !== "done")
        throw new XhsOpsError(
          409,
          entry.outcome === "verified" || entry.outcome === "mismatch"
            ? `${label(body.field)}已经对照过`
            : `${label(body.field)}没有改动，无需对照`,
        );
      return this.visualCheckAfterVerification(orderId, body);
    }
    if (order.status === "observing") {
      const auditId = order.observation?.auditId;
      if (!auditId) throw new XhsOpsError(409, "请先复查，再对照图片");
      const audit = await this.store.getAudit(auditId);
      if (!audit || audit.status === "running")
        throw new XhsOpsError(409, "复查还没结束，请稍候");
      // The picture to compare is the review's last screenshot.
      if (audit.status !== "completed" && audit.status !== "partial")
        throw new XhsOpsError(409, "复查没有完成，请重新复查后再对照图片");
      if (entry.outcome !== "verified")
        throw new XhsOpsError(409, `${label(body.field)}没有改动，无需对照`);
      if (order.observation?.visualChecks[body.field])
        throw new XhsOpsError(409, `${label(body.field)}已经对照过`);
      const runs = await this.store.listRuns({ accountId: order.accountId });
      const { changeOrders, account } = await this.store.mutateTakeover(
        order.accountId,
        (snapshot) => {
          const stored = snapshot.changeOrders.find(
            (candidate) => candidate.id === orderId,
          );
          if (
            !stored?.observation ||
            stored.status !== "observing" ||
            stored.updatedAt !== body.expectedUpdatedAt
          )
            throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
          const checked: XhsOpsChangeOrder = {
            ...stored,
            observation: {
              ...stored.observation,
              visualChecks: {
                ...stored.observation.visualChecks,
                [body.field]: {
                  screenshotUrl: audit.profile?.evidence?.screenshotUrl ?? null,
                  result: body.result,
                  at: snapshot.now,
                },
              },
            },
          };
          const decided = this.decideObservation(
            snapshot,
            checked,
            audit,
            runs,
          );
          return {
            account: decided.account,
            changeOrders: [decided.order],
            result: null,
          };
        },
      );
      return {
        order: changeOrders[0] ?? (await this.requireOrder(orderId)),
        account,
      };
    }
    throw new XhsOpsError(
      409,
      `变更单${STATUS_LABEL[order.status]}，现在不需要对照图片`,
    );
  }

  private async visualCheckAfterVerification(
    orderId: string,
    body: z.infer<typeof xhsOpsChangeOrderVisualCheckBodySchema>,
  ): Promise<XhsOpsChangeOrderActionResult> {
    const order = await this.requireOrder(orderId);
    const { changeOrders, account } = await this.store.mutateTakeover(
      order.accountId,
      (snapshot) => {
        const stored = snapshot.changeOrders.find(
          (entry) => entry.id === orderId,
        );
        const takeover = snapshot.account.takeover;
        if (
          !stored ||
          !takeover ||
          stored.status !== "awaiting_visual_check" ||
          stored.updatedAt !== body.expectedUpdatedAt
        )
          throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
        const checked: XhsOpsChangeOrder = {
          ...stored,
          fields: stored.fields.map((entry) =>
            entry.field === body.field
              ? {
                  ...entry,
                  outcome: body.result === "match" ? "verified" : "mismatch",
                  visualCheck: {
                    screenshotUrl: stored.verificationScreenshotUrl,
                    result: body.result,
                    at: snapshot.now,
                  },
                }
              : entry,
          ),
        };
        const owner = { ...snapshot.account, takeover };
        if (body.result === "mismatch") {
          const closed = closeChangeOrder(owner, checked, {
            status: "failed",
            error: IMAGE_MISMATCH_REASON,
            now: snapshot.now,
          });
          return {
            account: withPause(
              requireTakeoverAccount(closed.account),
              {
                code: "manual",
                reason: IMAGE_MISMATCH_REASON,
                sourceRef: orderId,
              },
              snapshot.now,
            ),
            changeOrders: [closed.order],
            result: null,
          };
        }
        const moved = afterHumanChecks(owner, checked, snapshot, snapshot.now);
        return {
          account: moved.account,
          changeOrders: [moved.order, ...moved.closed],
          result: null,
        };
      },
    );
    const settled =
      changeOrders.find((entry) => entry.id === orderId) ??
      (await this.requireOrder(orderId));
    logger.info(
      {
        orderId,
        field: body.field,
        result: body.result,
        status: settled.status,
      },
      "xhs-ops: change order visual check",
    );
    return { order: settled, account };
  }

  /** 「已人工检查」 (§5.2 step 5): a header count moved during the change; a human checked the phone. */
  async manualCheck(
    orderId: string,
    input: z.input<typeof xhsOpsChangeOrderManualCheckBodySchema>,
  ): Promise<XhsOpsChangeOrderActionResult> {
    const body = xhsOpsChangeOrderManualCheckBodySchema.parse(input);
    const order = await this.requireOrder(orderId);
    const { changeOrders, account } = await this.store.mutateTakeover(
      order.accountId,
      (snapshot) => {
        const stored = snapshot.changeOrders.find(
          (entry) => entry.id === orderId,
        );
        const takeover = snapshot.account.takeover;
        if (!stored || !takeover) throw new XhsOpsError(404, "变更单不存在");
        if (stored.updatedAt !== body.expectedUpdatedAt)
          throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
        if (stored.status !== "awaiting_manual_check")
          throw new XhsOpsError(
            409,
            `变更单${STATUS_LABEL[stored.status]}，不需要人工检查`,
          );
        const moved = beginObservation(
          { ...snapshot.account, takeover },
          { ...stored, manualCheckAt: snapshot.now },
          snapshot,
          snapshot.now,
        );
        return {
          account: moved.account,
          changeOrders: [moved.order, ...moved.closed],
          result: null,
        };
      },
    );
    return {
      order:
        changeOrders.find((entry) => entry.id === orderId) ??
        (await this.requireOrder(orderId)),
      account,
    };
  }

  // ─── Observation review ────────────────────────────────────────────────────

  /**
   * 「复查」 once the window ended (§6.4): an audit whose part one re-reads
   * this order's fields with the 号码核对 — ending on 「我」 for a picture —
   * followed by A and B. The verdict is decided when it finishes, against
   * the latest completed audit before the confirmation; an image order stays
   * observing (inconclusive) until each picture was compared. An order of a
   * 小红书号 no longer locked cannot be reviewed and fails instead.
   */
  async reviewObservation(
    orderId: string,
    input: z.input<typeof xhsOpsObservationReviewBodySchema>,
  ): Promise<XhsOpsChangeOrderActionResult> {
    const body = xhsOpsObservationReviewBodySchema.parse(input);
    if (this.jobs.has(orderId))
      throw new XhsOpsError(409, "复查进行中，请稍候");
    const first = await this.requireOrder(orderId);
    await this.refreshAccount(first.accountId);
    const order = await this.requireOrder(orderId);
    const observation = order.observation;
    if (order.status !== "observing" || !observation)
      throw new XhsOpsError(
        409,
        `变更单${STATUS_LABEL[order.status]}，不在观察期`,
      );
    if (order.updatedAt !== body.expectedUpdatedAt)
      throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
    if (Date.parse(observation.until) > this.now())
      throw new XhsOpsError(
        409,
        `观察期到 ${formatLocalTime(observation.until)} 结束，期满后再复查`,
      );
    if (observation.auditId) {
      const audit = await this.store.getAudit(observation.auditId);
      if (audit?.status === "running")
        throw new XhsOpsError(409, "复查进行中，请稍候");
      if (observation.verdict === "inconclusive")
        throw new XhsOpsError(409, "复查已完成，请在卡片上逐张对照图片");
    }
    const account = requireTakeoverAccount(
      await this.store.getAccount(order.accountId),
    );
    if (
      account.takeover.identityConfirmedAt &&
      account.platformAccountId !== order.platformAccountId
    )
      return this.failForeignOrder(order.id, "review");
    if (!account.takeover.identityConfirmedAt)
      throw new XhsOpsError(409, "小红书号或设备已变化，请先重新锁定身份");
    // Only what changed is re-read; a picture makes part one end on 「我」.
    const readbackFields = order.fields.flatMap((entry) => {
      const field = takeoverProfileField(entry.field);
      return field && entry.outcome === "verified" ? [field] : [];
    });
    const audit = await this.audits.startAudit(
      account.id,
      {},
      {
        trigger: "observation",
        changeOrderId: order.id,
        readbackFields,
      },
    );
    const { changeOrders, account: updated } = await this.store.mutateTakeover(
      account.id,
      (snapshot) => {
        const stored = snapshot.changeOrders.find(
          (entry) => entry.id === orderId,
        );
        if (!stored?.observation || stored.status !== "observing")
          return { result: null };
        return {
          changeOrders: [
            {
              ...stored,
              observation: {
                ...stored.observation,
                auditId: audit.id,
                verdict: "pending",
                notes: [],
              },
            },
          ],
          result: null,
        };
      },
    );
    this.track(orderId, async () => {
      await this.audits.waitForAudit(audit.id);
      await this.settleObservation(orderId).catch((error) => {
        logger.warn(
          { orderId, error: describeError(error) },
          "xhs-ops: change order observation settle failed",
        );
      });
    });
    logger.info(
      { orderId, auditId: audit.id },
      "xhs-ops: change order observation review started",
    );
    return {
      order: changeOrders[0] ?? (await this.requireOrder(orderId)),
      account: updated,
    };
  }

  /** Decide a finished review once; called after the audit and lazily on reads. */
  private async settleObservation(orderId: string): Promise<void> {
    const order = await this.requireOrder(orderId);
    const auditId = order.observation?.auditId;
    if (
      order.status !== "observing" ||
      !auditId ||
      order.observation?.verdict !== "pending"
    )
      return;
    const audit = await this.store.getAudit(auditId);
    if (!audit || audit.status === "running") return;
    const runs = await this.store.listRuns({ accountId: order.accountId });
    const { changeOrders } = await this.store.mutateTakeover(
      order.accountId,
      (snapshot) => {
        const stored = snapshot.changeOrders.find(
          (entry) => entry.id === orderId,
        );
        if (
          !stored?.observation ||
          stored.status !== "observing" ||
          stored.observation.auditId !== auditId ||
          stored.observation.verdict !== "pending"
        )
          return { result: null };
        const decided = this.decideObservation(snapshot, stored, audit, runs);
        return {
          account: decided.account,
          changeOrders: [decided.order],
          result: null,
        };
      },
    );
    const settled = changeOrders[0];
    logger.info(
      {
        orderId,
        auditId,
        status: settled?.status,
        verdict: settled?.observation?.verdict,
      },
      "xhs-ops: change order observation reviewed",
    );
  }

  /**
   * xhsOpsObservationVerdict over the review (§6.4). A review that did not
   * finish and raised nothing can simply run again; fail fails the order and
   * pauses the takeover (observation_failed, sourceRef this order); pass,
   * warn and a final inconclusive complete it — unless a field had failed at
   * apply, which ends the order failed without a pause.
   */
  private decideObservation(
    snapshot: {
      account: XhsOpsAccount;
      audits: readonly XhsOpsAccountAudit[];
      changeOrders: readonly XhsOpsChangeOrder[];
      now: string;
    },
    order: XhsOpsChangeOrder,
    review: XhsOpsAccountAudit,
    runs: readonly XhsOpsRun[],
  ): { account: XhsOpsAccount; order: XhsOpsChangeOrder } {
    const observation = order.observation;
    const takeover = snapshot.account.takeover;
    if (!observation || !takeover) return { account: snapshot.account, order };
    const usable = review.status === "completed" || review.status === "partial";
    const mismatched = review.profile?.code === "account_mismatch";
    const signals = observationSignals({
      account: snapshot.account,
      runs,
      audits: snapshot.audits.map((audit) =>
        audit.id === review.id ? review : audit,
      ),
      since: order.confirmedAt ?? order.createdAt,
    });
    if (!usable && !mismatched && signals.length === 0)
      return {
        account: snapshot.account,
        order: {
          ...order,
          observation: {
            ...observation,
            auditId: null,
            verdict: "pending",
            notes: [
              clip(
                `复查没有完成：${review.reason || STATUS_LABEL.interrupted}，请重新复查`,
                MAX_OBSERVATION_NOTE_CHARS,
              ),
            ],
          },
        },
      };
    const values =
      usable && review.profile?.accountMatched ? review.profile.values : null;
    // A rollback of this order that verified a field took it back on purpose:
    // the review no longer holds that field to this order's after.
    const undone = new Set(
      snapshot.changeOrders.flatMap((entry) =>
        entry.rollbackOfId === order.id
          ? entry.fields.flatMap((field) =>
              field.outcome === "verified" ? [field.field] : [],
            )
          : [],
      ),
    );
    const changed = order.fields.filter(
      (entry) => entry.outcome === "verified" && !undone.has(entry.field),
    );
    const fieldMismatches = changed.flatMap((entry) => {
      const current = values ? textValue(values, entry.field) : null;
      return current !== null && !xhsOpsSameProfileText(current, entry.after)
        ? [entry.field]
        : [];
    });
    const images = changed.flatMap((entry) =>
      entry.field === "avatar" || entry.field === "cover"
        ? [
            {
              field: entry.field,
              result: observation.visualChecks[entry.field]?.result ?? null,
            },
          ]
        : [],
    );
    const base = observation.baseAuditId
      ? (snapshot.audits.find(
          (audit) => audit.id === observation.baseAuditId,
        ) ?? null)
      : null;
    const verdict = xhsOpsObservationVerdict({
      risk: order.risk,
      comparison: base && usable ? compareXhsOpsAudits(base, review) : null,
      // A review that stopped early on a risk signal never reached the
      // 号码核对: only a read that came back mismatched counts as one.
      accountMatched:
        !mismatched && (!usable || review.profile?.accountMatched === true),
      signals,
      fieldMismatches,
      images,
    });
    const notes = verdict.notes
      .map((note) => clip(note, MAX_OBSERVATION_NOTE_CHARS))
      .slice(0, MAX_OBSERVATION_NOTES);
    if (verdict.awaitingVisualCheck)
      return {
        account: snapshot.account,
        order: {
          ...order,
          observation: { ...observation, verdict: "inconclusive", notes },
        },
      };
    const reviewed: XhsOpsChangeOrder = {
      ...order,
      observation: { ...observation, verdict: verdict.verdict, notes },
    };
    if (verdict.verdict === "fail")
      return {
        account: withPause(
          { ...snapshot.account, takeover },
          {
            code: "observation_failed",
            reason: notes[0] ?? "观察期复查未通过",
            sourceRef: order.id,
          },
          snapshot.now,
        ),
        order: {
          ...reviewed,
          status: "failed",
          error: clip(notes[0] ?? "观察期复查未通过"),
        },
      };
    const failedAtApply = order.fields.filter(
      (entry) => entry.outcome === "failed",
    );
    return {
      account: snapshot.account,
      order:
        failedAtApply.length > 0
          ? {
              ...reviewed,
              status: "failed",
              error: clip(
                `复查通过，但${labels(failedAtApply.map((entry) => entry.field))}在修改时没有改成`,
              ),
            }
          : { ...reviewed, status: "completed", error: null },
    };
  }

  // ─── Cancel ────────────────────────────────────────────────────────────────

  /** 「取消」 of an order no phone step has touched yet (draft, awaiting_confirm). */
  async cancel(
    orderId: string,
    input: z.input<typeof xhsOpsChangeOrderCancelBodySchema>,
  ): Promise<XhsOpsChangeOrderActionResult> {
    const body = xhsOpsChangeOrderCancelBodySchema.parse(input);
    const order = await this.requireOrder(orderId);
    const { changeOrders, account } = await this.store.mutateTakeover(
      order.accountId,
      (snapshot) => {
        const stored = snapshot.changeOrders.find(
          (entry) => entry.id === orderId,
        );
        if (!stored) throw new XhsOpsError(404, "变更单不存在");
        if (stored.updatedAt !== body.expectedUpdatedAt)
          throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
        if (stored.status !== "draft" && stored.status !== "awaiting_confirm")
          throw new XhsOpsError(
            409,
            `变更单${STATUS_LABEL[stored.status]}，不能取消`,
          );
        const closed = closeChangeOrder(snapshot.account, stored, {
          status: "cancelled",
          error: "已取消",
          now: snapshot.now,
        });
        return {
          account: closed.account,
          changeOrders: [closed.order],
          result: null,
        };
      },
    );
    return {
      order: changeOrders[0] ?? (await this.requireOrder(orderId)),
      account,
    };
  }

  // ─── Restart reconcile ─────────────────────────────────────────────────────

  /**
   * Startup reconcile (§2.6, §3.1 表二) for the orders
   * store.recoverInterruptedTakeoverWork() moved: the phone task of the
   * interrupted step is stopped when it still runs, the device held when
   * that cannot be proved, and an apply's receipt goes back to the order
   * through the profile service's ledger reconcile. Nothing is resumed.
   */
  async reconcileInterruptedOrders(
    entries: ReadonlyArray<{
      order: XhsOpsChangeOrder;
      previousStatus: "prechecking" | "applying" | "verifying";
      taskId: string | null;
    }>,
  ): Promise<XhsOpsChangeOrderReconcileOutcome[]> {
    const outcomes: XhsOpsChangeOrderReconcileOutcome[] = [];
    for (const entry of entries) {
      const taskId =
        entry.taskId && entry.taskId !== XHS_CHANGE_ORDER_TASK_PENDING
          ? entry.taskId
          : null;
      try {
        const outcome = await this.settleRestartedTask(entry.order, taskId);
        if (entry.previousStatus === "applying" && outcome !== "held")
          await this.profile.reconcile(entry.order.accountId);
        outcomes.push({ orderId: entry.order.id, outcome, taskId });
      } catch (error) {
        logger.warn(
          { orderId: entry.order.id, error: describeError(error) },
          "xhs-ops: change order reconcile failed",
        );
        let held = false;
        try {
          await this.store.holdTakeoverDevice(entry.order.accountId, {
            taskId: taskId ?? XHS_TAKEOVER_UNKNOWN_TASK_ID,
            sourceRef: entry.order.id,
          });
          held = true;
        } catch {
          // Reported as error; the caller may retry.
        }
        outcomes.push({
          orderId: entry.order.id,
          outcome: held ? "held" : "error",
          taskId,
        });
      }
    }
    return outcomes;
  }

  private async settleRestartedTask(
    order: XhsOpsChangeOrder,
    taskId: string | null,
  ): Promise<"ended" | "stopped" | "held"> {
    const device = await probeTakeoverDevice(
      this.deviceControl,
      order.deviceId,
      { now: this.now(), offlineAfterMs: this.offlineAfterMs },
    );
    if (device !== null && device !== "unknown") {
      if (taskId && device.currentTaskId === taskId) {
        if (
          await stopTakeoverPhoneTask(
            this.deviceControl,
            order.deviceId,
            taskId,
          )
        )
          return "stopped";
      } else if (
        taskId
          ? device.currentTaskId !== taskId
          : device.status === "idle" && !device.currentTaskId
      ) {
        return "ended";
      }
    }
    const held =
      taskId ??
      (device && device !== "unknown" ? (device.currentTaskId ?? null) : null);
    await this.store.holdTakeoverDevice(order.accountId, {
      taskId: held ?? XHS_TAKEOVER_UNKNOWN_TASK_ID,
      sourceRef: order.id,
    });
    logger.warn(
      { orderId: order.id, deviceId: order.deviceId, taskId: held },
      "xhs-ops: interrupted change order task unconfirmed after restart, device held",
    );
    return "held";
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private track(orderId: string, job: () => Promise<void>): void {
    const done = job().finally(() => {
      if (this.jobs.get(orderId) === done) this.jobs.delete(orderId);
    });
    this.jobs.set(orderId, done);
  }

  private async requireOrder(orderId: string): Promise<XhsOpsChangeOrder> {
    const order = await this.store.getChangeOrder(orderId);
    if (!order) throw new XhsOpsError(404, "变更单不存在");
    return order;
  }

  private async requireAccount(accountId: string): Promise<XhsOpsAccount> {
    const account = await this.store.getAccount(accountId);
    if (!account) throw new XhsOpsError(404, "账号不存在");
    return account;
  }

  /**
   * Lazy upkeep on every read and before every action: a precheck past its
   * 30 minutes goes back to draft (状态表 awaiting_confirm → draft), and a
   * review whose audit finished while nobody waited for it is decided.
   */
  private async refreshAccount(accountId: string): Promise<void> {
    const orders = await this.store.listChangeOrders({ accountId });
    const nowMs = this.now();
    if (orders.some((order) => precheckExpired(order, nowMs)))
      await this.store.mutateTakeover(accountId, (snapshot) => {
        const expired = snapshot.changeOrders.filter((order) =>
          precheckExpired(order, Date.parse(snapshot.now)),
        );
        const takeover = snapshot.account.takeover;
        return {
          account:
            takeover &&
            expired.some((order) => order.id === takeover.activeChangeOrderId)
              ? {
                  ...snapshot.account,
                  takeover: { ...takeover, activeChangeOrderId: null },
                }
              : undefined,
          changeOrders: expired.map((order) => ({
            ...order,
            status: "draft" as const,
            precheck: null,
            error: "预检已超过 30 分钟，请重新预检",
          })),
          result: null,
        };
      });
    for (const order of orders) {
      if (
        order.status === "observing" &&
        order.observation?.auditId &&
        order.observation.verdict === "pending" &&
        !this.jobs.has(order.id)
      )
        await this.settleObservation(order.id).catch((error) => {
          logger.warn(
            { orderId: order.id, error: describeError(error) },
            "xhs-ops: change order observation settle failed",
          );
        });
    }
  }

  /** The order inside a claim mutation, at the revision the request named. */
  private claimedOrder(
    current: XhsOpsStoreData,
    orderId: string,
    body: { expectedUpdatedAt: string },
  ): XhsOpsChangeOrder {
    const stored = current.changeOrders.find((entry) => entry.id === orderId);
    if (!stored) throw new XhsOpsError(404, "变更单不存在");
    if (stored.updatedAt !== body.expectedUpdatedAt)
      throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
    return stored;
  }

  /** Write the claimed order and its account into the store data, stamped. */
  private writeClaim(
    current: XhsOpsStoreData,
    now: string,
    next: { account: XhsOpsAccount; order: XhsOpsChangeOrder },
  ): { data: XhsOpsStoreData; result: XhsOpsChangeOrderActionResult } {
    const previousAccount = current.accounts.find(
      (entry) => entry.id === next.account.id,
    );
    const previousOrder = current.changeOrders.find(
      (entry) => entry.id === next.order.id,
    );
    const account: XhsOpsAccount = {
      ...next.account,
      updatedAt: bumpUpdatedAt(
        previousAccount?.updatedAt ?? next.account.updatedAt,
        now,
      ),
    };
    const order: XhsOpsChangeOrder = {
      ...next.order,
      updatedAt: bumpUpdatedAt(
        previousOrder?.updatedAt ?? next.order.updatedAt,
        now,
      ),
    };
    return {
      data: {
        ...current,
        accounts: current.accounts.map((entry) =>
          entry.id === account.id ? account : entry,
        ),
        changeOrders: current.changeOrders.map((entry) =>
          entry.id === order.id ? order : entry,
        ),
      },
      result: { order, account },
    };
  }

  /** Uploaded pictures must still be the ones the digest covers (§5.2 step 1). */
  private async verifyImages(order: XhsOpsChangeOrder): Promise<void> {
    for (const entry of order.fields) {
      if (!xhsOpsIsTakeoverImageField(entry.field)) continue;
      if (!entry.imagePath || !entry.imageSha256)
        throw new XhsOpsError(409, `请先上传${label(entry.field)}的图片`);
      const resolved = path.resolve(entry.imagePath);
      if (!resolved.startsWith(this.mediaRoot + path.sep))
        throw new XhsOpsError(409, `${label(entry.field)}的图片不在媒体目录内`);
      const bytes = await fs.readFile(resolved).catch(() => null);
      if (!bytes)
        throw new XhsOpsError(
          409,
          `${label(entry.field)}的图片文件不见了，请重新上传`,
        );
      if (
        createHash("sha256").update(bytes).digest("hex") !== entry.imageSha256
      )
        throw new XhsOpsError(
          409,
          `${label(entry.field)}的图片文件已变化，请重新上传`,
        );
    }
  }

  /** Online, enforce mode, Android 10+ for pictures, idle — or a 409 (§5.2 两条设备前提). */
  private async assertDeviceReady(
    deviceId: string,
    options: { images: boolean },
  ): Promise<void> {
    const device = await probeTakeoverDevice(this.deviceControl, deviceId, {
      now: this.now(),
      offlineAfterMs: this.offlineAfterMs,
    });
    if (device === null) throw new XhsOpsError(409, DEVICE_UNAVAILABLE);
    if (device === "unknown") throw new XhsOpsError(409, DEVICE_UNKNOWN);
    const policy = takeoverDispatchRefusal(device);
    if (policy) throw new XhsOpsError(409, policy);
    if (options.images && !xhsOpsDeviceSupportsTakeoverImages(device))
      throw new XhsOpsError(409, XHS_TAKEOVER_IMAGE_UNSUPPORTED_MESSAGE);
    if (device.status !== "idle" || device.currentTaskId)
      throw new XhsOpsError(409, DEVICE_BUSY);
  }

  /** Wait for the phone between two steps; returns why it is not ready, or null. */
  private async waitForIdle(deviceId: string): Promise<string | null> {
    const deadline = this.now() + this.idleWaitTimeoutMs;
    for (;;) {
      const device = await probeTakeoverDevice(this.deviceControl, deviceId, {
        now: this.now(),
        offlineAfterMs: this.offlineAfterMs,
      });
      if (device === null) return DEVICE_UNAVAILABLE;
      if (device !== "unknown") {
        const policy = takeoverDispatchRefusal(device);
        if (policy) return policy;
        if (device.status === "idle" && !device.currentTaskId) return null;
      }
      if (this.now() >= deadline)
        return device === "unknown" ? DEVICE_UNKNOWN : DEVICE_BUSY;
      await sleep(this.idlePollIntervalMs);
    }
  }

  /**
   * A read-only task with the single retry a POLICY_ACTION_NOT_ALLOWED earns
   * (§3.1 表二). A policy mode other than enforce stops it at once and pauses
   * the takeover (§5.2); the caller settles the order.
   */
  private async runReadOnlyTask(
    order: XhsOpsChangeOrder,
    body: DeviceExecuteTaskBody,
    onTaskId: (taskId: string) => Promise<void>,
  ): Promise<XhsOpsTakeoverPhoneOutcome> {
    const deviceId = order.deviceId;
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await runTakeoverPhoneTask(this.deviceControl, {
        deviceId,
        body,
        pollIntervalMs: this.taskIdPollIntervalMs,
        onTaskId,
        onPolicyBreach: this.policyPause(order),
      });
      if (
        attempt > 1 ||
        outcome.kind !== "result" ||
        outcome.result.needsInteraction ||
        !policyBlocked(outcome.result) ||
        (await this.waitForIdle(deviceId)) !== null
      )
        return outcome;
    }
  }

  /** onPolicyBreach of a phone step: safetyPause manual, sourceRef the order (§5.2, §6.5). */
  private policyPause(
    order: XhsOpsChangeOrder,
  ): (breach: XhsOpsTakeoverPolicyBreach) => Promise<void> {
    return async (breach) => {
      await this.store.pauseTakeover(order.accountId, {
        code: "manual",
        reason: breach.reason,
        sourceRef: order.id,
      });
    };
  }

  /**
   * The step's phone task while it runs. The one retry a
   * POLICY_ACTION_NOT_ALLOWED earns replaces the first attempt's id: a
   * restart must stop or reconcile the task that may still be running.
   */
  private async noteTaskId(
    orderId: string,
    status: "prechecking" | "verifying",
    key: "precheckTaskId" | "verificationTaskId",
    taskId: string,
  ): Promise<void> {
    await this.store.updateChangeOrder(orderId, (order) =>
      order.status === status && order[key] !== taskId
        ? { ...order, [key]: taskId }
        : order,
    );
  }

  /**
   * Stop a task that may still run; an unconfirmed stop holds the device.
   * Without the task's id, the phone's current task is ours: the step holds
   * the exclusive lock on a phone it found idle.
   */
  private async stopOrHold(
    order: XhsOpsChangeOrder,
    known: string | null,
  ): Promise<boolean> {
    const taskId = known ?? (await this.currentTaskOf(order.deviceId));
    if (await stopTakeoverPhoneTask(this.deviceControl, order.deviceId, taskId))
      return true;
    try {
      await this.store.holdTakeoverDevice(order.accountId, {
        taskId: taskId ?? XHS_TAKEOVER_UNKNOWN_TASK_ID,
        sourceRef: order.id,
      });
    } catch (error) {
      logger.warn(
        { orderId: order.id, error: describeError(error) },
        "xhs-ops: change order device hold failed",
      );
    }
    logger.warn(
      { orderId: order.id, deviceId: order.deviceId, taskId },
      "xhs-ops: change order task stop unconfirmed, device held",
    );
    return false;
  }

  private async currentTaskOf(deviceId: string): Promise<string | null> {
    try {
      const device = await this.deviceControl.getDevice(deviceId);
      return device?.status === "busy" ? (device.currentTaskId ?? null) : null;
    } catch {
      return null;
    }
  }
}
