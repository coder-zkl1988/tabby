import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceExecuteTaskBody,
  type DeviceInfo,
  type DevicePushMediaBody,
  type TaskResult,
  XHS_TAKEOVER_IMAGE_UNSUPPORTED_MESSAGE,
  type XhsOpsAccount,
  type XhsOpsChangeOrder,
  type XhsOpsChangeOrderAcks,
  type XhsOpsChangeOrderField,
  type XhsOpsTakeover,
  type XhsOpsTakeoverProfileField,
  xhsOpsChangeOrderSchema,
  xhsOpsInteractionConfigSchema,
  xhsOpsParseCount,
  xhsOpsTakeoverFieldBudgetState,
  xhsOpsTakeoverFirstObservationIssue,
} from "@nexu/shared";
import { afterEach, describe, expect, it } from "vitest";
import { localDateString } from "../src/lib/xhs-ops-common.js";
import { DeviceControlRpcError } from "../src/services/device-control-service.js";
import {
  type XhsOpsAuditDeviceControl,
  XhsOpsAuditService,
} from "../src/services/xhs-ops-audit-service.js";
import {
  XHS_CHANGE_ORDER_TASK_PENDING,
  extractPlatformLimitNotices,
  withPushedAlbums,
} from "../src/services/xhs-ops-change-order-rules.js";
import {
  XhsOpsChangeOrderService,
  changeOrderBudget,
} from "../src/services/xhs-ops-change-order-service.js";
import {
  type XhsOpsProfileDeviceControl,
  XhsOpsProfileService,
} from "../src/services/xhs-ops-profile-service.js";
import {
  XHS_AUDIT_TASK_POLICY,
  XHS_TAKEOVER_APPLY_TASK_POLICY,
} from "../src/services/xhs-ops-run-service.js";
import { takeoverPolicyBreachReason } from "../src/services/xhs-ops-takeover-phone.js";
import {
  PROFILE_JSON_MARKER,
  PROFILE_VERIFICATION_JSON_MARKER,
  XHS_AUDIT_CREATOR_MARKER,
  XHS_AUDIT_HOME_MARKER,
  XHS_PROFILE_READBACK_MARKER,
  parseTakeoverProfileJson,
} from "../src/services/xhs-ops-task-builder.js";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";
import {
  draftTakeoverChangeOrders,
  invalidateTakeoverIdentity,
  takeoverExpectedFieldValue,
} from "../src/store/xhs-ops-takeover-records.js";

const START = Date.parse("2026-10-21T02:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const XHS_ID = "xhs-owner-001";
const DEVICE = "phone-1";
const ALL_IMAGE_ACKS: XhsOpsChangeOrderAcks = {
  photoPermission: true,
  screenshotPrivacy: true,
  cleanup: true,
};
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing fixture");
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
  read: () => Promise<T | null | undefined>,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) return value;
    await sleep(2);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function takeoverOf(account: XhsOpsAccount | null | undefined): XhsOpsTakeover {
  if (!account?.takeover) throw new Error("fixture has no takeover");
  return account.takeover;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngDataUrl(content: string): string {
  return `data:image/png;base64,${Buffer.concat([PNG_MAGIC, Buffer.from(content)]).toString("base64")}`;
}

// ─── Phone receipts ─────────────────────────────────────────────────────────

type HeaderTexts = {
  followingText: string;
  followersText: string;
  likesCollectsText: string;
};

type PhoneProfile = {
  nickname: string;
  bio: string;
  occupation: string;
  gender: string;
  birthdayFilled: boolean;
  region: string;
};

const OLD_PROFILE: PhoneProfile = {
  nickname: "老昵称",
  bio: "老简介",
  occupation: "设计师",
  gender: "女",
  birthdayFilled: true,
  region: "中国 上海 上海",
};

const clicks = (count: number) =>
  `[回执] 各应用生效点击: com.xingin.xhs=${count}`;

function receipt(marker: string, payload: Record<string, unknown>): string {
  return ["已完成", `${marker}${JSON.stringify(payload)}`, clicks(2)].join(
    "\n",
  );
}

function applyMessage(
  fields: Partial<Record<XhsOpsTakeoverProfileField, string>>,
  extra: { fieldCodes?: Record<string, string>; note?: string } = {},
): string {
  return receipt(PROFILE_JSON_MARKER, {
    ...fields,
    fieldCodes: extra.fieldCodes ?? {},
    note: extra.note ?? "已按要求修改",
  });
}

const TEXT_LABELS: Record<string, keyof PhoneProfile> = {
  名字: "nickname",
  简介: "bio",
  职业: "occupation",
  地区: "region",
};

// ─── Fake phone ─────────────────────────────────────────────────────────────

type Kind =
  | "readback"
  | "apply"
  | "verification"
  | "home"
  | "creator"
  | "preparation";

type Step =
  | { kind: "message"; message: string; effect?: () => void }
  | { kind: "result"; result: Partial<TaskResult> }
  /** CALL_USER: the call returns, the phone keeps waiting on its task. */
  | { kind: "interaction" }
  /** Accepted and still running until cancelled or finished by the test. */
  | { kind: "hang" }
  /** Refused before the send; the phone never sees it. */
  | { kind: "reject" };

function kindOf(task: string): Kind {
  if (task.includes(PROFILE_VERIFICATION_JSON_MARKER)) return "verification";
  if (task.includes(XHS_PROFILE_READBACK_MARKER)) return "readback";
  if (task.includes(XHS_AUDIT_HOME_MARKER)) return "home";
  if (task.includes(XHS_AUDIT_CREATOR_MARKER)) return "creator";
  if (task.includes("PREPARATION_JSON:")) return "preparation";
  if (task.includes(PROFILE_JSON_MARKER)) return "apply";
  throw new Error(`unexpected task: ${task.slice(0, 40)}`);
}

/** The fields an apply or verification task asks about, from its receipt template. */
function requestedFields(task: string): XhsOpsTakeoverProfileField[] {
  const keys = [
    ...task.matchAll(
      /"(nickname|bio|occupation|region|avatar|cover)":(?:"done\|failed\|skipped"|true\|false)/g,
    ),
  ].map((match) => match[1]);
  return keys.filter((key): key is XhsOpsTakeoverProfileField =>
    ["nickname", "bio", "occupation", "region", "avatar", "cover"].includes(
      key ?? "",
    ),
  );
}

class FakePhone {
  online = true;
  status: DeviceInfo["status"] = "idle";
  currentTaskId: string | undefined;
  osVersion: string | undefined = "Android 13";
  policyMode: DeviceInfo["devicePolicyMode"] = "enforce";
  /** The mode a task reports at TASK_START; tabby-control keeps it on the status. */
  reportOnStart: DeviceInfo["devicePolicyMode"];
  confirmCancel = true;
  /** The media push RPC itself fails (transport, timeout). */
  pushThrows = false;
  /** Albums whose push the phone answers with a failed result: nothing lands. */
  readonly refusedAlbums = new Set<string>();
  /** The device status RPC fails. */
  getDeviceThrows = false;
  accountMatched = true;
  profile: PhoneProfile = { ...OLD_PROFILE };
  header: HeaderTexts = {
    followingText: "128",
    followersText: "800",
    likesCollectsText: "3200",
  };
  readonly dispatched: Array<{ kind: Kind; body: DeviceExecuteTaskBody }> = [];
  readonly pushed: DevicePushMediaBody[] = [];
  readonly cancelled: string[] = [];
  readonly retained: Array<{
    taskId: string;
    deviceId: string;
    result: TaskResult;
    completedAt: number;
  }> = [];
  private readonly queued = new Map<Kind, Step[]>();
  private readonly pending = new Map<string, (result: TaskResult) => void>();
  private seq = 0;

  constructor(private readonly now: () => number) {}

  queue(kind: Kind, ...steps: Step[]): void {
    this.queued.set(kind, [...(this.queued.get(kind) ?? []), ...steps]);
  }

  kinds(): Kind[] {
    return this.dispatched.map((entry) => entry.kind);
  }

  bodies(kind: Kind): DeviceExecuteTaskBody[] {
    return this.dispatched
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.body);
  }

  /** The controller died: nobody is waiting on the calls in flight any more. */
  forgetPending(): void {
    this.pending.clear();
  }

  /** The phone ends a task on its own. */
  finish(taskId: string, result: Partial<TaskResult>): void {
    if (this.currentTaskId === taskId) {
      this.status = "idle";
      this.currentTaskId = undefined;
    }
    this.retained.push({
      taskId,
      deviceId: DEVICE,
      result: { taskId, success: true, status: "completed", ...result },
      completedAt: this.now(),
    });
  }

  private readbackMessage(task: string): string {
    const withHeader = task.includes('"header":');
    return receipt(XHS_PROFILE_READBACK_MARKER, {
      v: 1,
      status: "read",
      accountMatched: this.accountMatched,
      ...this.profile,
      ...(withHeader ? { header: this.header } : {}),
    });
  }

  /** Writes the typed and picked values the task names, like the phone would. */
  private applyDefault(task: string): string {
    for (const match of task.matchAll(
      /\d+\) (名字|简介|职业|地区)：.*?(?:只作输入内容|只作匹配依据)：「(.*?)」/g,
    )) {
      const key = TEXT_LABELS[match[1] ?? ""];
      if (key && key !== "birthdayFilled") this.profile[key] = match[2] ?? "";
    }
    const fields = requestedFields(task);
    return applyMessage(
      Object.fromEntries(fields.map((field) => [field, "done"])),
    );
  }

  private verificationDefault(task: string): string {
    const expected = new Map<string, string>();
    for (const match of task.matchAll(
      /- (nickname|bio|occupation|region) \S+：是否与目标完全一致，以下引号里是期望内容，只作比对依据：「(.*?)」/g,
    ))
      expected.set(match[1] ?? "", match[2] ?? "");
    const fields = Object.fromEntries(
      requestedFields(task).map((field) => {
        const want = expected.get(field);
        const current =
          field === "avatar" || field === "cover" ? null : this.profile[field];
        return [field, want === undefined ? true : current === want];
      }),
    );
    const allTrue = Object.values(fields).every(Boolean);
    return receipt(PROFILE_VERIFICATION_JSON_MARKER, {
      v: 1,
      status: this.accountMatched && allTrue ? "verified" : "failed",
      accountMatched: this.accountMatched,
      fields,
      header: this.header,
    });
  }

  private defaultMessage(kind: Kind, task: string): string {
    switch (kind) {
      case "readback":
        return this.readbackMessage(task);
      case "apply":
        return this.applyDefault(task);
      case "verification":
        return this.verificationDefault(task);
      case "home":
        return receipt(XHS_AUDIT_HOME_MARKER, {
          v: 1,
          status: "read",
          code: "ok",
          nickname: this.profile.nickname,
          ...this.header,
          headerEnd: this.header,
          notesEnd: true,
          notes: [
            {
              i: 1,
              title: "通勤穿搭合集",
              likesText: "356",
              video: false,
              pinned: true,
            },
          ],
          note: "只有 1 张",
        });
      case "creator":
        return receipt(XHS_AUDIT_CREATOR_MARKER, {
          v: 1,
          status: "read",
          code: "ok",
          nickname: this.profile.nickname,
          ...this.header,
          periodLabel: "近7日",
          viewsText: "5230",
          engagementText: "312",
          newFollowersText: "18",
          visitorsText: "96",
          accountStatus: "正常",
          note: "",
        });
      case "preparation":
        throw new Error("the change-order path must never prepare");
    }
  }

  readonly control: XhsOpsProfileDeviceControl & XhsOpsAuditDeviceControl = {
    getDevice: async (deviceId) => {
      if (this.getDeviceThrows)
        throw new Error("Device control RPC failed: 503");
      return this.online
        ? {
            deviceId,
            status: this.status,
            currentTaskId: this.currentTaskId,
            connectedAt: 1,
            lastSeen: this.now(),
            ...(this.osVersion === undefined
              ? {}
              : { osVersion: this.osVersion }),
            ...(this.policyMode === undefined
              ? {}
              : { devicePolicyMode: this.policyMode }),
          }
        : null;
    },
    executeTask: async (_deviceId, body) => {
      const kind = kindOf(body.task);
      this.dispatched.push({ kind, body });
      const step = this.queued.get(kind)?.shift();
      if (step?.kind === "reject")
        throw new DeviceControlRpcError(
          "OPERATION_FAILED",
          `TASK_ALREADY_RUNNING: device ${DEVICE} is busy`,
        );
      const taskId = `task-${++this.seq}`;
      this.status = "busy";
      this.currentTaskId = taskId;
      if (this.reportOnStart) this.policyMode = this.reportOnStart;
      if (step?.kind === "hang")
        return new Promise((resolve) => {
          this.pending.set(taskId, (result) => resolve({ result }));
        });
      // Long enough for the task-id probe to see the task running.
      await sleep(5);
      if (!step || step.kind === "message" || step.kind === "result") {
        if (step?.kind === "message") step.effect?.();
        const result: TaskResult = {
          taskId,
          success: true,
          status: "completed",
          finalScreenshot: `/tmp/shots/${taskId}.png`,
          ...(step?.kind === "result"
            ? step.result
            : {
                message:
                  step?.kind === "message"
                    ? step.message
                    : this.defaultMessage(kind, body.task),
              }),
        };
        this.finish(taskId, result);
        return { result };
      }
      return {
        result: {
          taskId,
          success: false,
          needsInteraction: true,
          message: "需要人工处理",
        },
      };
    },
    cancelTask: async (_deviceId, { taskId }) => {
      this.cancelled.push(taskId);
      if (!this.confirmCancel) return { cancelled: false };
      if (this.currentTaskId !== taskId)
        throw new Error(
          `CANCEL_NOT_CONFIRMED: task ${taskId} already finished`,
        );
      const aborted: TaskResult = {
        taskId,
        success: false,
        status: "aborted",
        errorCode: "USER_CANCELLED",
      };
      this.finish(taskId, aborted);
      this.pending.get(taskId)?.(aborted);
      this.pending.delete(taskId);
      return { cancelled: true };
    },
    getTaskResults: async (query) =>
      this.retained.filter(
        (entry) =>
          (query.taskId === undefined || entry.taskId === query.taskId) &&
          (query.deviceId === undefined || entry.deviceId === query.deviceId),
      ),
    pushMedia: async (_deviceId, body) => {
      if (this.pushThrows) throw new Error("Device control RPC failed: 502");
      if (body.album !== undefined && this.refusedAlbums.has(body.album))
        return {
          results: body.images.map((image) => ({
            mediaId: image.filename,
            success: false,
            error: "存储空间不足",
          })),
        };
      this.pushed.push(body);
      return {
        results: body.images.map((image) => ({
          mediaId: image.filename,
          success: true,
        })),
      };
    },
  };
}

// ─── Harness ────────────────────────────────────────────────────────────────

const NO_MEDIA = {
  generateImage: async () => {
    throw new Error("a takeover never generates images");
  },
  generateText: async () => {
    throw new Error("a takeover never generates profile text");
  },
};

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "xhs-change-order-"));
  directories.push(directory);
  const file = join(directory, "state.json");
  const mediaRoot = join(directory, "media");
  const clock = { now: START };
  let id = 0;
  let operation = 0;
  const deps = {
    now: () => new Date(clock.now).toISOString(),
    genId: () => `id-${++id}`,
  };
  const phone = new FakePhone(() => clock.now);
  const servicesFor = (store: XhsOpsStore) => {
    const audits = new XhsOpsAuditService({
      store,
      deviceControl: phone.control,
      options: {
        idlePollIntervalMs: 1,
        idleWaitTimeoutMs: 0,
        taskIdPollIntervalMs: 1,
        now: () => clock.now,
      },
    });
    const profile = new XhsOpsProfileService({
      store,
      media: NO_MEDIA,
      deviceControl: phone.control,
      mediaRoot,
      taskIdPollIntervalMs: 1,
      now: () => clock.now,
    });
    const orders = new XhsOpsChangeOrderService({
      store,
      deviceControl: phone.control,
      profile,
      audits,
      mediaRoot,
      options: {
        idlePollIntervalMs: 1,
        idleWaitTimeoutMs: 0,
        taskIdPollIntervalMs: 1,
        now: () => clock.now,
        genId: () => `a1b2c3d${++operation}-0000-4000-8000-000000000000`,
      },
    });
    return { store, audits, profile, orders };
  };
  const store = new XhsOpsStore(file, deps);
  return {
    ...servicesFor(store),
    servicesFor,
    phone,
    mediaRoot,
    clock,
    advance: (ms: number) => {
      clock.now += ms;
    },
    today: () => localDateString(new Date(clock.now)),
    /** A second store on the same file: what a controller restart sees. */
    reopen: () => new XhsOpsStore(file, deps),
  };
}
type Harness = ReturnType<typeof harness>;
type Services = ReturnType<Harness["servicesFor"]>;

/**
 * What a device change does to a takeover's identity lock (the store's
 * withIdentityInvalidated). A PATCH can no longer clear the 小红书号 to get
 * there (A5), and a device move is refused while an order holds the phone.
 */
async function invalidateIdentity(
  h: Harness,
  accountId: string,
): Promise<void> {
  await h.store.mutateTakeover(
    accountId,
    ({ account, audits, changeOrders }) => ({
      ...invalidateTakeoverIdentity(
        account,
        { audits, changeOrders },
        (updatedAt) => updatedAt,
      ),
      result: null,
    }),
  );
}

const count = (text: string) => xhsOpsParseCount(text);

/** Authorized, identity locked, baselined on the phone's current profile, plan confirmed. */
async function plannedAccount(h: Harness): Promise<XhsOpsAccount> {
  const project = await h.store.createProject({
    name: "接管项目",
    business: { industry: "美妆", product: "护肤品" },
    audience: {
      ageRange: "25–32",
      genderRatio: "女80%男20%",
      regions: ["上海"],
    },
  });
  const confirmed = await h.store.confirmProfile(project.id, {
    profile: {
      summary: "上海职场女性",
      base: { ageRange: "25–32", genderRatio: "女80%男20%", regions: ["上海"] },
      verticalInterests: ["护肤"],
      generalInterests: ["咖啡", "通勤"],
    },
    expectedUpdatedAt: project.updatedAt,
  });
  const account = await h.store.createAccount({
    projectId: confirmed.id,
    entryMode: "existing",
    label: "接管·测试机",
    deviceId: DEVICE,
    deviceName: "测试机",
  });
  const authorized = await h.store.authorizeTakeover(account.id, {
    expectedUpdatedAt: account.updatedAt,
    ownershipConfirmed: true,
  });
  h.advance(MINUTE);
  await h.store.recordTakeoverIdentityRead(authorized.id, {
    taskId: "identity-task",
    deviceId: DEVICE,
    screenshotUrl: null,
    readAccountId: XHS_ID,
  });
  h.advance(MINUTE);
  const locked = await h.store.confirmTakeoverIdentity(authorized.id, {
    identityTaskId: "identity-task",
    platformAccountId: XHS_ID,
  });
  const header = {
    following: count("128"),
    followers: count("800"),
    likesCollects: count("3200"),
  };
  const now = new Date(h.clock.now).toISOString();
  const audit = await h.store.createAudit({
    projectId: locked.projectId,
    accountId: locked.id,
    deviceId: DEVICE,
    platformAccountId: XHS_ID,
    trigger: "takeover",
    status: "completed",
    startedAt: now,
    completedAt: now,
    profile: {
      status: "read",
      code: "ok",
      evidence: null,
      accountMatched: true,
      values: { ...h.phone.profile },
    },
    home: {
      status: "read",
      code: "ok",
      evidence: null,
      nickname: h.phone.profile.nickname,
      header,
      headerEnd: header,
      notesEnd: true,
      notes: [],
    },
  });
  const { account: planned } = await h.store.mutateTakeover(
    locked.id,
    ({ account: current }) => ({
      account: {
        ...current,
        takeover: {
          ...takeoverOf(current),
          baselineAuditId: audit.id,
          latestAuditId: audit.id,
          planConfirmedAt: now,
        },
      },
      result: null,
    }),
  );
  h.advance(MINUTE);
  return planned;
}

async function order(s: Services, orderId: string): Promise<XhsOpsChangeOrder> {
  return must(await s.store.getChangeOrder(orderId));
}

async function account(s: Services, accountId: string): Promise<XhsOpsAccount> {
  return must(await s.store.getAccount(accountId));
}

async function create(
  s: Services,
  accountId: string,
  fields: Array<{ field: XhsOpsTakeoverProfileField; after?: string }>,
  rollbackOfId?: string,
): Promise<XhsOpsChangeOrder> {
  return (
    await s.orders.createChangeOrder(accountId, {
      fields,
      ...(rollbackOfId ? { rollbackOfId } : {}),
    })
  ).order;
}

async function precheck(
  s: Services,
  orderId: string,
): Promise<XhsOpsChangeOrder> {
  const current = await order(s, orderId);
  await s.orders.precheck(orderId, { expectedUpdatedAt: current.updatedAt });
  await s.orders.waitForOrder(orderId);
  return order(s, orderId);
}

async function confirm(
  s: Services,
  orderId: string,
  acks: XhsOpsChangeOrderAcks = {},
): Promise<XhsOpsChangeOrder> {
  const current = await order(s, orderId);
  await s.orders.confirm(orderId, {
    confirmDigest: must(current.precheck).confirmDigest,
    expectedUpdatedAt: current.updatedAt,
    acks,
  });
  await s.orders.waitForOrder(orderId);
  return order(s, orderId);
}

async function upload(
  s: Services,
  orderId: string,
  field: "avatar" | "cover",
  dataUrl = pngDataUrl(field),
): Promise<XhsOpsChangeOrder> {
  const current = await order(s, orderId);
  return (
    await s.orders.uploadImage(orderId, field, {
      dataUrl,
      expectedUpdatedAt: current.updatedAt,
    })
  ).order;
}

async function visual(
  s: Services,
  orderId: string,
  field: "avatar" | "cover",
  result: "match" | "mismatch",
): Promise<XhsOpsChangeOrder> {
  const current = await order(s, orderId);
  return (
    await s.orders.visualCheck(orderId, {
      field,
      result,
      expectedUpdatedAt: current.updatedAt,
    })
  ).order;
}

async function review(
  s: Services,
  orderId: string,
): Promise<XhsOpsChangeOrder> {
  const current = await order(s, orderId);
  await s.orders.reviewObservation(orderId, {
    expectedUpdatedAt: current.updatedAt,
  });
  await s.orders.waitForOrder(orderId);
  return order(s, orderId);
}

async function verifyAgain(
  s: Services,
  orderId: string,
): Promise<XhsOpsChangeOrder> {
  const current = await order(s, orderId);
  await s.orders.verify(orderId, { expectedUpdatedAt: current.updatedAt });
  await s.orders.waitForOrder(orderId);
  return order(s, orderId);
}

async function lockFree(s: Services, accountId: string): Promise<boolean> {
  try {
    const release = await s.store.acquireExclusiveDeviceBinding(
      accountId,
      DEVICE,
    );
    release();
    return true;
  } catch {
    return false;
  }
}

/**
 * An earlier order of the 小红书号 that went through its observation long
 * ago: the nickname's 「第一个观察期内不改」 (§8.1) is over, and it is outside
 * every budget window and older than the baseline.
 */
async function pastFirstObservation(
  h: Harness,
  planned: XhsOpsAccount,
): Promise<XhsOpsChangeOrder> {
  const longAgo = new Date(h.clock.now - 40 * DAY).toISOString();
  return h.store.createChangeOrder({
    projectId: planned.projectId,
    accountId: planned.id,
    deviceId: DEVICE,
    platformAccountId: XHS_ID,
    diagnosisId: null,
    proposalIds: [],
    batchIndex: 1,
    risk: "L1",
    fields: [
      {
        field: "bio",
        baselineValue: "更早的简介",
        before: "更早的简介",
        after: OLD_PROFILE.bio,
        outcome: "verified",
      },
    ],
    status: "completed",
    confirmedAt: longAgo,
    applyTaskId: "task-earlier",
    observation: {
      until: longAgo,
      auditId: null,
      baseAuditId: null,
      visualChecks: {},
      verdict: "pass",
      notes: [],
    },
  });
}

/** A text order through precheck, confirmation, apply and verification. */
async function observedTextOrder(
  h: Harness,
  accountId: string,
  fields: Array<{ field: XhsOpsTakeoverProfileField; after: string }>,
  acks: XhsOpsChangeOrderAcks = {},
): Promise<XhsOpsChangeOrder> {
  const created = await create(h, accountId, fields);
  expect((await precheck(h, created.id)).status).toBe("awaiting_confirm");
  return confirm(h, created.id, acks);
}

/** A change order as the ledger holds it, for the pure rules. */
function ledgerOrder(input: {
  owner?: Pick<XhsOpsAccount, "id" | "projectId">;
  id: string;
  at: number;
  status: XhsOpsChangeOrder["status"];
  fields: Array<{
    field: XhsOpsTakeoverProfileField;
    after: string;
    outcome: XhsOpsChangeOrderField["outcome"];
    before?: string;
  }>;
  applyTaskId?: string | null;
  platformAccountId?: string;
}): XhsOpsChangeOrder {
  const at = new Date(input.at).toISOString();
  return xhsOpsChangeOrderSchema.parse({
    id: input.id,
    projectId: input.owner?.projectId ?? "project-1",
    accountId: input.owner?.id ?? "account-1",
    deviceId: DEVICE,
    platformAccountId: input.platformAccountId ?? XHS_ID,
    diagnosisId: null,
    proposalIds: [],
    batchIndex: 1,
    risk: "L1",
    fields: input.fields.map((entry) => ({
      field: entry.field,
      baselineValue: entry.before ?? "",
      before: entry.before ?? "",
      after: entry.after,
      outcome: entry.outcome,
    })),
    status: input.status,
    confirmedAt: at,
    applyTaskId:
      input.applyTaskId === undefined ? `task-${input.id}` : input.applyTaskId,
    createdAt: at,
    updatedAt: at,
  });
}

// ─── Text orders ────────────────────────────────────────────────────────────

describe("change order: text fields", () => {
  it("verifies only the order's own field, then observes for 72 hours without a preparation task", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    expect(created).toMatchObject({
      status: "draft",
      risk: "L1",
      batchIndex: 1,
      fields: [
        {
          field: "bio",
          baselineValue: "老简介",
          after: "上海通勤女生的敏感肌护理记录",
        },
      ],
    });

    const prechecked = await precheck(h, created.id);
    expect(prechecked).toMatchObject({
      status: "awaiting_confirm",
      countsBefore: {
        following: count("128"),
        followers: count("800"),
        likesCollects: count("3200"),
      },
      fields: [{ field: "bio", before: "老简介" }],
      precheck: { accountMatched: true, drift: [] },
    });
    const digest = must(prechecked.precheck);
    expect(digest.confirmDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(digest.expiresAt) - h.clock.now).toBe(30 * MINUTE);
    expect(takeoverOf(await account(h, planned.id)).activeChangeOrderId).toBe(
      created.id,
    );
    expect(await lockFree(h, planned.id)).toBe(false);

    const confirmedAt = h.clock.now;
    const observed = await confirm(h, created.id);
    expect(observed.status).toBe("observing");
    expect(observed.fields[0]).toMatchObject({ outcome: "verified" });
    expect(observed.applyTaskId).toMatch(/^task-\d+$/);
    expect(observed.applyTaskId).not.toBe(XHS_CHANGE_ORDER_TASK_PENDING);
    expect(observed.observation).toMatchObject({
      until: new Date(confirmedAt + 72 * HOUR).toISOString(),
      verdict: "pending",
      auditId: null,
    });
    expect(observed.observation?.baseAuditId).toBe(
      takeoverOf(planned).baselineAuditId,
    );
    const after = await account(h, planned.id);
    expect(takeoverOf(after)).toMatchObject({
      activeChangeOrderId: null,
      observationUntil: new Date(confirmedAt + 72 * HOUR).toISOString(),
      noNurtureDates: [h.today()],
    });
    expect(after.profileDraft).toMatchObject({
      bio: "上海通勤女生的敏感肌护理记录",
      reviewedAt: new Date(confirmedAt).toISOString(),
      applyOperation: { status: "completed", changeOrderId: created.id },
    });
    expect(await lockFree(h, planned.id)).toBe(true);

    expect(h.phone.kinds()).toEqual(["readback", "apply", "verification"]);
    const [verification] = h.phone.bodies("verification");
    expect(verification?.task).toContain('"fields":{"bio":true|false}');
    expect(verification?.task).not.toContain('"occupation"');

    // The window is the order's own: the next batch waits (MT-02).
    const next = await create(h, planned.id, [
      { field: "occupation", after: "摄影师" },
    ]);
    await expect(
      h.orders.precheck(next.id, { expectedUpdatedAt: next.updatedAt }),
    ).rejects.toMatchObject({ status: 409, message: /观察期/ });

    // 72 h later the review re-reads bio with the 号码核对, then A and B.
    h.advance(72 * HOUR + MINUTE);
    const reviewed = await review(h, created.id);
    expect(reviewed.status).toBe("completed");
    expect(reviewed.observation?.verdict).toBe("pass");
    const reviewAudit = must(
      await h.store.getAudit(must(reviewed.observation?.auditId)),
    );
    expect(reviewAudit).toMatchObject({
      trigger: "observation",
      changeOrderId: created.id,
      status: "completed",
    });
    expect(h.phone.kinds().slice(3)).toEqual(["readback", "home", "creator"]);
    // Next batch may now precheck.
    expect((await precheck(h, next.id)).status).toBe("awaiting_confirm");
  });

  it("refuses drift, a foreign digest and a precheck older than 30 minutes", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    // Someone edited the bio on the phone by hand.
    h.phone.profile.bio = "手机上手动改过的简介";
    const drifted = await precheck(h, created.id);
    expect(drifted).toMatchObject({ status: "draft", precheck: null });
    expect(drifted.error).toContain("简介与期望值不一致");
    expect(takeoverOf(await account(h, planned.id)).activeChangeOrderId).toBe(
      null,
    );
    expect(await lockFree(h, planned.id)).toBe(true);
    await expect(
      h.orders.confirm(created.id, {
        confirmDigest: "0".repeat(64),
        expectedUpdatedAt: drifted.updatedAt,
        acks: {},
      }),
    ).rejects.toMatchObject({ status: 409 });

    // Re-audit and confirm the new baseline: the same order prechecks again.
    const audit = await h.audits.startAudit(planned.id);
    await h.audits.waitForAudit(audit.id);
    const rebased = await h.audits.confirmBaseline(audit.id, {
      manualChecked: true,
    });
    expect(rebased.changeOrders.map((entry) => entry.id)).toContain(created.id);
    expect((await order(h, created.id)).fields[0]?.baselineValue).toBe(
      "手机上手动改过的简介",
    );
    const prechecked = await precheck(h, created.id);
    expect(prechecked.status).toBe("awaiting_confirm");

    await expect(
      h.orders.confirm(created.id, {
        confirmDigest: "f".repeat(64),
        expectedUpdatedAt: prechecked.updatedAt,
        acks: {},
      }),
    ).rejects.toMatchObject({ status: 409, message: /预检结果不一致/ });

    h.advance(31 * MINUTE);
    const expired = must(
      (await h.orders.listChangeOrders(planned.id)).find(
        (entry) => entry.id === created.id,
      ),
    );
    expect(expired).toMatchObject({ status: "draft", precheck: null });
    expect(expired.error).toContain("30 分钟");
    await expect(
      h.orders.confirm(created.id, {
        confirmDigest: must(prechecked.precheck).confirmDigest,
        expectedUpdatedAt: expired.updatedAt,
        acks: {},
      }),
    ).rejects.toMatchObject({ status: 409, message: /请先预检/ });
    expect(h.phone.kinds()).not.toContain("apply");
  });

  it("drops a field the new baseline already shows and cancels the emptied order", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    h.phone.profile.bio = "上海通勤女生的敏感肌护理记录";
    const audit = await h.audits.startAudit(planned.id);
    await h.audits.waitForAudit(audit.id);
    await h.audits.confirmBaseline(audit.id, { manualChecked: true });
    expect(await order(h, created.id)).toMatchObject({ status: "cancelled" });
  });

  it("lets a new baseline settle drift on a field an earlier order changed", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const first = await observedTextOrder(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    h.advance(72 * HOUR + MINUTE);
    expect((await review(h, first.id)).status).toBe("completed");

    // Past bio's 7-day self-limit, someone edits the bio by hand.
    h.advance(5 * DAY);
    h.phone.profile.bio = "手机上手动改过的简介";
    const next = await create(h, planned.id, [
      { field: "bio", after: "通勤护肤，记录敏感肌的日常" },
    ]);
    const drifted = await precheck(h, next.id);
    expect(drifted.status).toBe("draft");
    expect(drifted.error).toContain("简介与期望值不一致");

    // The re-audit read the phone after the first order: its value wins.
    const audit = await h.audits.startAudit(planned.id);
    await h.audits.waitForAudit(audit.id);
    await h.audits.confirmBaseline(audit.id, { manualChecked: true });
    const prechecked = await precheck(h, next.id);
    expect(prechecked).toMatchObject({
      status: "awaiting_confirm",
      fields: [{ field: "bio", before: "手机上手动改过的简介" }],
    });
  });

  it("asks for the extra confirmation once the previous review warned", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const first = await observedTextOrder(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    // An exact followers drop of 100 out of 800 warns (§6.4).
    h.advance(72 * HOUR + MINUTE);
    h.phone.header = { ...h.phone.header, followersText: "700" };
    expect(await review(h, first.id)).toMatchObject({
      status: "completed",
      observation: { verdict: "warn" },
    });
    expect(takeoverOf(await account(h, planned.id)).safetyPause).toBe(null);

    const next = await create(h, planned.id, [
      { field: "occupation", after: "摄影师" },
    ]);
    const prechecked = await precheck(h, next.id);
    await expect(
      h.orders.confirm(next.id, {
        confirmDigest: must(prechecked.precheck).confirmDigest,
        expectedUpdatedAt: prechecked.updatedAt,
        acks: {},
      }),
    ).rejects.toMatchObject({ status: 409, message: /复查为 warn/ });
    const observed = await confirm(h, next.id, { warnAcknowledged: true });
    expect(observed).toMatchObject({
      status: "observing",
      acks: { warnAcknowledged: true },
    });
  });

  it("checks MT-03, the takeover pause, the device hold and the phone's policy mode before dispatching", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);

    h.phone.policyMode = "audit";
    await expect(
      h.orders.precheck(created.id, { expectedUpdatedAt: created.updatedAt }),
    ).rejects.toMatchObject({ status: 409, message: /enforce/ });
    h.phone.policyMode = "enforce";

    const run = await h.store.createRun({
      projectId: planned.projectId,
      accountId: planned.id,
      deviceId: DEVICE,
      accountLabel: planned.label,
      date: h.today(),
      status: "completed",
      plan: {
        keywords: [{ keyword: "通勤护肤", count: 1 }],
        homeFeedCount: 0,
        dwellSecMin: 11,
        dwellSecMax: 20,
        interaction: xhsOpsInteractionConfigSchema.parse({}),
      },
      segment: null,
      queuedBehindRunId: null,
      chunks: [],
      summary: {
        plannedTotal: 1,
        browsedTotal: 1,
        searchBrowsed: 1,
        homeBrowsed: 0,
        interactions: { like: 0, collect: 0, follow: 0 },
        anomalyCount: 0,
        durationMs: 1000,
      },
      notes: "",
      error: null,
      startedAt: new Date(h.clock.now).toISOString(),
      completedAt: new Date(h.clock.now).toISOString(),
    });
    await expect(
      h.orders.precheck(created.id, { expectedUpdatedAt: created.updatedAt }),
    ).rejects.toMatchObject({ status: 409, message: /改到明天/ });
    await h.store.deleteRun(run.id);

    const paused = await h.store.pauseTakeover(planned.id, {
      code: "manual",
      reason: "运营手动暂停",
    });
    await expect(
      h.orders.precheck(created.id, { expectedUpdatedAt: created.updatedAt }),
    ).rejects.toMatchObject({ status: 409, message: /账号暂停中/ });
    await h.store.mutateTakeover(paused.id, ({ account: current }) => ({
      account: {
        ...current,
        takeover: {
          ...takeoverOf(current),
          safetyPause: null,
          deviceHold: { taskId: "task-x", sourceRef: "run-1", since: "x" },
        },
      },
      result: null,
    }));
    await expect(
      h.orders.precheck(created.id, { expectedUpdatedAt: created.updatedAt }),
    ).rejects.toMatchObject({ status: 409, message: /停止未确认/ });
    expect(h.phone.dispatched).toEqual([]);
  });

  it("stops a precheck whose task reports another mode, back to draft with the takeover paused (§5.2 前提)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    // The last report said enforce; this task's TASK_START says audit.
    h.phone.queue("readback", { kind: "hang" });
    h.phone.reportOnStart = "audit";
    const back = await precheck(h, created.id);
    expect(back).toMatchObject({
      status: "draft",
      precheck: null,
      error: takeoverPolicyBreachReason("audit"),
    });
    expect(h.phone.cancelled).toHaveLength(1);
    expect(takeoverOf(await account(h, planned.id))).toMatchObject({
      activeChangeOrderId: null,
      deviceHold: null,
      safetyPause: { code: "manual", sourceRef: created.id },
    });
    expect(await lockFree(h, planned.id)).toBe(true);
    // Nothing more goes to this phone.
    const latest = await order(h, created.id);
    await expect(
      h.orders.precheck(created.id, { expectedUpdatedAt: latest.updatedAt }),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.phone.kinds()).toEqual(["readback"]);
  });

  it("stops an apply whose task reports another mode: its fields may have changed, so it waits for verify", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    expect((await precheck(h, created.id)).status).toBe("awaiting_confirm");
    h.phone.queue("apply", { kind: "hang" });
    h.phone.reportOnStart = "off";
    const stopped = await confirm(h, created.id);
    expect(stopped).toMatchObject({
      status: "interrupted",
      fields: [{ field: "bio", outcome: "uncertain" }],
    });
    expect(stopped.error).toContain(takeoverPolicyBreachReason("off"));
    expect(h.phone.kinds()).toEqual(["readback", "apply"]);
    expect(h.phone.cancelled).toHaveLength(1);
    expect(takeoverOf(await account(h, planned.id))).toMatchObject({
      activeChangeOrderId: created.id,
      deviceHold: null,
      safetyPause: { code: "manual", sourceRef: created.id },
      noNurtureDates: [h.today()],
    });
    expect(h.store.isDeviceBindingActive(planned.id, DEVICE)).toBe(false);
  });

  it("records the day as no-nurture even when every field fails, and keeps the platform's limit wording", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    await precheck(h, created.id);
    h.phone.queue("apply", {
      kind: "message",
      message: applyMessage(
        { bio: "failed" },
        {
          fieldCodes: { bio: "platform_limit" },
          note: "简介修改次数已达上限，请 7 天后再试",
        },
      ),
    });
    const failed = await confirm(h, created.id);
    expect(failed).toMatchObject({
      status: "failed",
      fields: [{ field: "bio", outcome: "failed", code: "platform_limit" }],
    });
    const after = takeoverOf(await account(h, planned.id));
    expect(after.noNurtureDates).toEqual([h.today()]);
    // Nothing went public: no observation window.
    expect(after.observationUntil).toBe(null);
    expect(after.activeChangeOrderId).toBe(null);
    expect(after.platformLimitNotices).toEqual([
      {
        field: "bio",
        text: "简介修改次数已达上限，请 7 天后再试",
        observedAt: new Date(h.clock.now).toISOString(),
        blockedUntil: new Date(h.clock.now + 7 * DAY).toISOString(),
        sourceTaskId: failed.applyTaskId,
      },
    ]);
    expect(h.phone.kinds()).toEqual(["readback", "apply"]);
  });

  it("fails a text field the verification does not see, and still opens the observation window", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    await precheck(h, created.id);
    // The phone says done but the profile never changed.
    h.phone.queue("apply", {
      kind: "message",
      message: applyMessage({ bio: "done" }),
    });
    const failed = await confirm(h, created.id);
    expect(failed).toMatchObject({
      status: "failed",
      fields: [{ field: "bio", outcome: "mismatch" }],
    });
    expect(failed.error).toContain("简介与目标值不一致");
    expect(takeoverOf(await account(h, planned.id))).toMatchObject({
      activeChangeOrderId: null,
      observationUntil: new Date(h.clock.now + 72 * HOUR).toISOString(),
      safetyPause: null,
    });
  });

  it("holds a moved following count for a human before observing", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    await precheck(h, created.id);
    h.phone.queue("apply", {
      kind: "message",
      message: applyMessage({ bio: "done" }),
      effect: () => {
        h.phone.profile.bio = "上海通勤女生的敏感肌护理记录";
        h.phone.header = { ...h.phone.header, followingText: "129" };
      },
    });
    const held = await confirm(h, created.id);
    expect(held).toMatchObject({
      status: "awaiting_manual_check",
      flags: ["countsChanged"],
      countsAfter: { following: count("129") },
    });
    expect(takeoverOf(await account(h, planned.id)).activeChangeOrderId).toBe(
      created.id,
    );
    const checked = await h.orders.manualCheck(created.id, {
      expectedUpdatedAt: held.updatedAt,
    });
    expect(checked.order.status).toBe("observing");
    expect(checked.order.manualCheckAt).not.toBe(null);
    expect(takeoverOf(checked.account).activeChangeOrderId).toBe(null);
  });

  it("stops the phone task on CALL_USER and leaves the order interrupted until verify", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    await precheck(h, created.id);
    h.phone.queue("apply", { kind: "interaction" });
    const interrupted = await confirm(h, created.id);
    expect(interrupted).toMatchObject({
      status: "interrupted",
      fields: [{ field: "bio", outcome: "uncertain" }],
    });
    expect(h.phone.cancelled).toEqual([interrupted.applyTaskId]);
    const held = await account(h, planned.id);
    expect(takeoverOf(held)).toMatchObject({
      activeChangeOrderId: created.id,
      deviceHold: null,
    });
    expect(held.profileDraft.applyOperation?.status).toBe("completed");
    expect(await lockFree(h, planned.id)).toBe(false);
    expect(
      xhsOpsTakeoverFieldBudgetState(
        "bio",
        {
          orders: await h.store.listChangeOrders({ accountId: planned.id }),
          notices: [],
        },
        h.clock.now,
      ).used,
    ).toBe(1);

    // The phone did write it after all; verify re-checks the uncertain field.
    h.phone.profile.bio = "上海通勤女生的敏感肌护理记录";
    h.phone.queue("verification", { kind: "interaction" });
    const again = await verifyAgain(h, created.id);
    expect(again.status).toBe("interrupted");
    expect(h.phone.cancelled).toHaveLength(2);
    const verified = await verifyAgain(h, created.id);
    expect(verified).toMatchObject({
      status: "observing",
      fields: [{ field: "bio", outcome: "verified" }],
    });
    expect(h.phone.kinds()).toEqual([
      "readback",
      "apply",
      "verification",
      "verification",
    ]);
  });

  it("holds the device when a stop goes unconfirmed, for precheck and apply alike", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    h.phone.confirmCancel = false;
    h.phone.queue("readback", { kind: "interaction" });
    const back = await precheck(h, created.id);
    expect(back).toMatchObject({ status: "draft", precheck: null });
    let current = await account(h, planned.id);
    expect(takeoverOf(current).deviceHold).toMatchObject({
      sourceRef: created.id,
    });
    expect(takeoverOf(current).activeChangeOrderId).toBe(null);

    // A human confirms on the phone; the kept lock goes back with the hold.
    h.phone.finish(must(h.phone.cancelled[0]), {});
    h.phone.confirmCancel = true;
    current = await h.store.releaseTakeoverDeviceHold(planned.id, {
      expectedUpdatedAt: current.updatedAt,
      stoppedOnPhone: true,
    });
    expect(await lockFree(h, planned.id)).toBe(true);

    await precheck(h, created.id);
    h.phone.confirmCancel = false;
    h.phone.queue("apply", { kind: "interaction" });
    const interrupted = await confirm(h, created.id);
    expect(interrupted.status).toBe("interrupted");
    current = await account(h, planned.id);
    expect(takeoverOf(current).deviceHold).toMatchObject({
      taskId: interrupted.applyTaskId,
      sourceRef: created.id,
    });
    // The ledger stays open for the reconcile sweep; the device stays held.
    expect(current.profileDraft.applyOperation?.status).toBe("running");
    expect(await lockFree(h, planned.id)).toBe(false);
    await expect(
      h.orders.verify(created.id, { expectedUpdatedAt: interrupted.updatedAt }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("keeps verify at 409 while the phone cannot be queried to settle the apply", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    await precheck(h, created.id);
    h.phone.confirmCancel = false;
    h.phone.queue("apply", { kind: "interaction" });
    const interrupted = await confirm(h, created.id);
    const held = await account(h, planned.id);
    expect(held.profileDraft.applyOperation?.status).toBe("running");

    // A human confirms on the phone; the apply ledger is still unsettled.
    h.phone.finish(must(interrupted.applyTaskId), {});
    await h.store.releaseTakeoverDeviceHold(planned.id, {
      expectedUpdatedAt: held.updatedAt,
      stoppedOnPhone: true,
    });
    h.phone.getDeviceThrows = true;
    await expect(
      h.orders.verify(created.id, {
        expectedUpdatedAt: (await order(h, created.id)).updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409, message: /修改任务结果还没确认/ });

    h.phone.getDeviceThrows = false;
    h.phone.profile.bio = "上海通勤女生的敏感肌护理记录";
    expect(await verifyAgain(h, created.id)).toMatchObject({
      status: "observing",
      fields: [{ field: "bio", outcome: "verified" }],
    });
  });

  it("settles a receipt-less apply as uncertain, and a later readback takes it out of the budget", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    await precheck(h, created.id);
    h.phone.queue("apply", { kind: "message", message: "已修改完成" });
    const interrupted = await confirm(h, created.id);
    expect(interrupted).toMatchObject({
      status: "interrupted",
      fields: [{ field: "bio", outcome: "uncertain" }],
    });
    expect(interrupted.error).toContain("没有取到手机的修改回执");

    // The bio never changed: verify fails the order, the field stays uncertain.
    const failed = await verifyAgain(h, created.id);
    expect(failed).toMatchObject({
      status: "failed",
      fields: [{ field: "bio", outcome: "uncertain" }],
    });
    expect(takeoverOf(await account(h, planned.id)).observationUntil).toBe(
      new Date(h.clock.now + 72 * HOUR).toISOString(),
    );

    // After the window — still inside bio's 7-day self-limit — the next
    // order's readback shows the old bio, which settles the uncertain field.
    h.advance(72 * HOUR + MINUTE);
    const next = await create(h, planned.id, [
      { field: "bio", after: "通勤护肤，记录敏感肌的日常" },
    ]);
    const prechecked = await precheck(h, next.id);
    expect(prechecked.status).toBe("awaiting_confirm");
    expect((await order(h, created.id)).fields[0]).toMatchObject({
      outcome: "skipped",
    });
  });

  it("reads a PROFILE_JSON out of an aborted task", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    await precheck(h, created.id);
    h.phone.queue("apply", {
      kind: "result",
      result: {
        success: false,
        status: "aborted",
        message: `修改后返回时出错\n${PROFILE_JSON_MARKER}${JSON.stringify({ bio: "done", fieldCodes: {}, note: "" })}`,
      },
    });
    h.phone.profile.bio = "上海通勤女生的敏感肌护理记录";
    const observed = await confirm(h, created.id);
    expect(observed.status).toBe("observing");
  });

  it("recovers the apply receipt after a controller restart, then verifies into observation", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    await precheck(h, created.id);
    h.phone.queue("apply", { kind: "hang" });
    const current = await order(h, created.id);
    await h.orders.confirm(created.id, {
      confirmDigest: must(current.precheck).confirmDigest,
      expectedUpdatedAt: current.updatedAt,
      acks: {},
    });
    const taskId = await until(async () => {
      const applying = await order(h, created.id);
      return applying.applyTaskId !== XHS_CHANGE_ORDER_TASK_PENDING
        ? applying.applyTaskId
        : null;
    }, "apply task id");

    // The controller dies; the phone finishes the apply on its own.
    h.phone.forgetPending();
    const restarted = h.servicesFor(h.reopen());
    const recovery = await restarted.store.recoverInterruptedTakeoverWork();
    expect(recovery.changeOrders).toEqual([
      expect.objectContaining({ previousStatus: "applying", taskId }),
    ]);
    h.phone.profile.bio = "上海通勤女生的敏感肌护理记录";
    h.phone.finish(taskId, { message: applyMessage({ bio: "done" }) });
    const outcomes = await restarted.orders.reconcileInterruptedOrders(
      recovery.changeOrders,
    );
    expect(outcomes).toEqual([
      { orderId: created.id, outcome: "ended", taskId },
    ]);
    const recovered = await order(restarted, created.id);
    expect(recovered).toMatchObject({
      status: "interrupted",
      fields: [{ field: "bio", outcome: "done" }],
    });
    expect(recovered.error).toContain("已事后取回修改回执");
    expect(
      (await account(restarted, planned.id)).profileDraft.applyOperation
        ?.status,
    ).toBe("completed");

    const verified = await verifyAgain(restarted, created.id);
    expect(verified.status).toBe("observing");
    expect(
      takeoverOf(await account(restarted, planned.id)).activeChangeOrderId,
    ).toBe(null);
  });

  it("stops the still-running apply by id after a restart", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    await precheck(h, created.id);
    h.phone.queue("apply", { kind: "hang" });
    const current = await order(h, created.id);
    await h.orders.confirm(created.id, {
      confirmDigest: must(current.precheck).confirmDigest,
      expectedUpdatedAt: current.updatedAt,
      acks: {},
    });
    const taskId = await until(async () => {
      const applying = await order(h, created.id);
      return applying.applyTaskId !== XHS_CHANGE_ORDER_TASK_PENDING
        ? applying.applyTaskId
        : null;
    }, "apply task id");
    h.phone.forgetPending();
    const restarted = h.servicesFor(h.reopen());
    const recovery = await restarted.store.recoverInterruptedTakeoverWork();
    const outcomes = await restarted.orders.reconcileInterruptedOrders(
      recovery.changeOrders,
    );
    expect(outcomes).toEqual([
      { orderId: created.id, outcome: "stopped", taskId },
    ]);
    expect(h.phone.cancelled).toEqual([taskId]);
    expect(await order(restarted, created.id)).toMatchObject({
      status: "interrupted",
      fields: [{ field: "bio", outcome: "uncertain" }],
    });
  });

  it("stops a verification cut off by a restart, keeps the done field and verifies again", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    await precheck(h, created.id);
    h.phone.queue("verification", { kind: "hang" });
    const current = await order(h, created.id);
    await h.orders.confirm(created.id, {
      confirmDigest: must(current.precheck).confirmDigest,
      expectedUpdatedAt: current.updatedAt,
      acks: {},
    });
    const taskId = await until(async () => {
      const verifying = await order(h, created.id);
      return verifying.status === "verifying"
        ? verifying.verificationTaskId
        : null;
    }, "verification task id");

    h.phone.forgetPending();
    const restarted = h.servicesFor(h.reopen());
    const recovery = await restarted.store.recoverInterruptedTakeoverWork();
    expect(recovery.changeOrders).toEqual([
      expect.objectContaining({ previousStatus: "verifying", taskId }),
    ]);
    const outcomes = await restarted.orders.reconcileInterruptedOrders(
      recovery.changeOrders,
    );
    expect(outcomes).toEqual([
      { orderId: created.id, outcome: "stopped", taskId },
    ]);
    expect(h.phone.cancelled).toEqual([taskId]);
    expect(await order(restarted, created.id)).toMatchObject({
      status: "interrupted",
      fields: [{ field: "bio", outcome: "done" }],
    });
    expect(
      takeoverOf(await account(restarted, planned.id)).activeChangeOrderId,
    ).toBe(created.id);

    const verified = await verifyAgain(restarted, created.id);
    expect(verified).toMatchObject({
      status: "observing",
      fields: [{ field: "bio", outcome: "verified" }],
    });
    expect(h.phone.kinds()).toEqual([
      "readback",
      "apply",
      "verification",
      "verification",
    ]);
  });

  it("stops the retried precheck task, not the blocked first one, after a restart", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    // POLICY_ACTION_NOT_ALLOWED earns one retry (§3.1 表二); it keeps running.
    h.phone.queue(
      "readback",
      {
        kind: "result",
        result: {
          success: false,
          status: "failed",
          errorCode: "POLICY_ACTION_NOT_ALLOWED",
          message: "POLICY_ACTION_NOT_ALLOWED: SLIDE",
        },
      },
      { kind: "hang" },
    );
    await h.orders.precheck(created.id, {
      expectedUpdatedAt: created.updatedAt,
    });
    const retryId = await until(
      async () =>
        h.phone.dispatched.length === 2 ? h.phone.currentTaskId : null,
      "precheck retry",
    );
    await until(
      async () => (await order(h, created.id)).precheckTaskId === retryId,
      "retry task id",
    );

    h.phone.forgetPending();
    const restarted = h.servicesFor(h.reopen());
    const recovery = await restarted.store.recoverInterruptedTakeoverWork();
    expect(recovery.changeOrders).toEqual([
      expect.objectContaining({
        previousStatus: "prechecking",
        taskId: retryId,
      }),
    ]);
    const outcomes = await restarted.orders.reconcileInterruptedOrders(
      recovery.changeOrders,
    );
    expect(outcomes).toEqual([
      { orderId: created.id, outcome: "stopped", taskId: retryId },
    ]);
    expect(h.phone.cancelled).toEqual([retryId]);
    expect(await order(restarted, created.id)).toMatchObject({
      status: "draft",
      precheck: null,
    });
    expect(
      takeoverOf(await account(restarted, planned.id)).activeChangeOrderId,
    ).toBe(null);
  });

  it("sends an existing account's apply() away and cancels only unstarted orders", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    await expect(h.profile.apply(planned.id)).rejects.toMatchObject({
      status: 409,
      message: "已有账号请先开始接管，资料修改走变更单",
    });
    const created = await create(h, planned.id, [
      { field: "occupation", after: "摄影师" },
    ]);
    await expect(h.profile.applyChangeOrder(created.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      create(h, planned.id, [{ field: "occupation", after: "灵魂画手" }]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      create(h, planned.id, [{ field: "region", after: "上海" }]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      create(h, planned.id, [
        { field: "bio", after: "新简介" },
        { field: "nickname", after: "新昵称" },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      create(h, planned.id, [{ field: "bio", after: "老简介" }]),
    ).rejects.toMatchObject({ status: 409 });
    const cancelled = await h.orders.cancel(created.id, {
      expectedUpdatedAt: created.updatedAt,
    });
    expect(cancelled.order.status).toBe("cancelled");
    expect(h.phone.dispatched).toEqual([]);
  });

  it("keeps the change-order path free of preparation, SMS and settings in every dispatched policy", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    await pastFirstObservation(h, planned);
    const created = await create(h, planned.id, [
      { field: "nickname", after: "通勤护肤日记" },
      { field: "region", after: "中国 北京 北京" },
    ]);
    const prechecked = await precheck(h, created.id);
    await expect(
      h.orders.confirm(created.id, {
        confirmDigest: must(prechecked.precheck).confirmDigest,
        expectedUpdatedAt: prechecked.updatedAt,
        acks: {},
      }),
    ).rejects.toMatchObject({ status: 409, message: /二次确认/ });
    const observed = await confirm(h, created.id, { l2SecondCheck: true });
    expect(observed.status).toBe("observing");
    expect(observed.acks).toEqual({ l2SecondCheck: true });

    expect(h.phone.kinds()).toEqual(["readback", "apply", "verification"]);
    for (const { body } of h.phone.dispatched) {
      const policy = must(body.taskPolicy);
      expect(policy.allowedAppRoles ?? []).not.toContain("default_sms");
      expect(policy.allowedAppRoles ?? []).not.toContain("system_settings");
      const actions = policy.allowedActions ?? [];
      if (actions.includes("TYPE")) {
        expect(policy.operationClass).not.toBe("account.login");
        expect(policy.confirmationPolicy?.login).toBe("forbidden");
      }
      expect(body.task).not.toContain("PREPARATION_JSON:");
    }
    const [readback] = h.phone.bodies("readback");
    expect(readback?.taskPolicy).toEqual(XHS_AUDIT_TASK_POLICY);
    const [apply] = h.phone.bodies("apply");
    expect(apply?.taskPolicy).toEqual(XHS_TAKEOVER_APPLY_TASK_POLICY);
    const applyActions = apply?.taskPolicy?.allowedActions ?? [];
    for (const absent of ["ENTER", "LONGPRESS", "LONGPRESSANDDRAG"])
      expect(applyActions).not.toContain(absent);
    for (const named of [
      "FLING",
      "SLIDE",
      "TYPE",
      "SCROLL",
      "ABORT",
      "COMPLETE",
    ]) {
      expect(apply?.task).toContain(named);
      expect(applyActions).toContain(named);
    }
    expect(apply).toMatchObject({ maxSteps: 60, timeout: 900_000 });
    const [verification] = h.phone.bodies("verification");
    expect(verification?.taskPolicy?.confirmationPolicy?.login).toBe(
      "forbidden",
    );
    expect(verification?.taskPolicy?.allowedActions).not.toContain("TYPE");
    expect(verification).toMatchObject({ maxSteps: 40, timeout: 180_000 });
    expect(h.phone.profile).toMatchObject({
      nickname: "通勤护肤日记",
      region: "中国 北京 北京",
    });
  });

  it("verifies a field the apply receipt left out along with the one it reported (B3)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const bio = "上海通勤女生的敏感肌护理记录";
    const created = await create(h, planned.id, [
      { field: "bio", after: bio },
      { field: "occupation", after: "摄影师" },
    ]);
    await precheck(h, created.id);
    // The phone changed both, but its PROFILE_JSON only names the bio.
    h.phone.queue("apply", {
      kind: "message",
      message: applyMessage({ bio: "done" }),
      effect: () => {
        h.phone.profile.bio = bio;
        h.phone.profile.occupation = "摄影师";
      },
    });
    const observed = await confirm(h, created.id);
    expect(observed).toMatchObject({
      status: "observing",
      fields: [
        { field: "bio", outcome: "verified" },
        { field: "occupation", outcome: "verified" },
      ],
    });
    expect(h.phone.kinds()).toEqual(["readback", "apply", "verification"]);
    const [verification] = h.phone.bodies("verification");
    expect(requestedFields(must(verification).task)).toEqual([
      "bio",
      "occupation",
    ]);
  });

  it("records a platform limit only for the field the note is about, not one the receipt reports done (B4)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const bio = "上海通勤女生的敏感肌护理记录";
    const created = await create(h, planned.id, [
      { field: "bio", after: bio },
      { field: "occupation", after: "摄影师" },
    ]);
    await precheck(h, created.id);
    const note = "简介已改好；职业修改次数已达上限，请 14 天后再试";
    h.phone.queue("apply", {
      kind: "message",
      message: applyMessage({ bio: "done", occupation: "failed" }, { note }),
      effect: () => {
        h.phone.profile.bio = bio;
      },
    });
    const observed = await confirm(h, created.id);
    expect(observed).toMatchObject({
      status: "observing",
      fields: [
        { field: "bio", outcome: "verified" },
        { field: "occupation", outcome: "failed" },
      ],
    });
    expect(
      takeoverOf(await account(h, planned.id)).platformLimitNotices,
    ).toEqual([
      {
        field: "occupation",
        text: note,
        observedAt: new Date(h.clock.now).toISOString(),
        blockedUntil: new Date(h.clock.now + 14 * DAY).toISOString(),
        sourceTaskId: observed.applyTaskId,
      },
    ]);
  });

  it("starts 「预检」 again on the first click once the 30 minutes ran out (B7)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    const first = await precheck(h, created.id);
    expect(first.status).toBe("awaiting_confirm");
    h.advance(31 * MINUTE);
    // The card still holds the awaiting_confirm revision: nothing read the order since.
    expect(await order(h, created.id)).toMatchObject({
      status: "awaiting_confirm",
      updatedAt: first.updatedAt,
    });
    const again = await precheck(h, created.id);
    expect(again).toMatchObject({ status: "awaiting_confirm", error: null });
    expect(must(again.precheck).readAt).toBe(
      new Date(h.clock.now).toISOString(),
    );
    expect(h.phone.kinds()).toEqual(["readback", "readback"]);
    // Any other revision is still someone else's change.
    await expect(
      h.orders.precheck(created.id, { expectedUpdatedAt: first.updatedAt }),
    ).rejects.toMatchObject({ status: 409, message: /已更新/ });
  });

  it("expects an order's after once its review failed: no false 「已是这个值」 or drift on the next bio order (B2)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const changed = "上海通勤女生的敏感肌护理记录";
    const first = await observedTextOrder(h, planned.id, [
      { field: "bio", after: changed },
    ]);
    // A sign-out inside the window fails the review; the bio stays changed.
    h.advance(DAY);
    await h.store.pauseTakeover(planned.id, {
      code: "login_required",
      reason: "手机上的账号已退出登录",
      sourceRef: "run-1",
    });
    h.advance(48 * HOUR + MINUTE);
    expect(await review(h, first.id)).toMatchObject({
      status: "failed",
      observation: { verdict: "fail" },
      fields: [{ field: "bio", outcome: "verified" }],
    });
    const paused = must(takeoverOf(await account(h, planned.id)).safetyPause);
    expect(paused).toMatchObject({
      code: "observation_failed",
      sourceRef: first.id,
    });
    await h.store.resumeTakeover(planned.id, {
      pauseSince: paused.since,
      reason: "已在手机上重新登录并检查资料",
      gateReady: true,
    });

    // Going back to the old bio is a real change, not 「已是这个值」.
    const back = await create(h, planned.id, [
      { field: "bio", after: "老简介" },
    ]);
    await h.orders.cancel(back.id, { expectedUpdatedAt: back.updatedAt });

    // Past bio's 7-day self-limit, the next bio order sees no drift.
    h.advance(4 * DAY);
    const next = await create(h, planned.id, [
      { field: "bio", after: "通勤护肤，记录敏感肌的日常" },
    ]);
    expect(await precheck(h, next.id)).toMatchObject({
      status: "awaiting_confirm",
      error: null,
      fields: [{ field: "bio", before: changed }],
    });
  });

  it("expects the after of an uncertain field a later readback settled to done (B2)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const changed = "上海通勤女生的敏感肌护理记录";
    const first = await create(h, planned.id, [
      { field: "bio", after: changed },
    ]);
    await precheck(h, first.id);
    h.phone.queue("apply", { kind: "message", message: "已修改完成" });
    expect((await confirm(h, first.id)).status).toBe("interrupted");
    // The verification still shows the old bio: the order fails, the field stays uncertain.
    expect(await verifyAgain(h, first.id)).toMatchObject({
      status: "failed",
      fields: [{ field: "bio", outcome: "uncertain" }],
    });

    // The new bio shows up after all; an occupation order's readback settles it to done.
    h.phone.profile.bio = changed;
    h.advance(72 * HOUR + MINUTE);
    const occupation = await create(h, planned.id, [
      { field: "occupation", after: "摄影师" },
    ]);
    const prechecked = await precheck(h, occupation.id);
    expect(prechecked.status).toBe("awaiting_confirm");
    expect((await order(h, first.id)).fields[0]).toMatchObject({
      outcome: "done",
    });
    await h.orders.cancel(occupation.id, {
      expectedUpdatedAt: prechecked.updatedAt,
    });

    const back = await create(h, planned.id, [
      { field: "bio", after: "老简介" },
    ]);
    await h.orders.cancel(back.id, { expectedUpdatedAt: back.updatedAt });
    h.advance(4 * DAY);
    const next = await create(h, planned.id, [
      { field: "bio", after: "通勤护肤，记录敏感肌的日常" },
    ]);
    expect(await precheck(h, next.id)).toMatchObject({
      status: "awaiting_confirm",
      fields: [{ field: "bio", before: changed }],
    });
  });

  it("refuses a nickname order until an earlier order of the 小红书号 finished its observation (B9, §8.1)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const nickname = await create(h, planned.id, [
      { field: "nickname", after: "通勤护肤日记" },
    ]);
    await expect(
      h.orders.precheck(nickname.id, { expectedUpdatedAt: nickname.updatedAt }),
    ).rejects.toMatchObject({ status: 409, message: /第一个观察期内不改/ });
    expect(h.phone.dispatched).toEqual([]);
    const ledger = async () => ({
      orders: await h.store.listChangeOrders({ accountId: planned.id }),
      notices: [],
    });
    // No observation has begun yet: the budget has no date to show.
    expect(
      xhsOpsTakeoverFieldBudgetState("nickname", await ledger(), h.clock.now)
        .blockedUntil,
    ).toBe(null);

    // While the first observation runs, the budget shows its end.
    const first = await observedTextOrder(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    expect(
      xhsOpsTakeoverFieldBudgetState("nickname", await ledger(), h.clock.now)
        .blockedUntil,
    ).toBe(must(first.observation).until);

    h.advance(72 * HOUR + MINUTE);
    expect((await review(h, first.id)).status).toBe("completed");
    expect(
      xhsOpsTakeoverFieldBudgetState("nickname", await ledger(), h.clock.now)
        .blockedUntil,
    ).toBe(null);
    expect(await precheck(h, nickname.id)).toMatchObject({
      status: "awaiting_confirm",
      fields: [{ field: "nickname", before: "老昵称" }],
    });
  });
});

// ─── Identity ───────────────────────────────────────────────────────────────

describe("change order: identity", () => {
  it("fails a precheck on another 小红书号 and pauses the takeover", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    h.phone.accountMatched = false;
    const failed = await precheck(h, created.id);
    expect(failed.status).toBe("failed");
    expect(takeoverOf(await account(h, planned.id))).toMatchObject({
      activeChangeOrderId: null,
      observationUntil: null,
      safetyPause: { code: "account_mismatch", sourceRef: created.id },
    });
  });

  it("re-locks before verify, and fails an interrupted order once another 小红书号 is locked", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    await precheck(h, created.id);
    h.phone.queue("apply", { kind: "interaction" });
    const interrupted = await confirm(h, created.id);
    expect(interrupted.status).toBe("interrupted");

    await invalidateIdentity(h, planned.id);
    expect(takeoverOf(await account(h, planned.id)).identityConfirmedAt).toBe(
      null,
    );
    await expect(
      h.orders.verify(created.id, {
        expectedUpdatedAt: (await order(h, created.id)).updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409, message: /重新锁定身份/ });

    h.advance(MINUTE);
    await h.store.recordTakeoverIdentityRead(planned.id, {
      taskId: "identity-relock",
      deviceId: DEVICE,
      screenshotUrl: null,
      readAccountId: XHS_ID,
    });
    await h.store.confirmTakeoverIdentity(planned.id, {
      identityTaskId: "identity-relock",
      platformAccountId: XHS_ID,
    });
    h.phone.profile.bio = "上海通勤女生的敏感肌护理记录";
    expect((await verifyAgain(h, created.id)).status).toBe("observing");
  });

  it("fails an interrupted order for good once another 小红书号 is locked", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    await precheck(h, created.id);
    h.phone.queue("apply", { kind: "interaction" });
    await confirm(h, created.id);
    h.advance(MINUTE);
    await h.store.recordTakeoverIdentityRead(planned.id, {
      taskId: "identity-other",
      deviceId: DEVICE,
      screenshotUrl: null,
      readAccountId: "xhs-someone-else",
    });
    await h.store.confirmTakeoverIdentity(planned.id, {
      identityTaskId: "identity-other",
      platformAccountId: "xhs-someone-else",
    });
    expect(takeoverOf(await account(h, planned.id)).activeChangeOrderId).toBe(
      created.id,
    );
    const result = await h.orders.verify(created.id, {
      expectedUpdatedAt: (await order(h, created.id)).updatedAt,
    });
    expect(result.order.status).toBe("failed");
    expect(result.order.error).toContain("另一个小红书号");
    expect(takeoverOf(result.account).activeChangeOrderId).toBe(null);
    expect(h.phone.kinds()).toEqual(["readback", "apply"]);
  });

  it("closes an observing order whose 小红书号 is no longer the locked one", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const observed = await observedTextOrder(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    h.advance(72 * HOUR + MINUTE);
    await h.store.recordTakeoverIdentityRead(planned.id, {
      taskId: "identity-other",
      deviceId: DEVICE,
      screenshotUrl: null,
      readAccountId: "xhs-someone-else",
    });
    await h.store.confirmTakeoverIdentity(planned.id, {
      identityTaskId: "identity-other",
      platformAccountId: "xhs-someone-else",
    });
    const result = await h.orders.reviewObservation(observed.id, {
      expectedUpdatedAt: (await order(h, observed.id)).updatedAt,
    });
    expect(result.order.status).toBe("failed");
    expect(result.order.error).toContain("无法再复查");
    expect(h.phone.kinds()).toEqual(["readback", "apply", "verification"]);
  });

  it("fails a review on a sign-out without calling it a 号码 mismatch", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const observed = await observedTextOrder(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    // A pre-run gate found the phone signed out inside the window.
    h.advance(DAY);
    await h.store.pauseTakeover(planned.id, {
      code: "login_required",
      reason: "手机上的账号已退出登录",
      sourceRef: "run-1",
    });
    h.advance(48 * HOUR + MINUTE);
    h.phone.queue("readback", {
      kind: "message",
      message: receipt(XHS_PROFILE_READBACK_MARKER, {
        v: 1,
        status: "unavailable",
        accountMatched: false,
        nickname: "",
        bio: "",
        occupation: "",
        gender: "",
        birthdayFilled: false,
        region: "",
      }),
    });
    const reviewed = await review(h, observed.id);
    expect(reviewed).toMatchObject({
      status: "failed",
      observation: {
        verdict: "fail",
        notes: ["观察期内出现风控信号：需要登录"],
      },
    });
    expect(takeoverOf(await account(h, planned.id)).safetyPause).toMatchObject({
      code: "observation_failed",
      sourceRef: observed.id,
    });
    expect(h.phone.kinds().slice(3)).toEqual(["readback"]);
  });

  it("lets a human finish the image comparison after the identity changed", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "avatar", after: "清爽职场半身照方向" },
    ]);
    await upload(h, created.id, "avatar");
    await precheck(h, created.id);
    const waiting = await confirm(h, created.id, ALL_IMAGE_ACKS);
    expect(waiting.status).toBe("awaiting_visual_check");
    await invalidateIdentity(h, planned.id);
    expect((await order(h, created.id)).status).toBe("awaiting_visual_check");
    const observed = await visual(h, created.id, "avatar", "match");
    expect(observed.status).toBe("observing");
  });
});

// ─── Image orders ───────────────────────────────────────────────────────────

describe("change order: images", () => {
  it("validates uploads and stores them under media/xhs-takeover/<orderId>/", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "avatar", after: "清爽职场半身照方向" },
    ]);
    expect(created.fields[0]).toMatchObject({
      baselineValue: "",
      imagePath: null,
    });
    await expect(
      h.orders.precheck(created.id, { expectedUpdatedAt: created.updatedAt }),
    ).rejects.toMatchObject({ status: 409, message: /请先上传头像/ });

    await expect(
      upload(h, created.id, "avatar", "data:image/gif;base64,R0lGODlh"),
    ).rejects.toThrow();
    await expect(
      upload(
        h,
        created.id,
        "avatar",
        `data:image/png;base64,${Buffer.from("not a png").toString("base64")}`,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      upload(
        h,
        created.id,
        "avatar",
        `data:image/png;base64,${Buffer.concat([PNG_MAGIC, Buffer.alloc(10 * 1024 * 1024)]).toString("base64")}`,
      ),
    ).rejects.toMatchObject({ status: 400, message: /10MB/ });
    await expect(upload(h, created.id, "cover")).rejects.toMatchObject({
      status: 400,
    });

    const uploaded = await upload(h, created.id, "avatar", pngDataUrl("v1"));
    const target = join(h.mediaRoot, "xhs-takeover", created.id, "avatar.png");
    const bytes = readFileSync(target);
    expect(uploaded.fields[0]).toMatchObject({
      imagePath: target,
      imageSha256: createHash("sha256").update(bytes).digest("hex"),
    });

    const prechecked = await precheck(h, created.id);
    expect(prechecked.status).toBe("awaiting_confirm");
    expect(prechecked.fields[0]).toMatchObject({
      before: "",
      beforeScreenshotUrl: expect.stringMatching(
        /^\/api\/v1\/media\/screenshots\/task-\d+\.png$/,
      ),
    });
    // The image precheck ends back on 「我」 so the screenshot shows the pictures.
    expect(h.phone.bodies("readback")[0]?.task).toContain(
      "头像、背景图和头部计数重新展开后直接 COMPLETE",
    );

    // A new picture voids the precheck.
    const replaced = await upload(h, created.id, "avatar", pngDataUrl("v2"));
    expect(replaced).toMatchObject({ status: "draft", precheck: null });
    expect(takeoverOf(await account(h, planned.id)).activeChangeOrderId).toBe(
      null,
    );

    // A picture swapped on disk after the precheck is refused at confirm.
    const again = await precheck(h, created.id);
    const imagePath = must(again.fields[0]?.imagePath);
    writeFileSync(imagePath, Buffer.concat([PNG_MAGIC, Buffer.from("x")]));
    await expect(
      h.orders.confirm(created.id, {
        confirmDigest: must(again.precheck).confirmDigest,
        expectedUpdatedAt: again.updatedAt,
        acks: ALL_IMAGE_ACKS,
      }),
    ).rejects.toMatchObject({ status: 409, message: /图片文件已变化/ });
  });

  it("refuses image fields on phones below Android 10 or without a version", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    h.phone.osVersion = "Android 9";
    await expect(
      create(h, planned.id, [{ field: "avatar", after: "清爽职场半身照方向" }]),
    ).rejects.toMatchObject({
      status: 409,
      message: XHS_TAKEOVER_IMAGE_UNSUPPORTED_MESSAGE,
    });
    h.phone.osVersion = undefined;
    await expect(
      create(h, planned.id, [{ field: "cover", after: "城市天际线方向" }]),
    ).rejects.toMatchObject({ status: 409 });

    h.phone.osVersion = "Android 12";
    const created = await create(h, planned.id, [
      { field: "cover", after: "城市天际线方向" },
    ]);
    const uploaded = await upload(h, created.id, "cover");
    h.phone.osVersion = "28";
    await expect(
      h.orders.precheck(created.id, { expectedUpdatedAt: uploaded.updatedAt }),
    ).rejects.toMatchObject({
      status: 409,
      message: XHS_TAKEOVER_IMAGE_UNSUPPORTED_MESSAGE,
    });
    expect(h.phone.dispatched).toEqual([]);
  });

  it("sends an image order back to draft when the picture push itself fails", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "avatar", after: "清爽职场半身照方向" },
    ]);
    await upload(h, created.id, "avatar");
    await precheck(h, created.id);
    h.phone.pushThrows = true;
    const back = await confirm(h, created.id, ALL_IMAGE_ACKS);
    expect(back).toMatchObject({
      status: "draft",
      precheck: null,
      confirmedAt: null,
      applyTaskId: null,
      fields: [{ field: "avatar", outcome: "pending", mediaAlbum: null }],
    });
    expect(back.error).toContain("头像推送到手机失败");
    // No apply task went out: nothing may have changed, nothing is counted.
    expect(h.phone.kinds()).toEqual(["readback"]);
    const after = await account(h, planned.id);
    expect(takeoverOf(after)).toMatchObject({
      activeChangeOrderId: null,
      observationUntil: null,
      deviceHold: null,
      noNurtureDates: [h.today()],
    });
    expect(after.profileDraft.applyOperation?.status).toBe("completed");
    expect(await lockFree(h, planned.id)).toBe(true);
    expect(
      xhsOpsTakeoverFieldBudgetState(
        "avatar",
        {
          orders: await h.store.listChangeOrders({ accountId: planned.id }),
          notices: [],
        },
        h.clock.now,
      ).used,
    ).toBe(0);
  });

  it("verifies only the picture that changed, observes it, and fails the order after review for the one that did not", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "avatar", after: "清爽职场半身照方向" },
      { field: "cover", after: "城市天际线方向" },
    ]);
    expect(created).toMatchObject({ risk: "L2", batchIndex: 3 });
    await upload(h, created.id, "avatar");
    await upload(h, created.id, "cover");
    const prechecked = await precheck(h, created.id);
    await expect(
      h.orders.confirm(created.id, {
        confirmDigest: must(prechecked.precheck).confirmDigest,
        expectedUpdatedAt: prechecked.updatedAt,
        acks: { photoPermission: true },
      }),
    ).rejects.toMatchObject({ status: 409, message: /截图隐私说明/ });

    h.phone.queue("apply", {
      kind: "message",
      message: applyMessage(
        { avatar: "done", cover: "failed" },
        {
          fieldCodes: { cover: "platform_limit" },
          note: "背景图修改太频繁，请 30 天后再试",
        },
      ),
    });
    const confirmedAt = h.clock.now;
    const waiting = await confirm(h, created.id, ALL_IMAGE_ACKS);
    expect(waiting).toMatchObject({
      status: "awaiting_visual_check",
      fields: [
        { field: "avatar", outcome: "done", mediaAlbum: "Tabby-a1b2c3d1-a" },
        {
          field: "cover",
          outcome: "failed",
          code: "platform_limit",
          mediaAlbum: "Tabby-a1b2c3d1-c",
        },
      ],
      verificationScreenshotUrl: expect.stringMatching(/task-\d+\.png$/),
    });
    // One flat album per picture, one picture each.
    expect(h.phone.pushed.map((entry) => entry.album)).toEqual([
      "Tabby-a1b2c3d1-a",
      "Tabby-a1b2c3d1-c",
    ]);
    expect(h.phone.pushed.map((entry) => entry.images.length)).toEqual([1, 1]);
    const [apply] = h.phone.bodies("apply");
    expect(apply).toMatchObject({ maxSteps: 80, timeout: 1_200_000 });
    expect(apply?.task).toContain("「Tabby-a1b2c3d1-a」逐字一致的相册");
    // Only the changed picture is verified.
    const [verification] = h.phone.bodies("verification");
    expect(verification?.task).toContain('"fields":{"avatar":true|false}');
    expect(takeoverOf(await account(h, planned.id))).toMatchObject({
      activeChangeOrderId: created.id,
      platformLimitNotices: [
        {
          field: "cover",
          text: "背景图修改太频繁，请 30 天后再试",
          blockedUntil: new Date(h.clock.now + 30 * DAY).toISOString(),
        },
      ],
    });
    await expect(visual(h, created.id, "cover", "match")).rejects.toMatchObject(
      { status: 409 },
    );

    const observed = await visual(h, created.id, "avatar", "match");
    expect(observed).toMatchObject({
      status: "observing",
      fields: [
        {
          field: "avatar",
          outcome: "verified",
          visualCheck: { result: "match" },
        },
        { field: "cover", outcome: "failed" },
      ],
    });

    // Self-limit: another avatar within 7 days of the first is blocked.
    const ledger = await h.store.listChangeOrders({ accountId: planned.id });
    const probe: XhsOpsChangeOrder = {
      ...observed,
      id: "probe",
      fields: [must(observed.fields[0])],
    };
    expect(
      changeOrderBudget(
        probe,
        await account(h, planned.id),
        ledger,
        confirmedAt + 6 * DAY,
      )[0]?.blockedUntil,
    ).toBe(new Date(confirmedAt + 7 * DAY).toISOString());

    h.advance(7 * DAY + MINUTE);
    const reviewed = await review(h, created.id);
    expect(reviewed.status).toBe("observing");
    expect(reviewed.observation?.verdict).toBe("inconclusive");
    // The review readback ends on 「我」 for the picture.
    expect(h.phone.bodies("readback").at(-1)?.task).toContain(
      "头像、背景图和头部计数重新展开后直接 COMPLETE",
    );
    await expect(
      h.orders.reviewObservation(created.id, {
        expectedUpdatedAt: reviewed.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409, message: /逐张对照图片/ });

    const settled = await visual(h, created.id, "avatar", "match");
    expect(settled.status).toBe("failed");
    expect(settled.observation?.visualChecks.avatar?.result).toBe("match");
    expect(settled.error).toContain("背景图在修改时没有改成");
    expect(takeoverOf(await account(h, planned.id)).safetyPause).toBe(null);

    // The platform's limit still blocks the cover a week later.
    const cover = await create(h, planned.id, [
      { field: "cover", after: "城市天际线方向" },
    ]);
    const coverUploaded = await upload(h, cover.id, "cover");
    await expect(
      h.orders.precheck(cover.id, {
        expectedUpdatedAt: coverUploaded.updatedAt,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: /背景图在 .* 之前不能再改/,
    });
  });

  it("pauses on a mismatched picture and lets its rollback run through the pause and the window", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "avatar", after: "清爽职场半身照方向" },
    ]);
    await upload(h, created.id, "avatar");
    await precheck(h, created.id);
    await confirm(h, created.id, ALL_IMAGE_ACKS);
    const failed = await visual(h, created.id, "avatar", "mismatch");
    expect(failed).toMatchObject({
      status: "failed",
      fields: [{ outcome: "mismatch", visualCheck: { result: "mismatch" } }],
    });
    const paused = takeoverOf(await account(h, planned.id));
    expect(paused.safetyPause).toMatchObject({
      code: "manual",
      sourceRef: created.id,
    });
    expect(paused.observationUntil).toBe(
      new Date(h.clock.now + 7 * DAY).toISOString(),
    );

    // An ordinary order waits; the rollback of the cause does not.
    const rollback = await create(
      h,
      planned.id,
      [{ field: "avatar" }],
      created.id,
    );
    expect(rollback).toMatchObject({
      status: "draft",
      rollbackOfId: created.id,
      fields: [{ field: "avatar", imagePath: null }],
    });
    expect(rollback.fields[0]?.after).toContain("请重新上传原图");
    await upload(h, rollback.id, "avatar", pngDataUrl("original"));
    const prechecked = await precheck(h, rollback.id);
    expect(prechecked.status).toBe("awaiting_confirm");
    const observed = await confirm(h, rollback.id, ALL_IMAGE_ACKS);
    expect(observed.status).toBe("awaiting_visual_check");
    expect(takeoverOf(await account(h, planned.id)).safetyPause?.code).toBe(
      "manual",
    );
    expect(existsSync(must(observed.fields[0]?.imagePath))).toBe(true);
  });

  it("keeps every album a picture may have reached, across attempts, for the cleanup reminder (B13)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const created = await create(h, planned.id, [
      { field: "avatar", after: "清爽职场半身照方向" },
      { field: "cover", after: "城市天际线方向" },
    ]);
    await upload(h, created.id, "avatar");
    await upload(h, created.id, "cover");

    // 1st attempt: the avatar lands, the phone refuses the cover.
    await precheck(h, created.id);
    h.phone.refusedAlbums.add("Tabby-a1b2c3d1-c");
    const refused = await confirm(h, created.id, ALL_IMAGE_ACKS);
    expect(refused).toMatchObject({
      status: "draft",
      applyTaskId: null,
      fields: [
        { field: "avatar", mediaAlbum: null },
        { field: "cover", mediaAlbum: null },
      ],
      pushedAlbums: ["Tabby-a1b2c3d1-a"],
    });
    expect(refused.error).toContain("背景图推送到手机失败");

    // 2nd attempt: the avatar push call itself fails; its picture may have landed.
    await precheck(h, created.id);
    h.phone.pushThrows = true;
    const lost = await confirm(h, created.id, ALL_IMAGE_ACKS);
    expect(lost).toMatchObject({
      status: "draft",
      pushedAlbums: ["Tabby-a1b2c3d1-a", "Tabby-a1b2c3d2-a"],
    });

    // 3rd attempt goes through: both of its albums join the list.
    h.phone.pushThrows = false;
    await precheck(h, created.id);
    const waiting = await confirm(h, created.id, ALL_IMAGE_ACKS);
    expect(waiting).toMatchObject({
      status: "awaiting_visual_check",
      fields: [
        { field: "avatar", mediaAlbum: "Tabby-a1b2c3d3-a" },
        { field: "cover", mediaAlbum: "Tabby-a1b2c3d3-c" },
      ],
      pushedAlbums: [
        "Tabby-a1b2c3d1-a",
        "Tabby-a1b2c3d2-a",
        "Tabby-a1b2c3d3-a",
        "Tabby-a1b2c3d3-c",
      ],
    });
    expect(h.phone.kinds()).toEqual([
      "readback",
      "readback",
      "readback",
      "apply",
      "verification",
    ]);
  });
});

// ─── Rollback ───────────────────────────────────────────────────────────────

describe("change order: rollback", () => {
  it("rolls a failed nickname back under observation_failed, exempt from the self-limit but counted", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    await pastFirstObservation(h, planned);
    const observed = await observedTextOrder(
      h,
      planned.id,
      [{ field: "nickname", after: "通勤护肤日记" }],
      { l2SecondCheck: true },
    );
    expect(observed.status).toBe("observing");

    // Someone renamed the account during the window: the review fails.
    h.phone.profile.nickname = "被别人改了";
    h.advance(7 * DAY + MINUTE);
    const reviewed = await review(h, observed.id);
    expect(reviewed).toMatchObject({
      status: "failed",
      observation: { verdict: "fail" },
    });
    expect(takeoverOf(await account(h, planned.id)).safetyPause).toMatchObject({
      code: "observation_failed",
      sourceRef: observed.id,
    });

    // Nothing else may start while paused.
    const other = await create(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    await expect(
      h.orders.precheck(other.id, { expectedUpdatedAt: other.updatedAt }),
    ).rejects.toMatchObject({ status: 409, message: /账号暂停中/ });
    await h.orders.cancel(other.id, { expectedUpdatedAt: other.updatedAt });

    const rollback = await create(
      h,
      planned.id,
      [{ field: "nickname" }],
      observed.id,
    );
    expect(rollback).toMatchObject({
      status: "draft",
      risk: "L2",
      rollbackOfId: observed.id,
      fields: [{ field: "nickname", after: "老昵称" }],
    });
    // Created, never run by itself.
    expect(h.phone.bodies("apply")).toHaveLength(1);
    await expect(
      create(
        h,
        planned.id,
        [{ field: "nickname", after: "随便" }],
        observed.id,
      ),
    ).rejects.toMatchObject({ status: 400 });

    const prechecked = await precheck(h, rollback.id);
    expect(prechecked.status).toBe("awaiting_confirm");
    const rolledBack = await confirm(h, rollback.id, { l2SecondCheck: true });
    expect(rolledBack.status).toBe("observing");
    expect(h.phone.profile.nickname).toBe("老昵称");
    // The pause stays until a human resumes.
    expect(takeoverOf(await account(h, planned.id)).safetyPause?.code).toBe(
      "observation_failed",
    );
    // Both renames count: a third within 30 days is blocked.
    const ledger = await h.store.listChangeOrders({ accountId: planned.id });
    const probe: XhsOpsChangeOrder = {
      ...rollback,
      id: "probe",
      rollbackOfId: null,
    };
    expect(
      changeOrderBudget(
        probe,
        await account(h, planned.id),
        ledger,
        h.clock.now,
      )[0],
    ).toMatchObject({ field: "nickname", used: 2, maxChanges: 1 });
    expect(
      changeOrderBudget(
        probe,
        await account(h, planned.id),
        ledger,
        h.clock.now,
      )[0]?.blockedUntil,
    ).not.toBe(null);
  });

  it("closes a still-observing original once its rollback verifies, instead of failing its review on the restored value (B1)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const original = await observedTextOrder(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
    ]);
    expect(original.status).toBe("observing");

    // Inside the window, the operator takes the bio back.
    h.advance(HOUR);
    const rollback = await create(
      h,
      planned.id,
      [{ field: "bio" }],
      original.id,
    );
    expect(rollback.fields[0]?.after).toBe("老简介");
    expect((await precheck(h, rollback.id)).status).toBe("awaiting_confirm");
    const rolledBackAt = h.clock.now;
    expect((await confirm(h, rollback.id)).status).toBe("observing");
    expect(h.phone.profile.bio).toBe("老简介");

    const closed = await order(h, original.id);
    expect(closed).toMatchObject({ status: "failed", error: "已回滚" });
    expect(closed.observation?.notes).toEqual([
      expect.stringContaining("已回滚"),
    ]);
    expect(takeoverOf(await account(h, planned.id))).toMatchObject({
      safetyPause: null,
      activeChangeOrderId: null,
      observationUntil: new Date(rolledBackAt + 72 * HOUR).toISOString(),
    });

    // The original is no longer reviewed; the rollback's own review passes.
    h.advance(72 * HOUR + MINUTE);
    await expect(
      h.orders.reviewObservation(original.id, {
        expectedUpdatedAt: closed.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409, message: /不在观察期/ });
    expect(await review(h, rollback.id)).toMatchObject({
      status: "completed",
      observation: { verdict: "pass" },
    });
    expect(takeoverOf(await account(h, planned.id)).safetyPause).toBe(null);
    expect(h.phone.kinds().slice(6)).toEqual(["readback", "home", "creator"]);
  });

  it("does not hold a field its failed rollback did take back against the original's review (B1)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const original = await observedTextOrder(h, planned.id, [
      { field: "bio", after: "上海通勤女生的敏感肌护理记录" },
      { field: "occupation", after: "摄影师" },
    ]);
    expect(original.status).toBe("observing");
    h.advance(HOUR);
    const rollback = await create(
      h,
      planned.id,
      [{ field: "bio" }, { field: "occupation" }],
      original.id,
    );
    await precheck(h, rollback.id);
    // Only the bio goes back; the occupation stays 摄影师.
    h.phone.queue("apply", {
      kind: "message",
      message: applyMessage({ bio: "done", occupation: "done" }),
      effect: () => {
        h.phone.profile.bio = "老简介";
      },
    });
    expect(await confirm(h, rollback.id)).toMatchObject({
      status: "failed",
      fields: [
        { field: "bio", outcome: "verified" },
        { field: "occupation", outcome: "mismatch" },
      ],
    });
    // The original keeps observing what it still holds.
    expect((await order(h, original.id)).status).toBe("observing");

    h.advance(72 * HOUR);
    expect(await review(h, original.id)).toMatchObject({
      status: "completed",
      observation: { verdict: "pass" },
    });
    expect(takeoverOf(await account(h, planned.id)).safetyPause).toBe(null);
  });

  it("lets a rollback take the nickname back during the takeover's first observation (B9)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const confirmedAt = new Date(h.clock.now).toISOString();
    const until = new Date(h.clock.now + 7 * DAY).toISOString();
    // A nickname order whose observation is the takeover's first one.
    const original = await h.store.createChangeOrder({
      projectId: planned.projectId,
      accountId: planned.id,
      deviceId: DEVICE,
      platformAccountId: XHS_ID,
      diagnosisId: null,
      proposalIds: [],
      batchIndex: 2,
      risk: "L2",
      fields: [
        {
          field: "nickname",
          baselineValue: "老昵称",
          before: "老昵称",
          after: "通勤护肤日记",
          outcome: "verified",
        },
      ],
      status: "observing",
      confirmedAt,
      applyTaskId: "task-earlier",
      observation: {
        until,
        auditId: null,
        baseAuditId: null,
        visualChecks: {},
        verdict: "pending",
        notes: [],
      },
    });
    await h.store.mutateTakeover(planned.id, ({ account: current }) => ({
      account: {
        ...current,
        takeover: { ...takeoverOf(current), observationUntil: until },
      },
      result: null,
    }));
    h.phone.profile.nickname = "通勤护肤日记";
    h.advance(DAY);

    const ledger = await h.store.listChangeOrders({ accountId: planned.id });
    // An ordinary nickname order would still wait for the first observation.
    expect(
      xhsOpsTakeoverFirstObservationIssue(
        { ...original, id: "probe", rollbackOfId: null },
        ledger,
      ),
    ).toMatch(/第一个观察期内不改/);
    const rollback = await create(
      h,
      planned.id,
      [{ field: "nickname" }],
      original.id,
    );
    expect(xhsOpsTakeoverFirstObservationIssue(rollback, ledger)).toBe(null);
    expect((await precheck(h, rollback.id)).status).toBe("awaiting_confirm");
    expect(
      (await confirm(h, rollback.id, { l2SecondCheck: true })).status,
    ).toBe("observing");
    expect(h.phone.profile.nickname).toBe("老昵称");
    expect(await order(h, original.id)).toMatchObject({
      status: "failed",
      error: "已回滚",
    });
  });

  it("does not let a rollback through a 号码 mismatch pause its original raised (B11)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const bio = "上海通勤女生的敏感肌护理记录";
    const created = await create(h, planned.id, [{ field: "bio", after: bio }]);
    await precheck(h, created.id);
    // Between the apply and its verification, the phone switched 小红书号.
    h.phone.queue("apply", {
      kind: "message",
      message: applyMessage({ bio: "done" }),
      effect: () => {
        h.phone.profile.bio = bio;
        h.phone.accountMatched = false;
      },
    });
    expect(await confirm(h, created.id)).toMatchObject({
      status: "failed",
      fields: [{ field: "bio", outcome: "done" }],
    });
    expect(takeoverOf(await account(h, planned.id)).safetyPause).toMatchObject({
      code: "account_mismatch",
      sourceRef: created.id,
    });

    h.phone.accountMatched = true;
    const rollback = await create(
      h,
      planned.id,
      [{ field: "bio" }],
      created.id,
    );
    await expect(
      h.orders.precheck(rollback.id, { expectedUpdatedAt: rollback.updatedAt }),
    ).rejects.toMatchObject({ status: 409, message: /账号暂停中/ });
    expect(h.phone.kinds()).toEqual(["readback", "apply", "verification"]);
  });

  it("does not let a rollback through the policy-mode pause its original raised (B11)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const bio = "上海通勤女生的敏感肌护理记录";
    const created = await create(h, planned.id, [{ field: "bio", after: bio }]);
    await precheck(h, created.id);
    h.phone.queue("apply", { kind: "hang" });
    h.phone.reportOnStart = "off";
    expect((await confirm(h, created.id)).status).toBe("interrupted");
    const pause = must(takeoverOf(await account(h, planned.id)).safetyPause);
    expect(pause).toMatchObject({
      code: "manual",
      reason: takeoverPolicyBreachReason("off"),
      sourceRef: created.id,
    });

    // An enforce build is back; the verification finds the bio changed.
    h.phone.reportOnStart = undefined;
    h.phone.policyMode = "enforce";
    h.phone.profile.bio = bio;
    expect((await verifyAgain(h, created.id)).status).toBe("observing");

    const rollback = await create(
      h,
      planned.id,
      [{ field: "bio" }],
      created.id,
    );
    await expect(
      h.orders.precheck(rollback.id, { expectedUpdatedAt: rollback.updatedAt }),
    ).rejects.toMatchObject({ status: 409, message: /账号暂停中/ });
    expect(h.phone.kinds()).toEqual(["readback", "apply", "verification"]);
  });
});

// ─── Pure rules ─────────────────────────────────────────────────────────────

describe("change order: pure rules", () => {
  it("expects a text field at the after of the newest executed order that verified or settled it, whatever its status (B2)", async () => {
    const h = harness();
    const planned = await plannedAccount(h);
    const baseline = must(
      await h.store.getAudit(must(takeoverOf(planned).baselineAuditId)),
    );
    const expected = (orders: XhsOpsChangeOrder[]) =>
      takeoverExpectedFieldValue("bio", planned, orders, baseline);
    const later = (days: number) => h.clock.now + days * DAY;
    const bio = (
      id: string,
      after: string,
      outcome: XhsOpsChangeOrderField["outcome"],
      extra: {
        at?: number;
        status?: XhsOpsChangeOrder["status"];
        applyTaskId?: string | null;
        platformAccountId?: string;
      } = {},
    ) =>
      ledgerOrder({
        owner: planned,
        id,
        at: extra.at ?? later(1),
        status: extra.status ?? "failed",
        fields: [{ field: "bio", after, outcome, before: "老简介" }],
        applyTaskId: extra.applyTaskId,
        platformAccountId: extra.platformAccountId,
      });
    expect(expected([])).toBe("老简介");

    // Observed, then the review failed: the bio went public all the same.
    const observedThenFailed = bio("o-1", "观察后失败的简介", "verified");
    expect(expected([observedThenFailed])).toBe("观察后失败的简介");
    // An uncertain field a later readback settled to done.
    const settled = bio("o-2", "回读确认的简介", "done", { at: later(2) });
    expect(expected([settled])).toBe("回读确认的简介");
    expect(expected([observedThenFailed, settled])).toBe("回读确认的简介");
    expect(
      expected([
        bio("o-3", "已完成的简介", "verified", { status: "completed" }),
      ]),
    ).toBe("已完成的简介");

    // Not proof of a change on this 小红书号 since the baseline.
    for (const unproven of [
      bio("n-1", "未确认", "uncertain"),
      bio("n-2", "核验不符", "mismatch"),
      bio("n-3", "没派发", "verified", {
        status: "cancelled",
        applyTaskId: null,
      }),
      bio("n-4", "别的号", "verified", {
        status: "completed",
        platformAccountId: "xhs-someone-else",
      }),
      bio("n-5", "基线之前", "verified", {
        at: h.clock.now - 10 * DAY,
        status: "completed",
      }),
    ])
      expect(expected([unproven])).toBe("老简介");
  });

  it("drafts no order for a target the phone already shows with other spacing (B5)", async () => {
    const h = harness();
    h.phone.profile.region = "中国 浙江 杭州";
    const planned = await plannedAccount(h);
    const baseline = must(
      await h.store.getAudit(must(takeoverOf(planned).baselineAuditId)),
    );
    const draft = (
      changes: Array<{
        proposalId: string;
        field: XhsOpsTakeoverProfileField;
        to: string;
      }>,
      orders: XhsOpsChangeOrder[] = [],
    ) =>
      draftTakeoverChangeOrders({
        account: planned,
        deviceId: DEVICE,
        diagnosisId: "diagnosis-1",
        baseline,
        orders,
        changes,
        imageFieldsSupported: true,
      });

    expect(
      draft([{ proposalId: "p-region", field: "region", to: "中国浙江杭州" }]),
    ).toEqual({
      seeds: [],
      skipped: [
        { proposalId: "p-region", field: "region", reason: "手机上已是目标值" },
      ],
    });
    // An earlier order's after compares the same way.
    const earlier = ledgerOrder({
      owner: planned,
      id: "earlier",
      at: h.clock.now,
      status: "completed",
      fields: [
        {
          field: "region",
          after: "中国 北京 北京",
          outcome: "verified",
          before: "中国 浙江 杭州",
        },
      ],
    });
    expect(
      draft(
        [{ proposalId: "p-region", field: "region", to: "中国北京北京" }],
        [earlier],
      ).seeds,
    ).toEqual([]);
    // A real change is still drafted.
    expect(
      draft([{ proposalId: "p-region", field: "region", to: "中国 浙江 宁波" }])
        .seeds,
    ).toMatchObject([
      {
        batchIndex: 2,
        risk: "L2",
        proposalIds: ["p-region"],
        fields: [
          {
            field: "region",
            baselineValue: "中国 浙江 杭州",
            after: "中国 浙江 宁波",
          },
        ],
      },
    ]);
  });

  it("extracts a platform limit only for fields the receipt does not report done, plus any coded platform_limit (B4)", () => {
    const observedAt = new Date(START).toISOString();
    const days = (count: number) => new Date(START + count * DAY).toISOString();
    const order = ledgerOrder({
      id: "o",
      at: START,
      status: "applying",
      fields: [
        { field: "bio", after: "新简介", outcome: "pending" },
        { field: "occupation", after: "摄影师", outcome: "pending" },
      ],
    });
    const notices = (
      fields: Partial<Record<XhsOpsTakeoverProfileField, string>>,
      extra: { fieldCodes?: Record<string, string>; note?: string },
    ) =>
      extractPlatformLimitNotices(
        order,
        parseTakeoverProfileJson(applyMessage(fields, extra), [
          "bio",
          "occupation",
        ]),
        { taskId: "task-9", observedAt },
      );

    // The note names both fields, but the bio went through.
    expect(
      notices(
        { bio: "done", occupation: "failed" },
        { note: "简介已改好；职业修改次数已达上限，请 14 天后再试" },
      ).map((notice) => [notice.field, notice.blockedUntil]),
    ).toEqual([["occupation", days(14)]]);
    // Limit wording about fields that both changed is no limit at all.
    expect(
      notices(
        { bio: "done", occupation: "done" },
        { note: "简介和职业都已提交，稍后生效" },
      ),
    ).toEqual([]);
    // A field coded platform_limit counts whatever the note says.
    expect(
      notices(
        { bio: "failed", occupation: "done" },
        { fieldCodes: { bio: "platform_limit" }, note: "" },
      ),
    ).toEqual([
      {
        field: "bio",
        text: "简介修改受平台次数限制",
        observedAt,
        blockedUntil: days(7),
        sourceTaskId: "task-9",
      },
    ]);
    // Wording that names no field is about the ones that failed.
    expect(
      notices(
        { bio: "done", occupation: "failed" },
        { note: "操作太频繁，请稍后再试" },
      ).map((notice) => notice.field),
    ).toEqual(["occupation"]);
  });

  it("adds each pushed album once, oldest first, and keeps the newest 20 (B13)", () => {
    expect(
      withPushedAlbums({ pushedAlbums: ["Tabby-1-a"] }, [
        "Tabby-1-a",
        null,
        "Tabby-2-a",
      ]),
    ).toEqual(["Tabby-1-a", "Tabby-2-a"]);
    const many = Array.from({ length: 25 }, (_, index) => `Tabby-${index}-a`);
    expect(withPushedAlbums({ pushedAlbums: [] }, many)).toEqual(
      many.slice(-20),
    );
  });
});
