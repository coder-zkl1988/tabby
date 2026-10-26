import path from "node:path";
import {
  type DeviceExecuteTaskBody,
  type DeviceInfo,
  type TaskResult,
  XHS_TAKEOVER_MANUAL_CHECK_AUDIT_FLAGS,
  type XhsOpsAccount,
  type XhsOpsAccountAudit,
  type XhsOpsAccountAuditedEvent,
  type XhsOpsAccountIdentity,
  type XhsOpsAuditEvidence,
  type XhsOpsAuditFlag,
  type XhsOpsAuditPartStatus,
  type XhsOpsChangeOrder,
  type XhsOpsHeaderCounts,
  type XhsOpsPreparationCode,
  type XhsOpsStoreData,
  type XhsOpsTakeoverGateResult,
  type XhsOpsTakeoverIdentityLockedEvent,
  type XhsOpsTakeoverProfileField,
  type XhsOpsTakeoverResumeResponse,
  xhsOpsAccountAuditedEvent,
  xhsOpsAuditBaselineConfirmBodySchema,
  xhsOpsAuditFlagSchema,
  xhsOpsAuditManualCheckFlags,
  xhsOpsAuditStartBodySchema,
  xhsOpsHeaderCountFlags,
  xhsOpsSameProfileText,
  type xhsOpsTakeoverIdentityConfirmBodySchema,
  xhsOpsTakeoverIdentityLockedEvent,
  xhsOpsTakeoverResumeBodySchema,
} from "@nexu/shared";
import type { z } from "zod";
import { logger } from "../lib/logger.js";
import { XhsOpsError, localDateString } from "../lib/xhs-ops-common.js";
import type {
  XhsOpsStore,
  XhsOpsTakeoverPauseInput,
} from "../store/xhs-ops-store.js";
import {
  DeviceControlRpcError,
  type DeviceControlService,
  DeviceControlTimeoutError,
  dispatchRejectionReason,
} from "./device-control-service.js";
import {
  buildTakeoverIdentityGateRequest,
  interpretPreparationResult,
  takeoverSafetyPause,
} from "./xhs-ops-preparation.js";
import {
  XHS_AUDIT_TASK_POLICY,
  XHS_OPS_DEFAULT_IDLE_POLL_MS,
  XHS_OPS_DEFAULT_IDLE_WAIT_MS,
  XHS_OPS_DEFAULT_OFFLINE_AFTER_MS,
  XHS_PACKAGE,
} from "./xhs-ops-run-service.js";
import {
  type XhsOpsTakeoverPolicyBreach,
  takeoverDispatchRefusal,
  watchTakeoverPolicyMode,
} from "./xhs-ops-takeover-phone.js";
import {
  REPORT_AUDIT_CONTRADICTED,
  XHS_AUDIT_CLICK_LIMITS,
  XHS_AUDIT_CREATOR_MARKER,
  XHS_AUDIT_HOME_MARKER,
  XHS_PROFILE_READBACK_MARKER,
  XHS_TAKEOVER_TASK_LIMITS,
  assessAuditReceipt,
  auditReceiptStatus,
  buildAccountAuditCreatorTask,
  buildAccountAuditHomeTask,
  buildTakeoverIdentityTask,
  buildTakeoverProfileReadbackTask,
  parseAccountIdentityJson,
  parseAuditCreatorJson,
  parseAuditHomeJson,
  parseTakeoverProfileReadbackJson,
} from "./xhs-ops-task-builder.js";

// 老号接管的身份读取与只读盘点（takeover design §1.2 T2–T3, §3.1, §3.2,
// §3.4, §5.2 step 8）. One audit runs three read-only phone tasks in order —
// P0 资料存档与号码核对 → A 主页与笔记 → B 创作者数据 — under the exclusive
// device lock, persisting each part as it ends. Every exception path follows
// §3.1 表二, after prepareOnDevice in the run service: a phone task that may
// still be running is stopped by its own id before anything else happens,
// and a stop nobody confirmed holds the device (takeover.deviceHold) instead
// of releasing it. The 小红书号 and the archived values never reach a log line
// or an event; xhsOpsAccountAuditedEvent decides what the agent may see.

export type XhsOpsAuditDeviceControl = Pick<
  DeviceControlService,
  "getDevice" | "executeTask" | "cancelTask"
> &
  Partial<Pick<DeviceControlService, "getTaskResults">>;

export interface XhsOpsAuditServiceOptions {
  idlePollIntervalMs?: number;
  /** How long a segment waits for the phone to turn idle before it fails. */
  idleWaitTimeoutMs?: number;
  offlineAfterMs?: number;
  /** How often a dispatched task is looked up on the device to learn its id. */
  taskIdPollIntervalMs?: number;
  /** How long cancelAudit waits for the chain to settle before answering. */
  cancelWaitMs?: number;
  now?: () => number;
}

export interface XhsOpsAuditServiceDeps {
  store: XhsOpsStore;
  deviceControl: XhsOpsAuditDeviceControl;
  options?: XhsOpsAuditServiceOptions;
}

/** Shape of POST /takeover/identity/read (xhsOpsTakeoverIdentityReadResponseSchema). */
export interface XhsOpsTakeoverIdentityReadResult {
  identity: XhsOpsAccountIdentity;
  /** pendingIdentity or deviceHold may have been written. */
  account: XhsOpsAccount;
}

export interface XhsOpsTakeoverIdentityConfirmResult {
  account: XhsOpsAccount;
  /** For the card to report via onAction; carries no 小红书号. */
  event: XhsOpsTakeoverIdentityLockedEvent;
}

export interface XhsOpsAuditStartOptions {
  /** Defaults to "takeover" before the first baseline and "manual" after it. */
  trigger?: XhsOpsAccountAudit["trigger"];
  /** The observation review this audit belongs to. */
  changeOrderId?: string | null;
  /** An observation review re-reads its order's fields in part one (§6.4). */
  readbackFields?: readonly XhsOpsTakeoverProfileField[];
}

export interface XhsOpsAuditBaselineResult {
  account: XhsOpsAccount;
  audit: XhsOpsAccountAudit;
  /** Draft and awaiting_confirm orders the new baseline changed (§5.2 step 8). */
  changeOrders: XhsOpsChangeOrder[];
  /** Public-field summary for the card to report via onAction (D6). */
  event: XhsOpsAccountAuditedEvent;
}

/** What the startup reconcile did with one interrupted audit (§3.1 表二, last row). */
export interface XhsOpsAuditReconcileOutcome {
  auditId: string;
  /**
   * recovered — the phone had finished and its receipt was read back;
   * stopped — the task was still running and is now stopped;
   * ended — nothing of the audit runs on the phone any more;
   * held — the stop could not be confirmed (or the reconcile failed), so the device is held;
   * error — the reconcile and the fallback hold both failed; retry it.
   */
  outcome: "recovered" | "stopped" | "ended" | "held" | "error";
  taskId: string | null;
}

/** Wait after a risk-control stop before another audit (§8.2 风控). */
export const XHS_AUDIT_SAFETY_STOP_COOLDOWN_MS = 24 * 3_600_000;
/** Lookback when a restarted controller hunts a receipt by marker. */
const RECOVERABLE_RECEIPT_LOOKBACK = 10;
/** Note cards part A reads at most; a receipt recovered after a restart is read with it. */
const XHS_AUDIT_MAX_NOTES = 20;
const DEFAULT_TASK_ID_POLL_MS = 2_000;
const DEFAULT_CANCEL_WAIT_MS = 40_000;
const MAX_REASON_CHARS = 200;
const MAX_EVIDENCE_WARNINGS = 10;
const POLICY_BLOCKED = "POLICY_ACTION_NOT_ALLOWED";
const IDENTITY_SOURCE_REF = "takeover-identity";
const UNKNOWN_TASK_ID = "unknown";
const DEVICE_UNAVAILABLE = "手机不在线，请确认手机已连接后重试";
const CANCELLATION_UNCONFIRMED =
  "手机任务停止未确认；请到手机上确认任务已结束，再在接管卡片解除";
const PHONE_IDENTITY_UNAVAILABLE =
  "手机上的「我」页不是个人主页（可能未登录或账号异常），或打不开编辑主页；请账号本人在手机上处理后再读取，桌面不会代为登录";
const RESUME_SOURCE_REF = "takeover-resume";
const DEVICE_UNKNOWN = "无法查询手机状态，请稍后重试";
const DEVICE_BUSY = "手机正在执行其他任务，请等它结束后再试";
const NOT_LOGGED_IN_REASON =
  "「我」页显示手机号输入页，请账号本人在手机上登录原账号，桌面不会代为登录";

/** What the resume gate tells the card for a receipt code (§6.5); fixed text only. */
const GATE_REASONS: Partial<Record<XhsOpsPreparationCode, string>> = {
  ready: "身份闸门通过：手机上登录的是锁定的小红书号",
  phone_required: NOT_LOGGED_IN_REASON,
  verification_required: "手机上需要人工验证，请账号本人在手机上处理后再恢复",
  account_mismatch:
    "手机上当前登录的不是锁定的小红书号，请账号本人在手机上切换回来后再恢复",
  account_restricted: "身份闸门发现账号异常，账号保持暂停",
  rate_limited: "身份闸门时手机提示操作频繁，账号保持暂停",
};
const GATE_FALLBACK_REASON =
  "身份闸门没有返回有效结果，请确认手机停在小红书后再恢复";

type AuditSegment = "profile" | "home" | "creator";
const AUDIT_SEGMENTS: readonly AuditSegment[] = ["profile", "home", "creator"];
const SEGMENT_LABEL: Record<AuditSegment, string> = {
  profile: "资料存档与号码核对",
  home: "主页与笔记",
  creator: "创作者数据",
};
const SEGMENT_MARKER: Record<AuditSegment, string> = {
  profile: XHS_PROFILE_READBACK_MARKER,
  home: XHS_AUDIT_HOME_MARKER,
  creator: XHS_AUDIT_CREATOR_MARKER,
};

type AuditProfilePart = NonNullable<XhsOpsAccountAudit["profile"]>;
type AuditHomePart = NonNullable<XhsOpsAccountAudit["home"]>;
type AuditCreatorPart = NonNullable<XhsOpsAccountAudit["creator"]>;
type SegmentPart =
  | { segment: "profile"; part: AuditProfilePart }
  | { segment: "home"; part: AuditHomePart }
  | { segment: "creator"; part: AuditCreatorPart };

/** Why the chain stopped before its last segment. */
interface ChainStop {
  status: "failed" | "cancelled";
  reason: string;
}

interface SegmentOutcome {
  part: SegmentPart;
  flags: XhsOpsAuditFlag[];
  stop: ChainStop | null;
  pause: XhsOpsTakeoverPauseInput | null;
}

interface AuditController {
  auditId: string;
  accountId: string;
  deviceId: string;
  platformAccountId: string;
  noteLimit: number;
  readbackFields: readonly XhsOpsTakeoverProfileField[] | undefined;
  release: () => void;
  cancelled: boolean;
  /** The phone task of the segment in flight, once known. */
  taskId: string | null;
  /** Bumped per dispatch, so a late task-id probe never writes onto the next segment. */
  dispatchSeq: number;
  /** The last dispatch whose call came back; its task id must not be written any more. */
  settledSeq: number;
  stopRequested: boolean;
  /** A stop was not confirmed: the device lock stays with takeover.deviceHold. */
  held: boolean;
  finalized: boolean;
  flags: Set<XhsOpsAuditFlag>;
  done: Promise<void>;
}

interface PhoneTaskWatch {
  deviceId: string;
  /** Set as soon as the device reports the dispatched task as current. */
  taskId: string | null;
  onTaskId?: (taskId: string) => Promise<void>;
  /** Runs at once when the phone reports a policy mode other than enforce (writes the pause). */
  onPolicyBreach: (breach: XhsOpsTakeoverPolicyBreach) => Promise<void>;
}

type PhoneTaskOutcome =
  | { kind: "result"; result: TaskResult }
  /** The dispatch provably never reached the phone. */
  | { kind: "rejected"; reason: string }
  /** The answer was lost (timeout, transport): the phone may still be working. */
  | { kind: "lost"; taskId: string | null; timedOut: boolean }
  /** The phone reported a policy mode other than enforce; the task was stopped at once (§5.2). */
  | {
      kind: "policy";
      breach: XhsOpsTakeoverPolicyBreach;
      result: TaskResult | null;
    };

type IdleCheck =
  | { ok: true }
  | {
      ok: false;
      code:
        | "device_unavailable"
        | "device_busy"
        | "policy_not_enforce"
        | "cancelled";
      error: string;
    };

const CANCELLED: ChainStop = { status: "cancelled", reason: "盘点已取消" };

/** Creator data a small or never-opened account normally lacks. */
const CREATOR_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "creator_unavailable",
  "permission_required",
]);

/** Receipt codes that end the session and pause the takeover. */
const SAFETY_STOP_CODES: Readonly<
  Record<string, { code: XhsOpsTakeoverPauseInput["code"]; reason: string }>
> = {
  rate_limited: {
    code: "rate_limited",
    reason: "只读盘点时手机提示操作频繁，盘点已中止",
  },
  account_restricted: {
    code: "account_restricted",
    reason: "只读盘点时发现账号异常，盘点已中止",
  },
  not_logged_in: {
    code: "login_required",
    reason:
      "只读盘点时「我」页显示手机号输入页，请账号本人在手机上登录原账号，桌面不会代为登录",
  },
};

const MISMATCH_PAUSE_REASON =
  "手机上当前登录的不是锁定的小红书号，请账号本人在手机上切换回来";
const MISMATCH_STOP_REASON =
  "手机上当前登录的不是锁定的小红书号，盘点已中止并丢弃读到的数据";

const FLAG_ORDER = xhsOpsAuditFlagSchema.options;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves after `promise` settles or `ms` pass, whichever is first. */
function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function clip(text: string, max = MAX_REASON_CHARS): string {
  return text.length > max ? text.slice(0, max) : text;
}

function screenshotUrl(file: string | undefined): string | null {
  const trimmed = file?.trim();
  return trimmed ? `/api/v1/media/screenshots/${path.basename(trimmed)}` : null;
}

/** "TIMEOUT: task <id> made no progress…", "NO_FIRST_STEP: device … accepted task <id> …". */
function taskIdFromError(error: unknown): string | null {
  const match = /\btask\s+([^\s,;:]+)/.exec(describe(error));
  return match?.[1] ?? null;
}

function sortFlags(flags: Iterable<XhsOpsAuditFlag>): XhsOpsAuditFlag[] {
  const set = new Set(flags);
  return FLAG_ORDER.filter((flag) => set.has(flag));
}

function policyBlocked(result: TaskResult): boolean {
  return (
    result.errorCode === POLICY_BLOCKED ||
    (!result.success && (result.message ?? "").includes(POLICY_BLOCKED))
  );
}

function userCancelled(result: TaskResult): boolean {
  return result.status === "aborted" && result.errorCode === "USER_CANCELLED";
}

/** A receipt only counts from a finished task, or one the phone's report audit downgraded (§3.4 rule 4). */
function receiptAccepted(result: TaskResult): boolean {
  return result.success || result.errorCode === REPORT_AUDIT_CONTRADICTED;
}

function readPart(status: XhsOpsAuditPartStatus | undefined): boolean {
  return status === "read" || status === "partial";
}

function blankEvidence(
  taskId: string | null,
  warnings: string[],
  finishedAt: string,
): XhsOpsAuditEvidence {
  return {
    taskId: taskId ?? "",
    finishedAt,
    screenshotUrl: null,
    receiptClicks: null,
    trusted: false,
    warnings: warnings.map((w) => clip(w)).slice(0, MAX_EVIDENCE_WARNINGS),
  };
}

/** A part with status and code only; its data is blank. */
function blankPart(
  segment: AuditSegment,
  status: XhsOpsAuditPartStatus,
  code: string,
  evidence: XhsOpsAuditEvidence | null = null,
): SegmentPart {
  const base = { status, code: clip(code, 24), evidence };
  switch (segment) {
    case "profile":
      return {
        segment,
        part: { ...base, accountMatched: false, values: null },
      };
    case "home":
      return {
        segment,
        part: {
          ...base,
          nickname: "",
          header: null,
          headerEnd: null,
          notesEnd: false,
          notes: [],
        },
      };
    case "creator":
      return {
        segment,
        part: {
          ...base,
          nickname: "",
          header: null,
          periodLabel: "",
          views: null,
          interactions: null,
          newFollowers: null,
          profileVisitors: null,
          accountStatus: "",
        },
      };
  }
}

function withPart(
  audit: XhsOpsAccountAudit,
  value: SegmentPart,
): XhsOpsAccountAudit {
  switch (value.segment) {
    case "profile":
      return { ...audit, profile: value.part };
    case "home":
      return { ...audit, home: value.part };
    case "creator":
      return { ...audit, creator: value.part };
  }
}

/** Display names may be cut off with an ellipsis or by the 24-char cap. */
function sameNickname(archived: string, shown: string): boolean {
  const full = archived.replace(/\s+/g, "");
  const raw = shown.replace(/\s+/g, "");
  const cut = raw.replace(/(…|\.{3})+$/, "");
  if (!full || !cut) return true;
  if (full === cut) return true;
  const truncated = cut !== raw || [...shown.trim()].length >= 24;
  return truncated && full.startsWith(cut);
}

/** The header reads in page order: A start, A end, B entering 「我」. */
function headerReads(audit: XhsOpsAccountAudit): XhsOpsHeaderCounts[] {
  const reads: Array<XhsOpsHeaderCounts | null | undefined> = [];
  if (audit.home && readPart(audit.home.status))
    reads.push(audit.home.header, audit.home.headerEnd);
  if (audit.creator && readPart(audit.creator.status))
    reads.push(audit.creator.header);
  return reads.filter((read): read is XhsOpsHeaderCounts => Boolean(read));
}

const DRIFT_KEYS = [
  "nickname",
  "bio",
  "occupation",
  "gender",
  "birthdayFilled",
  "region",
] as const;

/**
 * Whether the archived profile differs from the previous audit of the same
 * 小红书号 in a way no change order of ours explains (§3.2: a click-only
 * edit in 编辑主页 has no mechanical gate, so it is caught here).
 */
function profileDrifted(
  audit: XhsOpsAccountAudit,
  history: {
    audits: readonly XhsOpsAccountAudit[];
    changeOrders: readonly XhsOpsChangeOrder[];
  },
): boolean {
  const current = audit.profile?.values;
  if (!current || !audit.profile?.accountMatched) return false;
  const previous = history.audits
    .filter(
      (entry) =>
        entry.id !== audit.id &&
        entry.accountId === audit.accountId &&
        entry.platformAccountId === audit.platformAccountId &&
        !entry.flags.includes("identityStale") &&
        (entry.status === "completed" || entry.status === "partial") &&
        entry.profile?.accountMatched &&
        entry.profile.values &&
        entry.startedAt < audit.startedAt,
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const before = previous?.profile?.values;
  if (!previous || !before) return false;
  const since = Date.parse(previous.startedAt);
  return DRIFT_KEYS.some((key) => {
    const was = String(before[key]);
    const now = String(current[key]);
    // Spacing and line breaks are how the page lays a value out, not a change.
    if (xhsOpsSameProfileText(was, now)) return false;
    return !history.changeOrders.some(
      (order) =>
        order.accountId === audit.accountId &&
        order.platformAccountId === audit.platformAccountId &&
        order.applyTaskId !== null &&
        Date.parse(order.confirmedAt ?? order.updatedAt) >= since &&
        order.fields.some(
          (field) =>
            field.field === key &&
            field.outcome !== "skipped" &&
            xhsOpsSameProfileText(field.after, now),
        ),
    );
  });
}

/**
 * Flags derived from a whole audit (§3.2, §3.4 rule 4): nicknameInconsistent
 * when A or B shows another name than the archive, the graded header diff
 * over the three reads — any change of an exact following count is
 * countsChanged, an exact likes+collects rise of 1–3 possibleSelfLike,
 * followers only ever a difference — and profileDrift against the previous
 * audit. unexpectedClicks, creatorUnavailable and cancellationUnconfirmed are
 * raised while the segments run.
 */
export function auditDerivedFlags(
  audit: XhsOpsAccountAudit,
  history: {
    audits: readonly XhsOpsAccountAudit[];
    changeOrders: readonly XhsOpsChangeOrder[];
  },
): XhsOpsAuditFlag[] {
  const flags = new Set<XhsOpsAuditFlag>();
  const archived = audit.profile?.values?.nickname ?? "";
  for (const shown of [
    audit.home && readPart(audit.home.status) ? audit.home.nickname : "",
    audit.creator && readPart(audit.creator.status)
      ? audit.creator.nickname
      : "",
  ]) {
    if (!sameNickname(archived, shown)) flags.add("nicknameInconsistent");
  }
  const reads = headerReads(audit);
  const pairs: Array<[XhsOpsHeaderCounts, XhsOpsHeaderCounts]> = [];
  for (let index = 1; index < reads.length; index += 1) {
    const before = reads[index - 1];
    const after = reads[index];
    if (before && after) pairs.push([before, after]);
  }
  const first = reads[0];
  const last = reads[reads.length - 1];
  if (reads.length > 2 && first && last) pairs.push([first, last]);
  for (const [before, after] of pairs) {
    for (const flag of xhsOpsHeaderCountFlags(before, after)) flags.add(flag);
  }
  if (profileDrifted(audit, history)) flags.add("profileDrift");
  return sortFlags(flags);
}

/** A part that read what it should; small accounts normally lack creator data. */
function partComplete(
  audit: XhsOpsAccountAudit,
  segment: AuditSegment,
): boolean {
  const part = audit[segment];
  return (
    part?.status === "read" ||
    (segment === "creator" &&
      part?.status === "unavailable" &&
      CREATOR_UNAVAILABLE_CODES.has(part.code))
  );
}

/** Status of a chain that ran all three segments: partial when any part fell short. */
function chainStatus(audit: XhsOpsAccountAudit): "completed" | "partial" {
  return AUDIT_SEGMENTS.every((segment) => partComplete(audit, segment))
    ? "completed"
    : "partial";
}

function partialReason(audit: XhsOpsAccountAudit): string {
  const missing = AUDIT_SEGMENTS.filter(
    (segment) => !partComplete(audit, segment),
  ).map((segment) => SEGMENT_LABEL[segment]);
  return missing.length > 0
    ? `部分数据没有完整读到：${missing.join("、")}`
    : "";
}

function formatLocalTime(ms: number): string {
  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${localDateString(date)} ${hours}:${minutes}`;
}

/**
 * The latest risk-control stop of this account inside the last 24 hours
 * (§8.2 风控): a rate_limited / account_restricted pause, a run chunk or
 * preparation that reported one, or an audit part that did. Returns when
 * auditing may resume, or null.
 */
function safetyStopCooldownUntil(
  current: XhsOpsStoreData,
  account: XhsOpsAccount,
  nowMs: number,
): number | null {
  const isRisk = (code: string | null | undefined) =>
    code === "rate_limited" || code === "account_restricted";
  const stops: number[] = [];
  const pause = account.takeover?.safetyPause;
  if (pause && isRisk(pause.code)) stops.push(Date.parse(pause.since));
  for (const run of current.runs) {
    if (run.accountId !== account.id) continue;
    if (run.preparation && isRisk(run.preparation.reasonCode))
      stops.push(
        Date.parse(run.preparation.completedAt ?? run.preparation.startedAt),
      );
    for (const chunk of run.chunks) {
      if (chunk.anomalies.some((anomaly) => isRisk(anomaly.type)))
        stops.push(Date.parse(chunk.completedAt ?? run.updatedAt));
    }
  }
  for (const audit of current.audits) {
    if (audit.accountId !== account.id) continue;
    if (
      [audit.profile, audit.home, audit.creator].some((part) =>
        isRisk(part?.code),
      )
    )
      stops.push(Date.parse(audit.completedAt ?? audit.updatedAt));
  }
  const latest = Math.max(
    Number.NEGATIVE_INFINITY,
    ...stops.filter((at) => Number.isFinite(at)),
  );
  const until = latest + XHS_AUDIT_SAFETY_STOP_COOLDOWN_MS;
  return until > nowMs ? until : null;
}

type BaselineValues = NonNullable<AuditProfilePart["values"]>;

function baselineText(
  values: BaselineValues,
  field: XhsOpsChangeOrder["fields"][number]["field"],
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

/**
 * Re-baselining (§5.2 step 8): every draft and awaiting_confirm order of the
 * 小红书号 takes the new baseline value; an awaiting_confirm order goes back to
 * draft without its precheck; a text field the phone already shows as the
 * target leaves its order, and an order left without fields is cancelled.
 * Image fields keep their empty baseline. The confirmed plan is untouched.
 */
function rebaselineChangeOrders(
  orders: readonly XhsOpsChangeOrder[],
  account: XhsOpsAccount,
  values: BaselineValues,
  activeChangeOrderId: string | null,
): { changed: XhsOpsChangeOrder[]; activeChangeOrderId: string | null } {
  const changed: XhsOpsChangeOrder[] = [];
  let active = activeChangeOrderId;
  for (const order of orders) {
    if (
      order.accountId !== account.id ||
      order.platformAccountId !== account.platformAccountId ||
      (order.status !== "draft" && order.status !== "awaiting_confirm")
    )
      continue;
    const kept: XhsOpsChangeOrder["fields"] = [];
    const keptProposals: string[] = [];
    order.fields.forEach((entry, index) => {
      const value = baselineText(values, entry.field);
      if (value !== null && xhsOpsSameProfileText(value, entry.after)) return;
      kept.push(
        value === null || value === entry.baselineValue
          ? entry
          : { ...entry, baselineValue: value },
      );
      const proposalId = order.proposalIds[index];
      if (proposalId !== undefined) keptProposals.push(proposalId);
    });
    const next: XhsOpsChangeOrder =
      kept.length === 0
        ? {
            ...order,
            status: "cancelled",
            precheck: null,
            fields: order.fields.map((entry) => ({
              ...entry,
              note: "手机上已是目标值",
            })),
            error: "重设基线后手机上已是目标值，单子已取消",
          }
        : {
            ...order,
            status: "draft",
            precheck: null,
            fields: kept,
            proposalIds:
              order.proposalIds.length === order.fields.length
                ? keptProposals
                : order.proposalIds,
          };
    if (JSON.stringify(next) === JSON.stringify(order)) continue;
    if (active === order.id) active = null;
    changed.push(next);
  }
  return { changed, activeChangeOrderId: active };
}

function requireTakeoverAccount(
  account: XhsOpsAccount | null,
): XhsOpsAccount & { takeover: NonNullable<XhsOpsAccount["takeover"]> } {
  if (!account) throw new XhsOpsError(404, "账号不存在");
  const takeover = account.takeover;
  if (account.entryMode !== "existing" || !takeover?.authorizedAt)
    throw new XhsOpsError(409, "请先在接管卡片上授权接管该账号");
  return { ...account, takeover };
}

export class XhsOpsAuditService {
  private readonly active = new Map<string, AuditController>();
  private readonly store: XhsOpsStore;
  private readonly deviceControl: XhsOpsAuditDeviceControl;
  private readonly idlePollIntervalMs: number;
  private readonly idleWaitTimeoutMs: number;
  private readonly offlineAfterMs: number;
  private readonly taskIdPollIntervalMs: number;
  private readonly cancelWaitMs: number;
  private readonly now: () => number;

  constructor(deps: XhsOpsAuditServiceDeps) {
    this.store = deps.store;
    this.deviceControl = deps.deviceControl;
    const options = deps.options ?? {};
    this.idlePollIntervalMs =
      options.idlePollIntervalMs ?? XHS_OPS_DEFAULT_IDLE_POLL_MS;
    this.idleWaitTimeoutMs =
      options.idleWaitTimeoutMs ?? XHS_OPS_DEFAULT_IDLE_WAIT_MS;
    this.offlineAfterMs =
      options.offlineAfterMs ?? XHS_OPS_DEFAULT_OFFLINE_AFTER_MS;
    this.taskIdPollIntervalMs =
      options.taskIdPollIntervalMs ?? DEFAULT_TASK_ID_POLL_MS;
    this.cancelWaitMs = options.cancelWaitMs ?? DEFAULT_CANCEL_WAIT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  // ─── T2 identity ───────────────────────────────────────────────────────────

  /**
   * 「读取手机当前账号」 for an existing account (§1.2 T2, §3.3 身份识别接管变体,
   * N9): the read-only identity variant under XHS_AUDIT_TASK_POLICY, after
   * taking the exclusive device lock and checking the phone is idle. A
   * visible read is stored server-side as takeover.pendingIdentity, the only
   * thing a later confirm accepts. The read 小红书号 goes back to the card for
   * prefilling and nowhere else.
   */
  async readTakeoverIdentity(
    accountId: string,
  ): Promise<XhsOpsTakeoverIdentityReadResult> {
    let account = requireTakeoverAccount(
      await this.store.getAccount(accountId),
    );
    if (account.profileDraft.applyOperation?.status === "running")
      throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
    const deviceId = account.deviceId;
    if (!deviceId)
      throw new XhsOpsError(
        409,
        "该账号未绑定设备，绑定后才能读取手机上的账号",
      );
    const unavailable = (
      reason: string,
      taskId = "",
    ): XhsOpsTakeoverIdentityReadResult => ({
      identity: {
        status: "unavailable",
        screenshotUrl: null,
        accountId: "",
        taskId,
        reason,
      },
      account,
    });
    const release = await this.store.acquireExclusiveDeviceBinding(
      account.id,
      deviceId,
      { purpose: "identity" },
    );
    let held = false;
    const holdUnconfirmed = async (taskId: string | null) => {
      held = true;
      account = requireTakeoverAccount(
        await this.store.holdTakeoverDevice(account.id, {
          taskId: taskId ?? UNKNOWN_TASK_ID,
          sourceRef: IDENTITY_SOURCE_REF,
        }),
      );
      logger.warn(
        { accountId: account.id, deviceId, taskId },
        "xhs-ops: takeover identity task stop unconfirmed, device held",
      );
    };
    try {
      const ready = await this.checkIdle(deviceId, () => false, 0);
      if (!ready.ok) return unavailable(ready.error);
      const outcome = await this.runPhoneTask(
        {
          deviceId,
          taskId: null,
          onPolicyBreach: this.policyPause(account.id, IDENTITY_SOURCE_REF),
        },
        {
          task: buildTakeoverIdentityTask(),
          maxSteps: XHS_TAKEOVER_TASK_LIMITS.identity.maxSteps,
          timeout: XHS_TAKEOVER_TASK_LIMITS.identity.timeoutMs,
          allowedApps: [XHS_PACKAGE],
          taskPolicy: XHS_AUDIT_TASK_POLICY,
        },
      );
      if (outcome.kind === "rejected")
        return unavailable(clip(`任务未下发到手机：${outcome.reason}`));
      if (outcome.kind === "policy") {
        const { breach } = outcome;
        if (
          !breach.stopped &&
          !(await this.stopTask(deviceId, breach.taskId))
        ) {
          await holdUnconfirmed(breach.taskId);
          return unavailable(CANCELLATION_UNCONFIRMED, breach.taskId ?? "");
        }
        return unavailable(breach.reason, breach.taskId ?? "");
      }
      if (outcome.kind === "lost") {
        if (!(await this.stopTask(deviceId, outcome.taskId))) {
          await holdUnconfirmed(outcome.taskId);
          return unavailable(CANCELLATION_UNCONFIRMED, outcome.taskId ?? "");
        }
        return unavailable(
          outcome.timedOut
            ? "读取超时，手机任务已停止；请确认手机在线且当前没有其他任务后重试"
            : "读取执行失败，手机任务已停止；请检查手机状态后重试",
          outcome.taskId ?? "",
        );
      }
      const result = outcome.result;
      if (result.needsInteraction) {
        if (!(await this.stopTask(deviceId, result.taskId))) {
          await holdUnconfirmed(result.taskId);
          return unavailable(CANCELLATION_UNCONFIRMED, result.taskId);
        }
        return unavailable(
          "手机上出现需要人工处理的页面，任务已停止；请账号本人在手机上处理后再读取",
          result.taskId,
        );
      }
      const screenshot = screenshotUrl(result.finalScreenshot);
      if (!result.success || !screenshot)
        return unavailable(
          policyBlocked(result)
            ? "读取被手机策略拦截，请重试"
            : "没有取到编辑主页截图；请确认手机已登录小红书后重试",
          result.taskId,
        );
      const parsed = parseAccountIdentityJson(result.message);
      // The phone said it never reached the account's 编辑主页: its last
      // screenshot shows a login or error page, nothing an operator may lock.
      if (parsed?.status === "unavailable")
        return unavailable(PHONE_IDENTITY_UNAVAILABLE, result.taskId);
      const readAccountId =
        parsed?.status === "visible" ? parsed.accountId : "";
      account = requireTakeoverAccount(
        await this.store.recordTakeoverIdentityRead(account.id, {
          taskId: result.taskId,
          deviceId,
          screenshotUrl: screenshot,
          readAccountId,
        }),
      );
      logger.info(
        {
          accountId: account.id,
          taskId: result.taskId,
          idRead: readAccountId !== "",
        },
        "xhs-ops: takeover identity read",
      );
      return {
        identity: {
          status: "visible",
          screenshotUrl: screenshot,
          accountId: readAccountId,
          taskId: result.taskId,
          reason: readAccountId
            ? "已读到手机上的小红书号并填入；请对照截图确认就是这个号，再点锁定"
            : "已停在编辑主页，但没读出小红书号；请对照截图手动填写后锁定",
        },
        account,
      };
    } finally {
      if (!held) release();
    }
  }

  /** 「确认就是这个号，锁定」: the store checks the pending read; the event carries no number. */
  async confirmTakeoverIdentity(
    accountId: string,
    input: z.input<typeof xhsOpsTakeoverIdentityConfirmBodySchema>,
  ): Promise<XhsOpsTakeoverIdentityConfirmResult> {
    const account = await this.store.confirmTakeoverIdentity(accountId, input);
    logger.info(
      {
        accountId: account.id,
        identitySource: account.takeover?.identitySource,
      },
      "xhs-ops: takeover identity locked",
    );
    return { account, event: xhsOpsTakeoverIdentityLockedEvent(account) };
  }

  // ─── §6.5 resume ───────────────────────────────────────────────────────────

  /**
   * 「恢复」 (§6.5) in two steps. store.assertTakeoverResumable decides whether
   * the pause may lift now — no device hold, the written reason rate_limited,
   * account_restricted and observation_failed need, the 48-hour cooldown — and
   * whether the identity gate must report ready first. The cooldown codes
   * lift at once; every other code runs the takeover identity gate on the
   * phone (read-only, login forbidden) and lifts only on ready. A gate that
   * found a reason of its own to stay paused records it as the pause. Every
   * lift lands in takeover.resumeHistory with the written reason.
   */
  async resumeTakeover(
    accountId: string,
    input: z.input<typeof xhsOpsTakeoverResumeBodySchema>,
  ): Promise<XhsOpsTakeoverResumeResponse> {
    const body = xhsOpsTakeoverResumeBodySchema.parse(input);
    const check = await this.store.assertTakeoverResumable(accountId, body);
    const pauseSince = check.pause.since;
    if (!check.gateRequired) {
      const account = await this.store.resumeTakeover(accountId, {
        pauseSince,
        reason: body.reason,
        gateReady: null,
      });
      logger.info(
        { accountId, code: check.pause.code },
        "xhs-ops: takeover resumed after its cooldown",
      );
      return { account, resumed: true, gate: null };
    }
    const gate = await this.runResumeGate(check.account);
    if (gate.status !== "ready") {
      logger.info(
        {
          accountId,
          code: check.pause.code,
          gateCode: gate.code,
          taskId: gate.taskId,
        },
        "xhs-ops: takeover stays paused, identity gate not ready",
      );
      return {
        account: requireTakeoverAccount(await this.store.getAccount(accountId)),
        resumed: false,
        gate,
      };
    }
    const account = await this.store.resumeTakeover(accountId, {
      pauseSince,
      reason: body.reason,
      gateReady: true,
      gateTaskId: gate.taskId,
    });
    logger.info(
      { accountId, code: check.pause.code, taskId: gate.taskId },
      "xhs-ops: takeover resumed after the identity gate",
    );
    return { account, resumed: true, gate };
  }

  /**
   * The takeover identity gate (§3.1 接管身份闸门) for a resume: the phone
   * online, in enforce mode and idle, then the exclusive device lock, then
   * buildTakeoverIdentityGateRequest against the locked 小红书号. A task that
   * may still run is stopped by its own id; a stop nobody confirmed holds the
   * device and keeps the lock (§3.1 表二). Preconditions answer 409; a gate
   * that ran answers with its result.
   */
  private async runResumeGate(
    account: XhsOpsAccount,
  ): Promise<XhsOpsTakeoverGateResult> {
    const deviceId = account.deviceId;
    if (!deviceId)
      throw new XhsOpsError(409, "该账号未绑定设备，绑定后才能恢复");
    const platformAccountId = account.platformAccountId.trim();
    if (!platformAccountId)
      throw new XhsOpsError(409, "请先读取并锁定手机上的小红书号，再恢复");
    if (account.profileDraft.applyOperation?.status === "running")
      throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
    const device = await this.probeDevice(deviceId);
    if (device === null) throw new XhsOpsError(409, DEVICE_UNAVAILABLE);
    if (device === "unknown") throw new XhsOpsError(409, DEVICE_UNKNOWN);
    const policy = takeoverDispatchRefusal(device);
    if (policy) throw new XhsOpsError(409, policy);
    if (device.status !== "idle" || device.currentTaskId)
      throw new XhsOpsError(409, DEVICE_BUSY);
    const release = await this.store.acquireExclusiveDeviceBinding(
      account.id,
      deviceId,
      { purpose: "identity" },
    );
    let held = false;
    const stopOrHold = async (taskId: string | null): Promise<boolean> => {
      if (await this.stopTask(deviceId, taskId)) return true;
      held = true;
      await this.store.holdTakeoverDevice(account.id, {
        taskId: taskId ?? UNKNOWN_TASK_ID,
        sourceRef: RESUME_SOURCE_REF,
      });
      logger.warn(
        { accountId: account.id, deviceId, taskId },
        "xhs-ops: takeover resume gate stop unconfirmed, device held",
      );
      return false;
    };
    try {
      const outcome = await this.runPhoneTask(
        {
          deviceId,
          taskId: null,
          onPolicyBreach: this.policyPause(account.id, RESUME_SOURCE_REF),
        },
        buildTakeoverIdentityGateRequest(XHS_PACKAGE, platformAccountId),
      );
      if (outcome.kind === "rejected")
        return {
          status: "failed",
          code: "dispatch_failed",
          reason: clip(`身份闸门任务未下发到手机：${outcome.reason}`),
          taskId: null,
        };
      if (outcome.kind === "policy")
        return {
          status: "failed",
          code: "policy_not_enforce",
          reason:
            outcome.breach.stopped || (await stopOrHold(outcome.breach.taskId))
              ? outcome.breach.reason
              : CANCELLATION_UNCONFIRMED,
          taskId: outcome.breach.taskId ?? outcome.result?.taskId ?? null,
        };
      if (outcome.kind === "lost")
        return {
          status: "failed",
          code: "dispatch_failed",
          reason: !(await stopOrHold(outcome.taskId))
            ? CANCELLATION_UNCONFIRMED
            : outcome.timedOut
              ? "身份闸门超时，手机任务已停止；请确认手机在线且当前没有其他任务后再恢复"
              : "身份闸门执行失败，手机任务已停止；请检查手机状态后再恢复",
          taskId: outcome.taskId,
        };
      const result = outcome.result;
      if (result.needsInteraction)
        return {
          status: "blocked",
          code: "verification_required",
          reason: !(await stopOrHold(result.taskId))
            ? CANCELLATION_UNCONFIRMED
            : "手机上出现需要人工处理的页面，闸门任务已停止；请账号本人在手机上处理后再恢复",
          taskId: result.taskId,
        };
      const receipt = interpretPreparationResult(result);
      const code = receipt.reasonCode ?? "invalid_result";
      const status =
        receipt.status === "ready" || receipt.status === "blocked"
          ? receipt.status
          : "failed";
      const pause =
        status === "ready" ? null : takeoverSafetyPause(code, "resume");
      if (status === "ready") {
        // §3.2 点击对账 of the gate: a hint for the log, never a refusal.
        const trust = assessAuditReceipt(result, {
          packageName: XHS_PACKAGE,
          clickLimit: XHS_AUDIT_CLICK_LIMITS.gate,
        });
        if (trust.unexpectedClicks || trust.contradicted)
          logger.warn(
            {
              accountId: account.id,
              taskId: result.taskId,
              receiptClicks: trust.receiptClicks,
              contradicted: trust.contradicted,
            },
            "xhs-ops: resume gate receipt needs a look",
          );
      }
      if (pause) {
        try {
          await this.store.pauseTakeover(account.id, {
            ...pause,
            sourceRef: RESUME_SOURCE_REF,
          });
        } catch (error) {
          logger.warn(
            { accountId: account.id, error: describe(error) },
            "xhs-ops: takeover pause from the resume gate failed",
          );
        }
      }
      return {
        status,
        code,
        reason: GATE_REASONS[code] ?? GATE_FALLBACK_REASON,
        taskId: result.taskId,
      };
    } finally {
      if (!held) release();
    }
  }

  // ─── T3 audit ──────────────────────────────────────────────────────────────

  async listAudits(accountId: string): Promise<XhsOpsAccountAudit[]> {
    return this.store.listAudits({ accountId });
  }

  async getAudit(auditId: string): Promise<XhsOpsAccountAudit> {
    const audit = await this.store.getAudit(auditId);
    if (!audit) throw new XhsOpsError(404, "盘点记录不存在");
    return audit;
  }

  /** Resolves once the chain of `auditId` in this process has settled (immediately if none). */
  async waitForAudit(auditId: string): Promise<void> {
    await this.active.get(auditId)?.done;
  }

  /**
   * 「开始只读盘点」 (T3): the phone must be idle now, then one store mutation
   * checks binding and unfinished device work — planned runs included —,
   * creates the running audit and takes the exclusive lock (§2.5, N3). The
   * three segments run in the background; the card polls getAudit.
   */
  async startAudit(
    accountId: string,
    input: z.input<typeof xhsOpsAuditStartBodySchema> = {},
    options: XhsOpsAuditStartOptions = {},
  ): Promise<XhsOpsAccountAudit> {
    const body = xhsOpsAuditStartBodySchema.parse(input);
    const account = requireTakeoverAccount(
      await this.store.getAccount(accountId),
    );
    const platformAccountId = account.platformAccountId.trim();
    if (!account.takeover.identityConfirmedAt || !platformAccountId)
      throw new XhsOpsError(409, "请先读取并锁定手机上的小红书号，再开始盘点");
    const deviceId = account.deviceId;
    if (!deviceId)
      throw new XhsOpsError(409, "该账号未绑定设备，绑定后才能盘点");
    const ready = await this.checkIdle(deviceId, () => false, 0);
    if (!ready.ok) throw new XhsOpsError(409, ready.error);
    const { audit, release } = await this.store.startAudit(
      {
        projectId: account.projectId,
        accountId: account.id,
        deviceId,
        platformAccountId,
        trigger:
          options.trigger ??
          (account.takeover.baselineAuditId ? "manual" : "takeover"),
        changeOrderId: options.changeOrderId ?? null,
      },
      {
        validate: (current, latest) => {
          const takeover = latest.takeover;
          if (latest.entryMode !== "existing" || !takeover?.authorizedAt)
            throw new XhsOpsError(409, "请先在接管卡片上授权接管该账号");
          if (
            !takeover.identityConfirmedAt ||
            latest.platformAccountId.trim() !== platformAccountId
          )
            throw new XhsOpsError(409, "小红书号锁定已变化，请刷新后重试");
          if (latest.profileDraft.applyOperation?.status === "running")
            throw new XhsOpsError(
              409,
              "账号资料正在应用到手机，请等待任务结束",
            );
          const until = safetyStopCooldownUntil(current, latest, this.now());
          if (until !== null)
            throw new XhsOpsError(
              409,
              `24 小时内出现过风控安全停止（操作频繁或账号异常），请在 ${formatLocalTime(until)} 之后再盘点`,
            );
        },
      },
    );
    const controller: AuditController = {
      auditId: audit.id,
      accountId: account.id,
      deviceId,
      platformAccountId,
      noteLimit: body.noteLimit,
      readbackFields: options.readbackFields,
      release,
      cancelled: false,
      taskId: null,
      dispatchSeq: 0,
      settledSeq: 0,
      stopRequested: false,
      held: false,
      finalized: false,
      flags: new Set(),
      done: Promise.resolve(),
    };
    this.active.set(audit.id, controller);
    controller.done = this.execute(controller).finally(() => {
      this.active.delete(audit.id);
    });
    logger.info(
      { auditId: audit.id, accountId: account.id, deviceId },
      "xhs-ops: takeover audit started",
    );
    return audit;
  }

  /**
   * 「取消盘点」: no further segment is dispatched, and the one on the phone
   * is stopped by its own id. The lock goes back only once the phone
   * confirmed the stop; an unconfirmed stop holds the device and closes the
   * audit as cancelled with cancellationUnconfirmed (§3.1 表二).
   */
  async cancelAudit(auditId: string): Promise<XhsOpsAccountAudit> {
    const audit = await this.getAudit(auditId);
    if (audit.status !== "running")
      throw new XhsOpsError(409, "盘点已结束，无需取消");
    const controller = this.active.get(auditId);
    if (!controller)
      throw new XhsOpsError(
        409,
        "这次盘点不在当前桌面进程里执行，请等待恢复检查完成后再处理",
      );
    controller.cancelled = true;
    await this.stopForCancel(controller);
    // An unconfirmed stop closed the audit already; its call may never return.
    if (!controller.finalized)
      await waitAtMost(controller.done, this.cancelWaitMs);
    logger.info(
      { auditId, accountId: audit.accountId },
      "xhs-ops: takeover audit cancel requested",
    );
    return this.getAudit(auditId);
  }

  /**
   * 「数据核对无误，设为基线」 (T3): only the account's latest finished audit
   * whose 号码核对 matched the current lock. unexpectedClicks, countsChanged,
   * possibleSelfLike and profileDrift need 「已人工检查」 first. Re-baselining
   * syncs the open change orders in the same mutation (§5.2 step 8).
   */
  async confirmBaseline(
    auditId: string,
    input: z.input<typeof xhsOpsAuditBaselineConfirmBodySchema> = {},
  ): Promise<XhsOpsAuditBaselineResult> {
    const body = xhsOpsAuditBaselineConfirmBodySchema.parse(input);
    const stored = await this.getAudit(auditId);
    const { account, audits, changeOrders, result } =
      await this.store.mutateTakeover(stored.accountId, (snapshot) => {
        const current = snapshot.account;
        const takeover = current.takeover;
        if (current.entryMode !== "existing" || !takeover?.authorizedAt)
          throw new XhsOpsError(409, "请先在接管卡片上授权接管该账号");
        const audit = snapshot.audits.find((entry) => entry.id === auditId);
        if (!audit) throw new XhsOpsError(404, "盘点记录不存在");
        if (snapshot.audits.some((entry) => entry.status === "running"))
          throw new XhsOpsError(409, "只读盘点进行中，请等它结束");
        if (audit.status !== "completed" && audit.status !== "partial")
          throw new XhsOpsError(409, "只有已完成的盘点才能设为基线");
        const values =
          audit.profile &&
          readPart(audit.profile.status) &&
          audit.profile.accountMatched
            ? audit.profile.values
            : null;
        if (!values)
          throw new XhsOpsError(
            409,
            "这次盘点没有完成号码核对和资料存档，不能设为基线",
          );
        if (
          !takeover.identityConfirmedAt ||
          audit.flags.includes("identityStale") ||
          audit.platformAccountId !== current.platformAccountId ||
          audit.deviceId !== current.deviceId
        )
          throw new XhsOpsError(
            409,
            "盘点之后小红书号或设备已变化，请重新盘点",
          );
        if (takeover.latestAuditId !== audit.id)
          throw new XhsOpsError(409, "只能把最近一次盘点设为基线，请重新盘点");
        const warnings = xhsOpsAuditManualCheckFlags(audit.flags).map(
          (flag) => XHS_TAKEOVER_MANUAL_CHECK_AUDIT_FLAGS.get(flag) ?? flag,
        );
        if (warnings.length > 0 && !audit.manualCheckAt && !body.manualChecked)
          throw new XhsOpsError(
            409,
            `盘点有告警（${warnings.join("、")}），请先到手机上人工检查，再勾选「已人工检查」`,
          );
        const checked =
          warnings.length > 0 && !audit.manualCheckAt
            ? { ...audit, manualCheckAt: snapshot.now }
            : audit;
        const rebased = rebaselineChangeOrders(
          snapshot.changeOrders,
          current,
          values,
          takeover.activeChangeOrderId,
        );
        return {
          account: {
            ...current,
            takeover: {
              ...takeover,
              baselineAuditId: audit.id,
              activeChangeOrderId: rebased.activeChangeOrderId,
            },
          },
          audits: checked === audit ? [] : [checked],
          changeOrders: rebased.changed,
          result: checked,
        };
      });
    const audit = audits[0] ?? result;
    logger.info(
      {
        auditId,
        accountId: account.id,
        rebasedOrders: changeOrders.length,
      },
      "xhs-ops: takeover baseline confirmed",
    );
    return {
      account,
      audit,
      changeOrders,
      event: xhsOpsAccountAuditedEvent({ account, audit, baseline: true }),
    };
  }

  /**
   * Startup reconcile (§2.6, §3.1 表二, last row) for the audits
   * store.recoverInterruptedTakeoverWork() just marked interrupted: the
   * interrupted segment's task is looked up by activeTaskId — finished, its
   * receipt is read back; still running, it is stopped; neither provable, the
   * device is held. Nothing is resumed.
   */
  async reconcileInterruptedAudits(
    audits: readonly XhsOpsAccountAudit[],
  ): Promise<XhsOpsAuditReconcileOutcome[]> {
    const outcomes: XhsOpsAuditReconcileOutcome[] = [];
    for (const audit of audits) {
      if (audit.status !== "interrupted" || this.active.has(audit.id)) continue;
      try {
        outcomes.push(await this.reconcileAudit(audit));
      } catch (error) {
        logger.warn(
          { auditId: audit.id, error: describe(error) },
          "xhs-ops: takeover audit reconcile failed",
        );
        // Nothing proved the phone task ended, and after a restart no
        // in-memory lock is left: hold the device as for an unconfirmed stop.
        let held = false;
        try {
          await this.holdInterrupted(audit, audit.activeTaskId);
          held = true;
        } catch (holdError) {
          logger.warn(
            { auditId: audit.id, error: describe(holdError) },
            "xhs-ops: takeover device hold after a failed reconcile failed",
          );
        }
        outcomes.push({
          auditId: audit.id,
          outcome: held ? "held" : "error",
          taskId: audit.activeTaskId,
        });
      }
    }
    return outcomes;
  }

  // ─── Chain ─────────────────────────────────────────────────────────────────

  private async execute(controller: AuditController): Promise<void> {
    let stop: ChainStop | null = null;
    try {
      for (const segment of AUDIT_SEGMENTS) {
        if (controller.finalized) return;
        if (controller.cancelled) {
          stop = CANCELLED;
          break;
        }
        stop = await this.runSegment(controller, segment);
        if (stop) break;
      }
    } catch (error) {
      logger.warn(
        { auditId: controller.auditId, error: describe(error) },
        "xhs-ops: takeover audit chain failed",
      );
      stop = {
        status: "failed",
        reason: clip(`盘点执行出错：${describe(error)}`),
      };
    }
    try {
      await this.finalize(controller, stop);
    } catch (error) {
      logger.warn(
        { auditId: controller.auditId, error: describe(error) },
        "xhs-ops: takeover audit finalize failed",
      );
    }
  }

  private segmentBody(
    controller: AuditController,
    segment: AuditSegment,
  ): DeviceExecuteTaskBody {
    const fields = controller.readbackFields;
    const { task, limits } =
      segment === "profile"
        ? {
            task: buildTakeoverProfileReadbackTask(
              controller.platformAccountId,
              fields,
            ),
            limits:
              fields === undefined
                ? XHS_TAKEOVER_TASK_LIMITS.profileArchive
                : XHS_TAKEOVER_TASK_LIMITS.precheck,
          }
        : segment === "home"
          ? {
              task: buildAccountAuditHomeTask(controller.noteLimit),
              limits: XHS_TAKEOVER_TASK_LIMITS.auditHome,
            }
          : {
              task: buildAccountAuditCreatorTask(),
              limits: XHS_TAKEOVER_TASK_LIMITS.auditCreator,
            };
    return {
      task,
      maxSteps: limits.maxSteps,
      timeout: limits.timeoutMs,
      allowedApps: [XHS_PACKAGE],
      taskPolicy: XHS_AUDIT_TASK_POLICY,
    };
  }

  /** One segment, with the single retry a POLICY_ACTION_NOT_ALLOWED earns (§3.1 表二). */
  private async runSegment(
    controller: AuditController,
    segment: AuditSegment,
  ): Promise<ChainStop | null> {
    const warnings: string[] = [];
    const fail = (reason: string): ChainStop => ({
      status: "failed",
      reason: clip(`${SEGMENT_LABEL[segment]}：${reason}`),
    });
    /** Write a part without data and end the chain. */
    const end = async (
      status: XhsOpsAuditPartStatus,
      code: string,
      evidence: XhsOpsAuditEvidence | null,
      stop: ChainStop,
    ): Promise<ChainStop> => {
      await this.writePart(
        controller,
        blankPart(segment, status, code, evidence),
      );
      return stop;
    };
    for (let attempt = 1; ; attempt += 1) {
      const idle = await this.checkIdle(
        controller.deviceId,
        () => controller.cancelled,
        this.idleWaitTimeoutMs,
      );
      if (!idle.ok)
        return idle.code === "cancelled"
          ? end("cancelled", "cancelled", null, CANCELLED)
          : end("failed", idle.code, null, fail(idle.error));
      const seq = ++controller.dispatchSeq;
      controller.taskId = null;
      controller.stopRequested = false;
      await this.writePart(controller, blankPart(segment, "running", ""));
      if (controller.cancelled)
        return end("cancelled", "cancelled", null, CANCELLED);
      const outcome = await this.runPhoneTask(
        {
          deviceId: controller.deviceId,
          taskId: null,
          onTaskId: (taskId) => this.noteTaskId(controller, seq, taskId),
          onPolicyBreach: this.policyPause(
            controller.accountId,
            controller.auditId,
          ),
        },
        this.segmentBody(controller, segment),
      );
      controller.settledSeq = seq;
      // A cancel whose stop went unconfirmed already closed the audit.
      if (controller.finalized) return null;
      const now = this.nowIso();
      if (outcome.kind === "rejected")
        return end(
          "failed",
          "dispatch_rejected",
          blankEvidence(null, [outcome.reason], now),
          fail(`任务未下发到手机（${outcome.reason}）`),
        );
      if (outcome.kind === "policy") {
        const { breach } = outcome;
        const taskId =
          breach.taskId ?? outcome.result?.taskId ?? controller.taskId;
        return end(
          "failed",
          "policy_not_enforce",
          outcome.result
            ? this.evidence(outcome.result, segment, [
                ...warnings,
                breach.reason,
              ]).evidence
            : blankEvidence(taskId, [breach.reason], now),
          breach.stopped || (await this.stopOrHold(controller, taskId))
            ? fail(breach.reason)
            : { status: "failed", reason: CANCELLATION_UNCONFIRMED },
        );
      }
      if (outcome.kind === "lost") {
        const taskId = outcome.taskId ?? controller.taskId;
        const what = outcome.timedOut ? "超时" : "连接中断";
        return end(
          "failed",
          outcome.timedOut ? "timeout" : "device_unavailable",
          blankEvidence(taskId, [`手机任务${what}`], now),
          (await this.stopOrHold(controller, taskId))
            ? fail(`手机任务${what}，已停止，未继续后续段`)
            : { status: "failed", reason: CANCELLATION_UNCONFIRMED },
        );
      }
      const result = outcome.result;
      controller.taskId = result.taskId;
      if (result.needsInteraction)
        return end(
          "failed",
          "needs_interaction",
          blankEvidence(result.taskId, ["手机请求人工处理（CALL_USER）"], now),
          (await this.stopOrHold(controller, result.taskId))
            ? fail("手机出现需要人工处理的页面，任务已停止，未继续后续段")
            : { status: "failed", reason: CANCELLATION_UNCONFIRMED },
        );
      if (userCancelled(result))
        return end(
          "cancelled",
          "cancelled",
          this.evidence(result, segment, warnings).evidence,
          controller.cancelled
            ? CANCELLED
            : { status: "cancelled", reason: "手机上的盘点任务被取消" },
        );
      if (policyBlocked(result)) {
        if (attempt === 1 && !controller.cancelled) {
          warnings.push(
            `第一次执行被手机策略拦截（${POLICY_BLOCKED}），已重试一次`,
          );
          continue;
        }
        return end(
          "failed",
          "policy_blocked",
          this.evidence(result, segment, warnings).evidence,
          fail("手机策略拦截了未放行的动作，重试后仍失败"),
        );
      }
      const interpreted = this.interpret(segment, result, {
        noteLimit: controller.noteLimit,
        warnings,
      });
      for (const flag of interpreted.flags) controller.flags.add(flag);
      await this.writePart(controller, interpreted.part);
      if (interpreted.pause)
        await this.pause(
          controller.accountId,
          controller.auditId,
          interpreted.pause,
        );
      logger.info(
        {
          auditId: controller.auditId,
          segment,
          status: interpreted.part.part.status,
          code: interpreted.part.part.code,
        },
        "xhs-ops: takeover audit segment finished",
      );
      return interpreted.stop ?? (controller.cancelled ? CANCELLED : null);
    }
  }

  /** Stop a task that may still run; an unconfirmed stop holds the device. */
  private async stopOrHold(
    controller: AuditController,
    taskId: string | null,
  ): Promise<boolean> {
    const stopped = await this.stopTask(controller.deviceId, taskId);
    if (!stopped) await this.hold(controller, taskId);
    return stopped;
  }

  /** The phone reported the dispatched task: persist its id (§3.1 表二) and stop it if a cancel is waiting. */
  private async noteTaskId(
    controller: AuditController,
    seq: number,
    taskId: string,
  ): Promise<void> {
    const current = () =>
      seq === controller.dispatchSeq &&
      seq > controller.settledSeq &&
      !controller.finalized;
    if (!current()) return;
    controller.taskId = taskId;
    // Checked again inside the mutation: the result may have come back and
    // its part been written while this write waited in the queue.
    await this.store.updateAudit(controller.auditId, (audit) =>
      current() && audit.status === "running" && audit.activeTaskId === null
        ? { ...audit, activeTaskId: taskId }
        : audit,
    );
    if (controller.cancelled && current()) await this.stopForCancel(controller);
  }

  private async stopForCancel(controller: AuditController): Promise<void> {
    const taskId = controller.taskId;
    // Only a task still in flight: a finished one needs no stop.
    if (
      !taskId ||
      controller.stopRequested ||
      controller.finalized ||
      controller.dispatchSeq <= controller.settledSeq
    )
      return;
    controller.stopRequested = true;
    // Confirmed: the in-flight call comes back USER_CANCELLED and the chain
    // closes the audit and gives the lock back itself.
    if (await this.stopTask(controller.deviceId, taskId)) return;
    await this.hold(controller, taskId);
    await this.finalize(controller, {
      status: "cancelled",
      reason: `盘点已取消，但${CANCELLATION_UNCONFIRMED}`,
    });
  }

  private async writePart(
    controller: AuditController,
    value: SegmentPart,
  ): Promise<void> {
    if (controller.finalized) return;
    // A new segment starts without a task id and an ended one drops it; only
    // noteTaskId sets it while a task is in flight.
    await this.store.updateAudit(controller.auditId, (audit) =>
      audit.status !== "running"
        ? audit
        : { ...withPart(audit, value), activeTaskId: null },
    );
  }

  private async hold(
    controller: AuditController,
    taskId: string | null,
  ): Promise<void> {
    controller.held = true;
    controller.flags.add("cancellationUnconfirmed");
    try {
      await this.store.holdTakeoverDevice(controller.accountId, {
        taskId: taskId ?? UNKNOWN_TASK_ID,
        sourceRef: controller.auditId,
      });
    } catch (error) {
      logger.warn(
        { auditId: controller.auditId, error: describe(error) },
        "xhs-ops: takeover device hold failed",
      );
    }
    logger.warn(
      { auditId: controller.auditId, deviceId: controller.deviceId, taskId },
      "xhs-ops: takeover audit task stop unconfirmed, device held",
    );
  }

  private async pause(
    accountId: string,
    auditId: string,
    input: XhsOpsTakeoverPauseInput,
  ): Promise<void> {
    try {
      await this.store.pauseTakeover(accountId, {
        ...input,
        sourceRef: auditId,
      });
      logger.warn(
        { auditId, accountId, code: input.code },
        "xhs-ops: takeover paused by audit",
      );
    } catch (error) {
      logger.warn(
        { auditId, error: describe(error) },
        "xhs-ops: takeover pause from audit failed",
      );
    }
  }

  /**
   * Close the audit once: parts never reached become skipped, one still
   * running takes the stop's status, the derived flags join those raised on
   * the way, and a completed or partial audit of the current lock becomes
   * takeover.latestAuditId — the anchor a diagnosis and the baseline need.
   * The device lock is given back unless a hold keeps it.
   */
  private async finalize(
    controller: AuditController,
    stop: ChainStop | null,
  ): Promise<void> {
    if (controller.finalized) return;
    controller.finalized = true;
    try {
      const now = this.nowIso();
      const { result } = await this.store.mutateTakeover(
        controller.accountId,
        (snapshot) => {
          const audit = snapshot.audits.find(
            (entry) => entry.id === controller.auditId,
          );
          if (!audit || audit.status !== "running") return { result: null };
          let closed = audit;
          for (const segment of AUDIT_SEGMENTS) {
            const part = closed[segment];
            if (!part)
              closed = withPart(
                closed,
                blankPart(segment, "skipped", "skipped"),
              );
            else if (part.status === "running")
              closed = withPart(
                closed,
                blankPart(
                  segment,
                  stop?.status === "cancelled" ? "cancelled" : "failed",
                  stop?.status === "cancelled" ? "cancelled" : "interrupted",
                  part.evidence,
                ),
              );
          }
          const derived = auditDerivedFlags(closed, snapshot);
          const flags = sortFlags([
            ...closed.flags,
            ...controller.flags,
            ...derived,
          ]);
          const status = stop ? stop.status : chainStatus(closed);
          closed = {
            ...closed,
            status,
            reason: clip(stop?.reason ?? partialReason(closed)),
            // A held task's id lives on takeover.deviceHold.
            activeTaskId: null,
            flags,
            completedAt: now,
          };
          const takeover = snapshot.account.takeover;
          const anchor =
            (status === "completed" || status === "partial") &&
            takeover !== null &&
            !flags.includes("identityStale") &&
            closed.platformAccountId === snapshot.account.platformAccountId &&
            closed.deviceId === snapshot.account.deviceId;
          return {
            audits: [closed],
            account:
              anchor && takeover
                ? {
                    ...snapshot.account,
                    takeover: { ...takeover, latestAuditId: closed.id },
                  }
                : undefined,
            result: closed,
          };
        },
      );
      if (result)
        logger.info(
          {
            auditId: result.id,
            accountId: result.accountId,
            status: result.status,
            flags: result.flags,
          },
          "xhs-ops: takeover audit finished",
        );
    } finally {
      if (!controller.held) controller.release();
    }
  }

  // ─── Receipts ──────────────────────────────────────────────────────────────

  private evidence(
    result: TaskResult,
    segment: AuditSegment,
    warnings: readonly string[],
  ): { evidence: XhsOpsAuditEvidence; unexpectedClicks: boolean } {
    const trust = assessAuditReceipt(result, {
      packageName: XHS_PACKAGE,
      clickLimit:
        segment === "profile"
          ? XHS_AUDIT_CLICK_LIMITS.profileArchive
          : segment === "home"
            ? XHS_AUDIT_CLICK_LIMITS.auditHome
            : XHS_AUDIT_CLICK_LIMITS.auditCreator,
    });
    return {
      evidence: {
        taskId: result.taskId,
        finishedAt: this.nowIso(),
        screenshotUrl: screenshotUrl(result.finalScreenshot),
        receiptClicks: trust.receiptClicks,
        trusted: trust.trusted,
        warnings: [...warnings, ...trust.warnings]
          .map((warning) => clip(warning))
          .slice(0, MAX_EVIDENCE_WARNINGS),
      },
      unexpectedClicks: trust.unexpectedClicks,
    };
  }

  /** A finished task's receipt mapped onto its part (§3.4). */
  private interpret(
    segment: AuditSegment,
    result: TaskResult,
    context: { noteLimit: number; warnings: readonly string[] },
  ): SegmentOutcome {
    const { evidence, unexpectedClicks } = this.evidence(
      result,
      segment,
      context.warnings,
    );
    const flags: XhsOpsAuditFlag[] = unexpectedClicks
      ? ["unexpectedClicks"]
      : [];
    const failed = (code: string, stop: ChainStop | null): SegmentOutcome => ({
      part: blankPart(segment, "failed", code, evidence),
      flags,
      stop,
      pause: null,
    });
    const unreadReason = `${SEGMENT_LABEL[segment]}没有返回可用回执`;
    if (segment === "profile") {
      const receipt = parseTakeoverProfileReadbackJson(result.message);
      if (receipt?.status === "read" && !receipt.accountMatched)
        return {
          // Discard everything read off another account, screenshot included.
          part: blankPart(segment, "failed", "account_mismatch", {
            ...evidence,
            screenshotUrl: null,
          }),
          flags: [],
          stop: { status: "failed", reason: MISMATCH_STOP_REASON },
          pause: { code: "account_mismatch", reason: MISMATCH_PAUSE_REASON },
        };
      // Identity is checked in part one only: without it A and B never run.
      if (!receiptAccepted(result))
        return failed("task_failed", {
          status: "failed",
          reason: "资料存档任务没有正常结束，盘点已中止",
        });
      if (!receipt)
        return failed("invalid_receipt", {
          status: "failed",
          reason: `${unreadReason}，盘点已中止`,
        });
      if (receipt.status === "unavailable")
        return {
          part: blankPart(segment, "unavailable", "unavailable", evidence),
          flags,
          stop: {
            status: "failed",
            reason: "「我」页显示手机号输入页或编辑主页打不开，盘点已中止",
          },
          pause: null,
        };
      return {
        part: {
          segment,
          part: {
            status: auditReceiptStatus("read", result.errorCode),
            code: "ok",
            evidence,
            accountMatched: true,
            values: receipt.values,
          },
        },
        flags,
        stop: null,
        pause: null,
      };
    }
    // A risk code ends the session whatever else the receipt says; otherwise
    // A or B going wrong is no safety signal and the chain goes on (§3.1 表二).
    const settle = (code: string | undefined): SegmentOutcome | null => {
      const safety = code === undefined ? undefined : SAFETY_STOP_CODES[code];
      if (code !== undefined && safety)
        return {
          part: blankPart(segment, "unavailable", code, evidence),
          flags,
          stop: { status: "failed", reason: safety.reason },
          pause: safety,
        };
      if (!receiptAccepted(result)) return failed("task_failed", null);
      if (code === undefined) return failed("invalid_receipt", null);
      return null;
    };
    if (segment === "home") {
      const home = parseAuditHomeJson(result.message, context.noteLimit);
      const early = settle(home?.code);
      if (early || !home) return early ?? failed("invalid_receipt", null);
      return {
        part: {
          segment,
          part: {
            status: auditReceiptStatus(home.status, result.errorCode),
            code: home.code,
            evidence,
            nickname: home.nickname,
            header: home.header,
            headerEnd: home.headerEnd,
            notesEnd: home.notesEnd,
            notes: home.notes,
          },
        },
        flags,
        stop: null,
        pause: null,
      };
    }
    const creator = parseAuditCreatorJson(result.message);
    const early = settle(creator?.code);
    if (early || !creator) return early ?? failed("invalid_receipt", null);
    const status = CREATOR_UNAVAILABLE_CODES.has(creator.code)
      ? "unavailable"
      : auditReceiptStatus(creator.status, result.errorCode);
    return {
      part: {
        segment,
        part: {
          status,
          code: creator.code,
          evidence,
          nickname: creator.nickname,
          header: creator.header,
          periodLabel: creator.periodLabel,
          views: creator.views,
          interactions: creator.interactions,
          newFollowers: creator.newFollowers,
          profileVisitors: creator.profileVisitors,
          accountStatus: creator.accountStatus,
        },
      },
      flags: CREATOR_UNAVAILABLE_CODES.has(creator.code)
        ? [...flags, "creatorUnavailable"]
        : flags,
      stop: null,
      pause: null,
    };
  }

  // ─── Reconcile ─────────────────────────────────────────────────────────────

  private async reconcileAudit(
    audit: XhsOpsAccountAudit,
  ): Promise<XhsOpsAuditReconcileOutcome> {
    const segment =
      AUDIT_SEGMENTS.find((entry) => audit[entry]?.status === "interrupted") ??
      null;
    const taskId = audit.activeTaskId;
    if (segment) {
      const retained = await this.retainedResult(audit, segment, taskId);
      if (retained) {
        await this.recoverSegment(audit, segment, retained);
        return {
          auditId: audit.id,
          outcome: "recovered",
          taskId: retained.taskId,
        };
      }
    }
    if (!segment && !taskId)
      return { auditId: audit.id, outcome: "ended", taskId: null };
    const probed = await this.probeDevice(audit.deviceId);
    const device = probed === "unknown" ? null : probed;
    if (taskId && device?.currentTaskId === taskId) {
      if (await this.stopTask(audit.deviceId, taskId)) {
        await this.clearActiveTask(audit.id);
        return { auditId: audit.id, outcome: "stopped", taskId };
      }
    } else if (
      device &&
      (taskId
        ? device.currentTaskId !== taskId
        : device.status === "idle" && !device.currentTaskId)
    ) {
      // The task is gone from the phone and its receipt was not kept.
      await this.clearActiveTask(audit.id);
      return { auditId: audit.id, outcome: "ended", taskId };
    }
    // Offline, unreachable, or busy with a task nobody can prove is ours.
    const heldTaskId = taskId ?? device?.currentTaskId ?? null;
    await this.holdInterrupted(audit, heldTaskId);
    return { auditId: audit.id, outcome: "held", taskId: heldTaskId };
  }

  /** The interrupted segment's task may still run: hold the device and mark the audit (§3.1 表二). */
  private async holdInterrupted(
    audit: XhsOpsAccountAudit,
    taskId: string | null,
  ): Promise<void> {
    await this.store.holdTakeoverDevice(audit.accountId, {
      taskId: taskId ?? UNKNOWN_TASK_ID,
      sourceRef: audit.id,
    });
    await this.store.updateAudit(audit.id, (current) =>
      current.flags.includes("cancellationUnconfirmed")
        ? current
        : {
            ...current,
            flags: sortFlags([...current.flags, "cancellationUnconfirmed"]),
            reason: clip(`${current.reason}；${CANCELLATION_UNCONFIRMED}`),
          },
    );
    logger.warn(
      { auditId: audit.id, deviceId: audit.deviceId, taskId },
      "xhs-ops: interrupted audit task unconfirmed after restart, device held",
    );
  }

  /** The receipt tabby-control kept for the interrupted segment, by id or — without one — by marker. */
  private async retainedResult(
    audit: XhsOpsAccountAudit,
    segment: AuditSegment,
    taskId: string | null,
  ): Promise<TaskResult | null> {
    const fetch = this.deviceControl.getTaskResults;
    if (!fetch) return null;
    try {
      if (taskId) {
        const entries = await fetch.call(this.deviceControl, {
          taskId,
          deviceId: audit.deviceId,
        });
        return entries.find((entry) => entry.taskId === taskId)?.result ?? null;
      }
      const since = Date.parse(audit.startedAt);
      const used = new Set(
        AUDIT_SEGMENTS.map((entry) => audit[entry]?.evidence?.taskId).filter(
          (id): id is string => Boolean(id),
        ),
      );
      const entries = await fetch.call(this.deviceControl, {
        deviceId: audit.deviceId,
        limit: RECOVERABLE_RECEIPT_LOOKBACK,
      });
      return (
        entries
          .filter(
            (entry) =>
              entry.deviceId === audit.deviceId &&
              entry.completedAt >= since &&
              !used.has(entry.taskId) &&
              (entry.result.message ?? "").includes(SEGMENT_MARKER[segment]),
          )
          .sort((left, right) => right.completedAt - left.completedAt)[0]
          ?.result ?? null
      );
    } catch {
      return null;
    }
  }

  /** Store a receipt found after a restart; the audit stays interrupted unless it carries a stop. */
  private async recoverSegment(
    audit: XhsOpsAccountAudit,
    segment: AuditSegment,
    result: TaskResult,
  ): Promise<void> {
    const unread = userCancelled(result)
      ? "cancelled"
      : policyBlocked(result)
        ? "policy_blocked"
        : null;
    const interpreted: SegmentOutcome = unread
      ? {
          part: blankPart(
            segment,
            unread === "cancelled" ? "cancelled" : "failed",
            unread,
            this.evidence(result, segment, []).evidence,
          ),
          flags: [],
          stop: null,
          pause: null,
        }
      : this.interpret(segment, result, {
          noteLimit: XHS_AUDIT_MAX_NOTES,
          warnings: [],
        });
    const now = this.nowIso();
    await this.store.mutateTakeover(audit.accountId, (snapshot) => {
      const current = snapshot.audits.find((entry) => entry.id === audit.id);
      if (!current) return { result: null };
      const recovered = withPart(current, interpreted.part);
      return {
        audits: [
          {
            ...recovered,
            status: interpreted.stop ? "failed" : current.status,
            activeTaskId: null,
            flags: sortFlags([
              ...current.flags,
              ...interpreted.flags,
              ...auditDerivedFlags(recovered, snapshot),
            ]),
            reason: clip(
              interpreted.stop?.reason ??
                `controller 重启，盘点中断；已取回「${SEGMENT_LABEL[segment]}」段的结果，后续段没有继续`,
            ),
            completedAt: current.completedAt ?? now,
          },
        ],
        result: null,
      };
    });
    if (interpreted.pause)
      await this.pause(audit.accountId, audit.id, interpreted.pause);
  }

  private async clearActiveTask(auditId: string): Promise<void> {
    await this.store.updateAudit(auditId, (audit) =>
      audit.activeTaskId === null ? audit : { ...audit, activeTaskId: null },
    );
  }

  // ─── Phone ─────────────────────────────────────────────────────────────────

  /**
   * Dispatch one task. tabby-control only names a task when it ends, so while
   * the call is pending the device is asked for its current task — under the
   * exclusive lock, on a phone checked idle, that is ours — and onTaskId
   * persists it before the result is in. The first-progress policy check
   * runs alongside (watchTakeoverPolicyMode): a mode other than enforce stops
   * the task at once, onPolicyBreach writes the pause, and the outcome is
   * "policy".
   */
  private async runPhoneTask(
    watch: PhoneTaskWatch,
    body: DeviceExecuteTaskBody,
  ): Promise<PhoneTaskOutcome> {
    let settled = false;
    void this.watchTaskId(watch, () => settled);
    const policy = watchTakeoverPolicyMode(this.deviceControl, {
      deviceId: watch.deviceId,
      pollIntervalMs: this.taskIdPollIntervalMs,
      onBreach: watch.onPolicyBreach,
    });
    try {
      const { result } = await this.deviceControl.executeTask(
        watch.deviceId,
        body,
      );
      settled = true;
      const breach = await policy.finish({ kind: "result", result });
      return breach
        ? { kind: "policy", breach, result }
        : { kind: "result", result };
    } catch (error) {
      settled = true;
      const rejected = dispatchRejectionReason(error);
      if (rejected) {
        await policy.finish({ kind: "rejected" });
        return { kind: "rejected", reason: rejected };
      }
      const message = describe(error);
      const taskId = watch.taskId ?? taskIdFromError(error);
      const breach = await policy.finish({ kind: "lost", taskId });
      if (breach) return { kind: "policy", breach, result: null };
      return {
        kind: "lost",
        taskId,
        timedOut:
          error instanceof DeviceControlTimeoutError ||
          /^(TIMEOUT|NO_FIRST_STEP)\b/.test(message),
      };
    } finally {
      settled = true;
    }
  }

  /** onPolicyBreach of a takeover step: safetyPause manual with the breach's reason (§5.2, §6.5). */
  private policyPause(
    accountId: string,
    sourceRef: string,
  ): (breach: XhsOpsTakeoverPolicyBreach) => Promise<void> {
    return async (breach) => {
      await this.store.pauseTakeover(accountId, {
        code: "manual",
        reason: breach.reason,
        sourceRef,
      });
    };
  }

  private async watchTaskId(
    watch: PhoneTaskWatch,
    settled: () => boolean,
  ): Promise<void> {
    while (!settled() && !watch.taskId) {
      await sleep(this.taskIdPollIntervalMs);
      if (settled() || watch.taskId) return;
      let device: DeviceInfo | null;
      try {
        device = await this.deviceControl.getDevice(watch.deviceId);
      } catch {
        continue;
      }
      const taskId =
        device?.status === "busy" ? device.currentTaskId : undefined;
      if (!taskId || settled() || watch.taskId) continue;
      watch.taskId = taskId;
      try {
        await watch.onTaskId?.(taskId);
      } catch (error) {
        logger.warn(
          { deviceId: watch.deviceId, taskId, error: describe(error) },
          "xhs-ops: persisting the audit task id failed",
        );
      }
    }
  }

  /**
   * Stop an owned task by id (never "current"). Confirmed when the phone
   * acknowledges the cancel, or when tabby-control already holds the task's
   * terminal result — it ended by itself.
   */
  private async stopTask(
    deviceId: string,
    taskId: string | null,
  ): Promise<boolean> {
    if (!taskId || taskId === "current" || taskId === UNKNOWN_TASK_ID)
      return false;
    try {
      if (
        (await this.deviceControl.cancelTask(deviceId, { taskId }))
          ?.cancelled === true
      )
        return true;
    } catch {
      // CANCEL_NOT_CONFIRMED may mean the task had already finished.
    }
    const fetch = this.deviceControl.getTaskResults;
    if (!fetch) return false;
    try {
      const entries = await fetch.call(this.deviceControl, {
        taskId,
        deviceId,
      });
      return entries.some(
        (entry) => entry.taskId === taskId && entry.deviceId === deviceId,
      );
    } catch {
      return false;
    }
  }

  /** null = not connected; "unknown" = the status could not be queried. */
  private async probeDevice(
    deviceId: string,
  ): Promise<DeviceInfo | null | "unknown"> {
    let device: DeviceInfo | null;
    try {
      device = await this.deviceControl.getDevice(deviceId);
    } catch (error) {
      if (
        error instanceof DeviceControlRpcError &&
        error.code === "DEVICE_NOT_FOUND"
      )
        return null;
      return "unknown";
    }
    if (!device || this.now() - device.lastSeen > this.offlineAfterMs)
      return null;
    return device;
  }

  /**
   * Poll until the phone is idle with no current task (§5.4 N3). Offline
   * fails at once, and so does a phone that reported a policy mode other
   * than enforce (§5.2: its mechanical gates would not block anything); a
   * phone busy with something else fails at the deadline — with `timeoutMs`
   * 0, on the first look.
   */
  private async checkIdle(
    deviceId: string,
    cancelled: () => boolean,
    timeoutMs: number,
  ): Promise<IdleCheck> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      if (cancelled())
        return { ok: false, code: "cancelled", error: "盘点已取消" };
      const device = await this.probeDevice(deviceId);
      if (device === null)
        return {
          ok: false,
          code: "device_unavailable",
          error: DEVICE_UNAVAILABLE,
        };
      const policy =
        device === "unknown" ? null : takeoverDispatchRefusal(device);
      if (policy)
        return { ok: false, code: "policy_not_enforce", error: policy };
      if (
        device !== "unknown" &&
        device.status === "idle" &&
        !device.currentTaskId
      )
        return { ok: true };
      if (this.now() >= deadline)
        return {
          ok: false,
          code: device === "unknown" ? "device_unavailable" : "device_busy",
          error:
            device === "unknown"
              ? "无法查询手机状态，请稍后重试"
              : "手机正在执行其他任务，请等它结束后再试",
        };
      await sleep(this.idlePollIntervalMs);
    }
  }
}
