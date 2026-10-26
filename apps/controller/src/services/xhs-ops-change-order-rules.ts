import {
  XHS_PROFILE_FIELD_LABEL,
  XHS_TAKEOVER_CHANGE_BUDGET,
  XHS_TAKEOVER_OBSERVATION_HOURS,
  type XhsOpsAccount,
  type XhsOpsChangeOrder,
  type XhsOpsChangeOrderField,
  type XhsOpsChangeOrderFlag,
  type XhsOpsPlatformLimitNotice,
  type XhsOpsProfileField,
  type XhsOpsTakeover,
  type XhsOpsTakeoverProfileField,
  xhsOpsChangeOrderChangedFields,
  xhsOpsTakeoverProfileFieldSchema,
} from "@nexu/shared";
import type {
  XhsOpsTakeoverApplyFieldCode,
  XhsOpsTakeoverProfileApplyReceipt,
} from "./xhs-ops-task-builder.js";

// Pure rules of a change order's apply step (takeover design §5.2 steps 4
// and 6, §8.1), shared by the profile service — which runs the apply task and
// reconciles its ledger after a restart — and the change-order service.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A precheck digest is valid for 30 minutes (§5.2 step 2). */
export const XHS_CHANGE_ORDER_PRECHECK_TTL_MS = 30 * 60_000;

/**
 * applyTaskId from the moment the apply is confirmed until the phone names
 * its task. applyTaskId non-null is what "an apply was dispatched" means to
 * the budget ledger (§8.1), and a restart in between must still count the
 * order's fields as possibly changed.
 */
export const XHS_CHANGE_ORDER_TASK_PENDING = "pending";

/** §5.2 step 6: wording a PROFILE_JSON note uses for a platform limit. */
export const XHS_TAKEOVER_LIMIT_NOTICE_PATTERN = /次数|频繁|稍后|限制|\d+\s*天/;

const MAX_LIMIT_NOTICES = 20;
const MAX_LIMIT_NOTICE_DAYS = 365;
const MAX_ERROR_CHARS = 200;
/** The schema's cap on order.pushedAlbums; the newest are kept. */
const MAX_PUSHED_ALBUMS = 20;

/** How a PROFILE_JSON note may name a field. */
const NOTE_FIELD_LABELS: Record<XhsOpsTakeoverProfileField, readonly string[]> =
  {
    nickname: ["名字", "昵称"],
    bio: ["简介"],
    occupation: ["职业"],
    region: ["地区"],
    avatar: ["头像"],
    cover: ["背景图", "背景"],
  };

/** fieldCodes meaning the picture was never picked, as change-order flags. */
const CODE_FLAGS: Partial<
  Record<XhsOpsTakeoverApplyFieldCode, XhsOpsChangeOrderFlag>
> = {
  permission_required: "permissionRequired",
  album_not_found: "albumNotFound",
  picker_unsupported: "pickerUnsupported",
};

function clip(text: string, max = MAX_ERROR_CHARS): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** The field as one a takeover may change, or null for 性别/生日. */
export function takeoverProfileField(
  field: XhsOpsProfileField,
): XhsOpsTakeoverProfileField | null {
  const parsed = xhsOpsTakeoverProfileFieldSchema.safeParse(field);
  return parsed.success ? parsed.data : null;
}

/** order.pushedAlbums with `albums` added once each, oldest first, the newest kept. */
export function withPushedAlbums(
  order: Pick<XhsOpsChangeOrder, "pushedAlbums">,
  albums: readonly (string | null)[],
): string[] {
  const merged = [...order.pushedAlbums];
  for (const album of albums)
    if (album && !merged.includes(album)) merged.push(album);
  return merged.slice(-MAX_PUSHED_ALBUMS);
}

/** observationUntil after an order of `risk` changed something at `now`; a later end already set stays. */
export function withObservationWindow(
  takeover: XhsOpsTakeover,
  risk: XhsOpsChangeOrder["risk"],
  now: string,
): XhsOpsTakeover {
  const until = new Date(
    Date.parse(now) + XHS_TAKEOVER_OBSERVATION_HOURS[risk] * HOUR_MS,
  ).toISOString();
  return {
    ...takeover,
    observationUntil:
      takeover.observationUntil && takeover.observationUntil > until
        ? takeover.observationUntil
        : until,
  };
}

/**
 * Close an order as failed or cancelled: activeChangeOrderId lets go of it,
 * and a failed order whose apply changed a field still opens the
 * observation window of its risk (§5.2 step 6) — the next batch waits for
 * it like after a success (MT-02).
 */
export function closeChangeOrder(
  account: XhsOpsAccount,
  order: XhsOpsChangeOrder,
  input: { status: "failed" | "cancelled"; error: string | null; now: string },
): { account: XhsOpsAccount; order: XhsOpsChangeOrder } {
  const closed: XhsOpsChangeOrder = {
    ...order,
    status: input.status,
    precheck: input.status === "cancelled" ? null : order.precheck,
    error: input.error === null ? order.error : clip(input.error),
  };
  const takeover = account.takeover;
  if (!takeover) return { account, order: closed };
  let next: XhsOpsTakeover = {
    ...takeover,
    activeChangeOrderId:
      takeover.activeChangeOrderId === order.id
        ? null
        : takeover.activeChangeOrderId,
  };
  if (
    input.status === "failed" &&
    order.applyTaskId !== null &&
    xhsOpsChangeOrderChangedFields(closed).length > 0
  )
    next = withObservationWindow(next, order.risk, input.now);
  return { account: { ...account, takeover: next }, order: closed };
}

/**
 * Platform limits the phone quoted (§5.2 step 6, §8.1), from every apply
 * receipt whatever the order's end: a field coded platform_limit, and a note
 * in limit wording for the fields it names that did not change — a field
 * the receipt reports done went through, so the wording is not about it —
 * or, naming none, for the fields that failed. The block lasts the 「N 天」
 * the note gives, else the field's own self-limit window.
 */
export function extractPlatformLimitNotices(
  order: Pick<XhsOpsChangeOrder, "fields">,
  receipt: XhsOpsTakeoverProfileApplyReceipt,
  input: { taskId: string | null; observedAt: string },
): XhsOpsPlatformLimitNotice[] {
  if (!receipt.extracted) return [];
  const note = receipt.note.trim();
  const noteHit = note !== "" && XHS_TAKEOVER_LIMIT_NOTICE_PATTERN.test(note);
  const fields = new Set<XhsOpsTakeoverProfileField>();
  for (const entry of receipt.fields)
    if (entry.code === "platform_limit") fields.add(entry.field);
  if (noteHit) {
    const done = new Set(
      receipt.fields
        .filter((entry) => entry.outcome === "done")
        .map((entry) => entry.field),
    );
    const named = order.fields.flatMap((entry) => {
      const field = takeoverProfileField(entry.field);
      return field &&
        NOTE_FIELD_LABELS[field].some((label) => note.includes(label))
        ? [field]
        : [];
    });
    if (named.length > 0) {
      for (const field of named) if (!done.has(field)) fields.add(field);
    } else {
      for (const entry of receipt.fields)
        if (entry.outcome === "failed") fields.add(entry.field);
    }
  }
  const days = /(\d+)\s*天/.exec(note);
  const observedMs = Date.parse(input.observedAt);
  return [...fields].map((field) => {
    const blockDays = days
      ? Math.min(MAX_LIMIT_NOTICE_DAYS, Math.max(1, Number(days[1])))
      : XHS_TAKEOVER_CHANGE_BUDGET[field].windowDays;
    return {
      field,
      text: clip(
        note || `${XHS_PROFILE_FIELD_LABEL[field]}修改受平台次数限制`,
        120,
      ),
      observedAt: input.observedAt,
      blockedUntil: new Date(observedMs + blockDays * DAY_MS).toISOString(),
      sourceTaskId: input.taskId,
    };
  });
}

/** The newest notices win the 20 slots; one task never records a field twice. */
export function mergePlatformLimitNotices(
  existing: readonly XhsOpsPlatformLimitNotice[],
  added: readonly XhsOpsPlatformLimitNotice[],
): XhsOpsPlatformLimitNotice[] {
  const fresh = added.filter(
    (notice) =>
      !existing.some(
        (entry) =>
          entry.field === notice.field &&
          entry.sourceTaskId !== null &&
          entry.sourceTaskId === notice.sourceTaskId,
      ),
  );
  return [...existing, ...fresh].slice(-MAX_LIMIT_NOTICES);
}

/** What became of one apply attempt of a change order. */
export type XhsOpsChangeOrderApplyOutcome =
  /**
   * No apply task reached the phone: a picture could not be pushed, or the
   * dispatch was refused. `pushedAlbums`: albums of this attempt that may
   * already hold a picture on the phone all the same.
   */
  | { kind: "not_dispatched"; reason: string; pushedAlbums?: readonly string[] }
  /**
   * The phone task ended. `completed` false means it was stopped (CALL_USER,
   * a lost answer) rather than finishing by itself; `receipt` is
   * parseTakeoverProfileJson of its message, extracted or not.
   */
  | {
      kind: "ended";
      taskId: string | null;
      receipt: XhsOpsTakeoverProfileApplyReceipt;
      completed: boolean;
      reason: string | null;
    }
  /** Whether the phone task still runs is unknown: the device is held. */
  | { kind: "unconfirmed"; taskId: string | null; reason: string };

/**
 * The account and order after one apply attempt (§5.2 状态表, applying rows):
 *
 * - not dispatched → back to draft, nothing public changed; a draft without
 *   the identity it was prechecked for is cancelled instead;
 * - every field failed or skipped → failed;
 * - live, finished, at least one field done → verifying, which checks every
 *   done and uncertain field: a receipt that names only some of the fields
 *   leaves the rest uncertain, and they may have changed too;
 * - anything else — no receipt (fields uncertain), a stop, an unconfirmed
 *   stop, a receipt recovered after a restart — → interrupted, keeping
 *   activeChangeOrderId until verify re-checks it.
 *
 * Every receipt adds its platform-limit notices, and every album that may
 * hold one of the order's pictures goes into pushedAlbums for the cleanup
 * reminder. The profile-draft ledger of this order completes unless the phone
 * task may still be running, so the reconcile sweep can still recover its
 * receipt later.
 */
export function settleChangeOrderApply(input: {
  account: XhsOpsAccount;
  order: XhsOpsChangeOrder;
  outcome: XhsOpsChangeOrderApplyOutcome;
  now: string;
  /** recovered: a restart reconcile found the receipt; the in-process flow is gone. */
  mode: "live" | "recovered";
}): { account: XhsOpsAccount; order: XhsOpsChangeOrder } {
  const { order, outcome, now } = input;
  const operation = input.account.profileDraft.applyOperation;
  const ownLedger =
    operation?.status === "running" && operation.changeOrderId === order.id;
  const taskId = outcome.kind === "not_dispatched" ? null : outcome.taskId;
  const account: XhsOpsAccount =
    ownLedger && operation && outcome.kind !== "unconfirmed"
      ? {
          ...input.account,
          profileDraft: {
            ...input.account.profileDraft,
            applyOperation: {
              ...operation,
              status: "completed",
              taskId: taskId ?? operation.taskId,
              completedAt: now,
            },
          },
        }
      : ownLedger && operation && taskId && operation.taskId === null
        ? {
            ...input.account,
            profileDraft: {
              ...input.account.profileDraft,
              applyOperation: { ...operation, taskId },
            },
          }
        : input.account;
  const takeover = account.takeover;
  if (
    !takeover ||
    (order.status !== "applying" && order.status !== "interrupted")
  )
    return { account, order };

  if (outcome.kind === "not_dispatched") {
    const identityHeld =
      takeover.identityConfirmedAt !== null &&
      account.platformAccountId === order.platformAccountId &&
      account.deviceId === order.deviceId;
    const reset: XhsOpsChangeOrder = {
      ...order,
      status: "draft",
      precheck: null,
      confirmedAt: null,
      acks: {},
      acksAt: null,
      applyTaskId: null,
      fields: order.fields.map((entry) => ({ ...entry, mediaAlbum: null })),
      pushedAlbums: withPushedAlbums(order, outcome.pushedAlbums ?? []),
      error: clip(outcome.reason),
    };
    if (!identityHeld)
      return closeChangeOrder(account, reset, {
        status: "cancelled",
        error: `小红书号或设备已变化，单子已取消（${outcome.reason}）`,
        now,
      });
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
      order: reset,
    };
  }

  const reported =
    outcome.kind === "ended"
      ? new Map(outcome.receipt.fields.map((entry) => [entry.field, entry]))
      : null;
  const fields = order.fields.map((entry): XhsOpsChangeOrderField => {
    const field = takeoverProfileField(entry.field);
    const receipt = field ? reported?.get(field) : undefined;
    if (!reported || !receipt)
      return entry.outcome === "pending"
        ? { ...entry, outcome: "uncertain" }
        : entry;
    return { ...entry, outcome: receipt.outcome, code: receipt.code };
  });
  const flags = new Set(order.flags);
  for (const entry of outcome.kind === "ended" ? outcome.receipt.fields : []) {
    const flag = entry.code ? CODE_FLAGS[entry.code] : undefined;
    if (flag) flags.add(flag);
  }
  const notices =
    outcome.kind === "ended"
      ? extractPlatformLimitNotices(order, outcome.receipt, {
          taskId: outcome.taskId,
          observedAt: now,
        })
      : [];
  const nextTakeover: XhsOpsTakeover =
    notices.length > 0
      ? {
          ...takeover,
          platformLimitNotices: mergePlatformLimitNotices(
            takeover.platformLimitNotices,
            notices,
          ),
        }
      : takeover;
  const settled: XhsOpsChangeOrder = {
    ...order,
    fields,
    flags: [...flags],
    // The apply task only went out once every picture was pushed.
    pushedAlbums: withPushedAlbums(
      order,
      order.fields.map((entry) => entry.mediaAlbum),
    ),
    applyTaskId: taskId ?? order.applyTaskId,
  };
  const withNotices: XhsOpsAccount = { ...account, takeover: nextTakeover };
  const anyDone = fields.some((entry) => entry.outcome === "done");
  const anyUncertain = fields.some((entry) => entry.outcome === "uncertain");
  if (outcome.kind === "ended" && !anyDone && !anyUncertain)
    return closeChangeOrder(withNotices, settled, {
      status: "failed",
      error: outcome.reason ?? "手机回报本单字段都没有改成",
      now,
    });
  if (
    outcome.kind === "ended" &&
    input.mode === "live" &&
    order.status === "applying" &&
    outcome.completed &&
    anyDone
  )
    return {
      account: withNotices,
      order: { ...settled, status: "verifying", error: null },
    };
  const reason =
    outcome.kind === "unconfirmed"
      ? outcome.reason
      : (outcome.reason ??
        (outcome.receipt.extracted
          ? "手机修改任务没有回报全部字段，本单字段可能已改，请补跑核验"
          : "没有取到手机的修改回执，本单字段可能已改，请补跑核验"));
  return {
    account: withNotices,
    order: { ...settled, status: "interrupted", error: clip(reason) },
  };
}
