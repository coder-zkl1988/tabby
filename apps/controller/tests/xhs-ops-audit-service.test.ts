import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceExecuteTaskBody,
  type DeviceInfo,
  type TaskResult,
  type XhsOpsAccount,
  type XhsOpsAccountAudit,
  type XhsOpsHeaderCounts,
  compareXhsOpsAudits,
  xhsOpsAccountAuditSchema,
  xhsOpsAccountNurtureIssues,
  xhsOpsInteractionConfigSchema,
  xhsOpsParseCount,
  xhsOpsRedactContact,
} from "@nexu/shared";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceControlRpcError } from "../src/services/device-control-service.js";
import {
  XHS_AUDIT_SAFETY_STOP_COOLDOWN_MS,
  type XhsOpsAuditDeviceControl,
  XhsOpsAuditService,
  auditDerivedFlags,
} from "../src/services/xhs-ops-audit-service.js";
import { XhsOpsProfileService } from "../src/services/xhs-ops-profile-service.js";
import { XHS_AUDIT_TASK_POLICY } from "../src/services/xhs-ops-run-service.js";
import { takeoverPolicyBreachReason } from "../src/services/xhs-ops-takeover-phone.js";
import {
  XHS_AUDIT_CREATOR_MARKER,
  XHS_AUDIT_HOME_MARKER,
  XHS_IDENTITY_MARKER,
  XHS_PROFILE_READBACK_MARKER,
  buildAccountAuditCreatorTask,
  buildAccountAuditHomeTask,
  buildTakeoverIdentityTask,
  buildTakeoverProfileReadbackTask,
} from "../src/services/xhs-ops-task-builder.js";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";

const START = Date.parse("2026-10-21T02:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const XHS_ID = "xhs-owner-001";
const DEVICE = "phone-1";
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
    if (value !== null && value !== undefined) return value;
    await sleep(2);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ─── Phone receipts ─────────────────────────────────────────────────────────

const clicks = (count: number) =>
  `[回执] 各应用生效点击: com.xingin.xhs=${count}`;

function receipt(
  marker: string,
  payload: Record<string, unknown>,
  clickCount: number | null,
): string {
  return [
    "已完成只读读取",
    `${marker}${JSON.stringify(payload)}`,
    ...(clickCount === null ? [] : [clicks(clickCount)]),
  ].join("\n");
}

const PROFILE_VALUES = {
  nickname: "通勤小林",
  bio: "上海通勤 | 合作 vx: lin_2024abc",
  occupation: "设计师",
  gender: "女",
  birthdayFilled: true,
  region: "中国 上海 上海",
};

function profileReceipt(
  overrides: Record<string, unknown> = {},
  clickCount: number | null = 2,
): string {
  return receipt(
    XHS_PROFILE_READBACK_MARKER,
    {
      v: 1,
      status: "read",
      accountMatched: true,
      ...PROFILE_VALUES,
      ...overrides,
    },
    clickCount,
  );
}

const HEADER = {
  followingText: "128",
  followersText: "1.2万",
  likesCollectsText: "8.9万",
};

function homeReceipt(
  overrides: Record<string, unknown> = {},
  clickCount: number | null = 1,
): string {
  return receipt(
    XHS_AUDIT_HOME_MARKER,
    {
      v: 1,
      status: "read",
      code: "ok",
      nickname: "通勤小林",
      ...HEADER,
      headerEnd: HEADER,
      notesEnd: false,
      notes: [
        {
          i: 1,
          title: "通勤穿搭合集 微信abc123456",
          likesText: "356",
          video: false,
          pinned: true,
        },
        {
          i: 2,
          title: "周末探店",
          likesText: "1.1万",
          video: true,
          pinned: false,
        },
      ],
      note: "",
      ...overrides,
    },
    clickCount,
  );
}

function creatorReceipt(
  overrides: Record<string, unknown> = {},
  clickCount: number | null = 4,
): string {
  return receipt(
    XHS_AUDIT_CREATOR_MARKER,
    {
      v: 1,
      status: "read",
      code: "ok",
      nickname: "通勤小林",
      ...HEADER,
      periodLabel: "近7日",
      viewsText: "5230",
      engagementText: "312",
      newFollowersText: "18",
      visitorsText: "96",
      accountStatus: "正常",
      note: "",
      ...overrides,
    },
    clickCount,
  );
}

function identityReceipt(accountId = XHS_ID): string {
  return receipt(
    XHS_IDENTITY_MARKER,
    { v: 1, status: "visible", accountId },
    1,
  );
}

// ─── Fake phone ─────────────────────────────────────────────────────────────

type Segment = "identity" | "profile" | "home" | "creator";

type Step =
  | { kind: "result"; result: Partial<TaskResult> }
  /** Accepted and still running until cancelled (or finished by the test). */
  | { kind: "hang" }
  /** CALL_USER: the call returns, the phone keeps waiting on its task. */
  | { kind: "interaction" }
  /** Refused before the send; the phone never sees it. */
  | { kind: "reject" }
  /** The idle timeout fired; the message names the task, the phone works on. */
  | { kind: "timeout" }
  /** The connection broke without an answer; the phone works on. */
  | { kind: "transport" };

function segmentOf(task: string): Segment {
  if (task.includes(XHS_IDENTITY_MARKER)) return "identity";
  if (task.includes(XHS_PROFILE_READBACK_MARKER)) return "profile";
  if (task.includes(XHS_AUDIT_HOME_MARKER)) return "home";
  if (task.includes(XHS_AUDIT_CREATOR_MARKER)) return "creator";
  throw new Error(`unexpected task: ${task.slice(0, 40)}`);
}

const DEFAULT_MESSAGES: Record<Segment, () => string> = {
  identity: () => identityReceipt(),
  profile: () => profileReceipt(),
  home: () => homeReceipt(),
  creator: () => creatorReceipt(),
};

class FakePhone {
  online = true;
  status: DeviceInfo["status"] = "idle";
  currentTaskId: string | undefined;
  confirmCancel = true;
  /** Off: the status report omits the running task's id, so the desktop never learns it. */
  reportTaskId = true;
  /** devicePolicyMode the status report carries; undefined before the phone's first task. */
  policyMode: DeviceInfo["devicePolicyMode"];
  /** The mode a task reports at TASK_START; tabby-control keeps it on the status. */
  reportOnStart: DeviceInfo["devicePolicyMode"];
  /** Runs once a task ended, before its result is returned. */
  afterTask: (() => void) | null = null;
  /** Ids of the tasks the phone accepted, in order. */
  readonly started: string[] = [];
  readonly dispatched: Array<{
    segment: Segment;
    body: DeviceExecuteTaskBody;
  }> = [];
  readonly cancelled: string[] = [];
  readonly retained: Array<{
    taskId: string;
    deviceId: string;
    result: TaskResult;
    completedAt: number;
  }> = [];
  private readonly queued = new Map<Segment, Step[]>();
  private readonly pending = new Map<string, (result: TaskResult) => void>();
  private seq = 0;

  constructor(private readonly now: () => number) {}

  queue(segment: Segment, ...steps: Step[]): void {
    this.queued.set(segment, [...(this.queued.get(segment) ?? []), ...steps]);
  }

  segments(): Segment[] {
    return this.dispatched.map((entry) => entry.segment);
  }

  /** The controller died: nobody is waiting on the calls in flight any more. */
  forgetPending(): void {
    this.pending.clear();
  }

  /** The phone ends a task on its own; nobody is listening any more. */
  finish(taskId: string, result: Partial<TaskResult>): void {
    if (this.currentTaskId === taskId) {
      this.status = "idle";
      this.currentTaskId = undefined;
    }
    this.afterTask?.();
    this.retained.push({
      taskId,
      deviceId: DEVICE,
      result: { taskId, success: true, status: "completed", ...result },
      completedAt: this.now(),
    });
  }

  readonly control: XhsOpsAuditDeviceControl = {
    getDevice: async (deviceId) =>
      this.online
        ? {
            deviceId,
            status: this.status,
            currentTaskId: this.reportTaskId ? this.currentTaskId : undefined,
            connectedAt: 1,
            lastSeen: this.now(),
            ...(this.policyMode ? { devicePolicyMode: this.policyMode } : {}),
          }
        : null,
    executeTask: async (_deviceId, body) => {
      const segment = segmentOf(body.task);
      this.dispatched.push({ segment, body });
      const step = this.queued.get(segment)?.shift() ?? {
        kind: "result",
        result: { message: DEFAULT_MESSAGES[segment]() },
      };
      if (step.kind === "reject")
        throw new DeviceControlRpcError(
          "OPERATION_FAILED",
          `TASK_ALREADY_RUNNING: device ${DEVICE} is busy`,
        );
      const taskId = `task-${++this.seq}`;
      this.started.push(taskId);
      this.status = "busy";
      this.currentTaskId = taskId;
      if (this.reportOnStart) this.policyMode = this.reportOnStart;
      switch (step.kind) {
        case "result": {
          // Long enough for the task-id probe to see the task running.
          await sleep(5);
          const result: TaskResult = {
            taskId,
            success: true,
            status: "completed",
            finalScreenshot: `/tmp/shots/${taskId}.png`,
            ...step.result,
          };
          this.finish(taskId, result);
          return { result };
        }
        case "interaction":
          await sleep(5);
          return {
            result: {
              taskId,
              success: false,
              needsInteraction: true,
              message: "需要人工处理",
            },
          };
        case "hang":
          return new Promise((resolve) => {
            this.pending.set(taskId, (result) => resolve({ result }));
          });
        case "timeout":
          throw new DeviceControlRpcError(
            "OPERATION_FAILED",
            `TIMEOUT: task ${taskId} made no progress for 180000ms`,
          );
        case "transport":
          throw new Error("socket hang up");
      }
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
  };
}

// ─── Harness ────────────────────────────────────────────────────────────────

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "xhs-audit-service-"));
  directories.push(directory);
  const file = join(directory, "state.json");
  const clock = { now: START };
  let id = 0;
  const deps = {
    now: () => new Date(clock.now).toISOString(),
    genId: () => `id-${++id}`,
  };
  const phone = new FakePhone(() => clock.now);
  const serviceFor = (store: XhsOpsStore) =>
    new XhsOpsAuditService({
      store,
      deviceControl: phone.control,
      options: {
        idlePollIntervalMs: 1,
        idleWaitTimeoutMs: 0,
        taskIdPollIntervalMs: 1,
        cancelWaitMs: 2_000,
        now: () => clock.now,
      },
    });
  const store = new XhsOpsStore(file, deps);
  return {
    store,
    phone,
    service: serviceFor(store),
    serviceFor,
    advance: (ms: number) => {
      clock.now += ms;
    },
    /** A second store on the same file: what a controller restart sees. */
    reopen: () => new XhsOpsStore(file, deps),
    /** reopen() whose next updateAudit write fails, as a full disk would. */
    reopenFlaky: () => new FlakyAuditStore(file, deps),
  };
}

class FlakyAuditStore extends XhsOpsStore {
  failNextAuditWrite = true;

  override async updateAudit(
    ...args: Parameters<XhsOpsStore["updateAudit"]>
  ): ReturnType<XhsOpsStore["updateAudit"]> {
    if (this.failNextAuditWrite) {
      this.failNextAuditWrite = false;
      throw new Error("ENOSPC: no space left on device");
    }
    return super.updateAudit(...args);
  }
}
type Harness = ReturnType<typeof harness>;

async function authorizedAccount(h: Harness): Promise<XhsOpsAccount> {
  const created = await h.store.createProject({
    name: "接管项目",
    business: { industry: "美妆", product: "护肤品" },
    audience: {
      ageRange: "25–32",
      genderRatio: "女80%男20%",
      regions: ["上海"],
    },
  });
  await h.store.confirmProfile(created.id, {
    profile: {
      summary: "上海职场女性",
      base: { ageRange: "25–32", genderRatio: "女80%男20%", regions: ["上海"] },
      verticalInterests: ["护肤"],
      generalInterests: ["咖啡", "通勤"],
    },
    expectedUpdatedAt: created.updatedAt,
  });
  const account = await h.store.createAccount({
    projectId: created.id,
    entryMode: "existing",
    label: "接管·测试机",
    deviceId: DEVICE,
    deviceName: "测试机",
  });
  return h.store.authorizeTakeover(account.id, {
    expectedUpdatedAt: account.updatedAt,
    ownershipConfirmed: true,
  });
}

async function lockedAccount(h: Harness): Promise<XhsOpsAccount> {
  const account = await authorizedAccount(h);
  h.advance(MINUTE);
  const read = await h.service.readTakeoverIdentity(account.id);
  h.advance(MINUTE);
  const { account: locked } = await h.service.confirmTakeoverIdentity(
    account.id,
    { identityTaskId: read.identity.taskId, platformAccountId: XHS_ID },
  );
  return locked;
}

async function finishedAudit(
  h: Harness,
  account: XhsOpsAccount,
): Promise<XhsOpsAccountAudit> {
  const started = await h.service.startAudit(account.id);
  await h.service.waitForAudit(started.id);
  return must(await h.store.getAudit(started.id));
}

async function baselinedAccount(h: Harness) {
  const account = await lockedAccount(h);
  const audit = await finishedAudit(h, account);
  const baseline = await h.service.confirmBaseline(audit.id);
  return { account: baseline.account, audit: baseline.audit };
}

async function lockFree(h: Harness, accountId: string): Promise<boolean> {
  try {
    const release = await h.store.acquireExclusiveDeviceBinding(
      accountId,
      DEVICE,
    );
    release();
    return true;
  } catch {
    return false;
  }
}

function auditSegments(audit: XhsOpsAccountAudit) {
  return {
    profile: audit.profile?.status,
    home: audit.home?.status,
    creator: audit.creator?.status,
  };
}

// ─── T2 identity ────────────────────────────────────────────────────────────

describe("takeover identity read and lock", () => {
  it("reads with the read-only variant and keeps the read server-side until the lock", async () => {
    const h = harness();
    const account = await authorizedAccount(h);
    h.advance(MINUTE);

    const read = await h.service.readTakeoverIdentity(account.id);
    expect(read.identity).toMatchObject({
      status: "visible",
      accountId: XHS_ID,
      screenshotUrl: `/api/v1/media/screenshots/${read.identity.taskId}.png`,
    });
    const [dispatch] = h.phone.dispatched;
    expect(dispatch?.body).toMatchObject({
      task: buildTakeoverIdentityTask(),
      maxSteps: 20,
      timeout: 120_000,
      taskPolicy: XHS_AUDIT_TASK_POLICY,
    });
    expect(read.account.takeover?.pendingIdentity).toEqual({
      taskId: read.identity.taskId,
      deviceId: DEVICE,
      readAt: new Date(START + MINUTE).toISOString(),
      screenshotUrl: read.identity.screenshotUrl,
      readAccountId: XHS_ID,
    });
    expect(await lockFree(h, account.id)).toBe(true);

    h.advance(MINUTE);
    await expect(
      h.service.confirmTakeoverIdentity(account.id, {
        identityTaskId: "another-task",
        platformAccountId: XHS_ID,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      h.service.confirmTakeoverIdentity(account.id, {
        identityTaskId: read.identity.taskId,
        platformAccountId: "xhs-someone-else",
      }),
    ).rejects.toMatchObject({ status: 409 });

    const locked = await h.service.confirmTakeoverIdentity(account.id, {
      identityTaskId: read.identity.taskId,
      platformAccountId: XHS_ID,
    });
    expect(locked.account.platformAccountId).toBe(XHS_ID);
    expect(locked.account.takeover).toMatchObject({
      identitySource: "takeover",
      identityTaskId: read.identity.taskId,
      identityScreenshotUrl: read.identity.screenshotUrl,
      pendingIdentity: null,
    });
    expect(locked.event.name).toBe("xhs_ops_takeover_identity_locked");
    expect(locked.event.payload).toMatchObject({
      accountId: account.id,
      identitySource: "takeover",
    });
    expect(JSON.stringify(locked.event)).not.toContain(XHS_ID);
  });

  it("refuses before authorization or on a busy phone, and holds the device when a stop is unconfirmed", async () => {
    const h = harness();
    const project = await h.store.createProject({
      name: "未授权",
      business: { industry: "美妆", product: "护肤品" },
      audience: { ageRange: "25–32", genderRatio: "女", regions: ["上海"] },
    });
    const unauthorized = await h.store.createAccount({
      projectId: project.id,
      entryMode: "existing",
      label: "接管·备用机",
      deviceId: "phone-2",
    });
    await expect(
      h.service.readTakeoverIdentity(unauthorized.id),
    ).rejects.toMatchObject({ status: 409 });

    const account = await authorizedAccount(h);
    h.phone.status = "busy";
    h.phone.currentTaskId = "someone-elses-task";
    const busy = await h.service.readTakeoverIdentity(account.id);
    expect(busy.identity.status).toBe("unavailable");
    expect(h.phone.dispatched).toHaveLength(0);
    expect(busy.account.takeover?.pendingIdentity).toBeNull();

    h.phone.status = "idle";
    h.phone.currentTaskId = undefined;
    h.phone.confirmCancel = false;
    h.phone.queue("identity", { kind: "interaction" });
    const stuck = await h.service.readTakeoverIdentity(account.id);
    expect(stuck.identity.status).toBe("unavailable");
    expect(h.phone.cancelled).toEqual([stuck.identity.taskId]);
    expect(stuck.account.takeover?.deviceHold).toMatchObject({
      taskId: stuck.identity.taskId,
      sourceRef: "takeover-identity",
    });
    expect(stuck.account.takeover?.pendingIdentity).toBeNull();
    expect(await lockFree(h, account.id)).toBe(false);
  });

  it("keeps no read the phone reported unavailable, and stops a timed-out read by its id", async () => {
    const h = harness();
    const account = await authorizedAccount(h);
    h.advance(MINUTE);
    // 「我」页显示手机号输入页: the phone completes with an unavailable receipt.
    h.phone.queue("identity", {
      kind: "result",
      result: {
        message: receipt(
          XHS_IDENTITY_MARKER,
          { v: 1, status: "unavailable", accountId: "" },
          1,
        ),
      },
    });
    const loggedOut = await h.service.readTakeoverIdentity(account.id);
    expect(loggedOut.identity).toMatchObject({
      status: "unavailable",
      screenshotUrl: null,
      accountId: "",
    });
    expect(loggedOut.identity.reason).toContain("桌面不会代为登录");
    expect(loggedOut.account.takeover?.pendingIdentity).toBeNull();
    await expect(
      h.service.confirmTakeoverIdentity(account.id, {
        identityTaskId: loggedOut.identity.taskId,
        platformAccountId: XHS_ID,
        overrideRead: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await lockFree(h, account.id)).toBe(true);

    h.phone.queue("identity", { kind: "timeout" });
    const timedOut = await h.service.readTakeoverIdentity(account.id);
    expect(timedOut.identity.status).toBe("unavailable");
    expect(timedOut.identity.reason).toContain("读取超时");
    expect(h.phone.cancelled).toEqual([timedOut.identity.taskId]);
    expect(timedOut.account.takeover).toMatchObject({
      pendingIdentity: null,
      deviceHold: null,
    });
    expect(await lockFree(h, account.id)).toBe(true);
  });

  it("routes an existing account's profile-service identity read through the takeover variant", async () => {
    const h = harness();
    const account = await authorizedAccount(h);
    h.advance(MINUTE);
    const media = {
      generateImage: async () => ({ path: "", items: [] }),
      generateText: async () => ({ text: "" }),
    };
    const deviceControl = {
      ...h.phone.control,
      pushMedia: async () => ({ results: [] }),
    };
    const unwired = new XhsOpsProfileService({
      store: h.store,
      media,
      deviceControl,
      mediaRoot: tmpdir(),
    });
    await expect(unwired.readIdentity(account.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(h.phone.dispatched).toHaveLength(0);

    const wired = new XhsOpsProfileService({
      store: h.store,
      media,
      deviceControl,
      mediaRoot: tmpdir(),
      takeoverIdentity: h.service,
    });
    const identity = await wired.readIdentity(account.id);
    expect(identity).toMatchObject({ status: "visible", accountId: XHS_ID });
    expect(h.phone.dispatched[0]?.body.taskPolicy).toEqual(
      XHS_AUDIT_TASK_POLICY,
    );
    expect(
      (await h.store.getAccount(account.id))?.takeover?.pendingIdentity?.taskId,
    ).toBe(identity.taskId);
  });
});

// ─── T3 audit chain ─────────────────────────────────────────────────────────

describe("read-only audit chain", () => {
  it("runs P0 → A → B under the audit policy and confirms the baseline with a public-only event", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    h.phone.dispatched.length = 0;

    const started = await h.service.startAudit(account.id, { noteLimit: 12 });
    expect(started).toMatchObject({
      status: "running",
      trigger: "takeover",
      platformAccountId: XHS_ID,
      deviceId: DEVICE,
    });
    await h.service.waitForAudit(started.id);
    const audit = must(await h.store.getAudit(started.id));

    expect(h.phone.segments()).toEqual(["profile", "home", "creator"]);
    expect(h.phone.dispatched.map((entry) => entry.body)).toEqual([
      expect.objectContaining({
        task: buildTakeoverProfileReadbackTask(XHS_ID),
        maxSteps: 40,
        timeout: 180_000,
        taskPolicy: XHS_AUDIT_TASK_POLICY,
      }),
      expect.objectContaining({
        task: buildAccountAuditHomeTask(12),
        maxSteps: 35,
        timeout: 240_000,
        taskPolicy: XHS_AUDIT_TASK_POLICY,
      }),
      expect.objectContaining({
        task: buildAccountAuditCreatorTask(),
        maxSteps: 25,
        timeout: 180_000,
        taskPolicy: XHS_AUDIT_TASK_POLICY,
      }),
    ]);
    expect(audit).toMatchObject({
      status: "completed",
      reason: "",
      activeTaskId: null,
      flags: [],
      completedAt: new Date(START + 2 * MINUTE).toISOString(),
    });
    expect(auditSegments(audit)).toEqual({
      profile: "read",
      home: "read",
      creator: "read",
    });
    expect(audit.profile).toMatchObject({
      accountMatched: true,
      values: PROFILE_VALUES,
      evidence: { receiptClicks: 2, trusted: true, warnings: [] },
    });
    expect(audit.home?.header?.followers).toEqual(xhsOpsParseCount("1.2万"));
    expect(audit.home?.notes).toHaveLength(2);
    expect(audit.creator).toMatchObject({
      views: xhsOpsParseCount("5230"),
      interactions: xhsOpsParseCount("312"),
      profileVisitors: xhsOpsParseCount("96"),
      accountStatus: "正常",
    });
    expect(xhsOpsAccountAuditSchema.parse(audit)).toEqual(audit);
    expect((await h.store.getAccount(account.id))?.takeover).toMatchObject({
      latestAuditId: audit.id,
      baselineAuditId: null,
    });
    expect(await lockFree(h, account.id)).toBe(true);

    const baseline = await h.service.confirmBaseline(audit.id);
    expect(baseline.account.takeover?.baselineAuditId).toBe(audit.id);
    expect(baseline.audit.manualCheckAt).toBeNull();
    expect(baseline.event.name).toBe("xhs_ops_account_audited");
    expect(baseline.event.payload).toMatchObject({
      auditId: audit.id,
      baseline: true,
      profile: {
        nickname: "通勤小林",
        bio: "上海通勤 | 合作 [联系方式]",
        occupation: "设计师",
      },
      header: {
        following: xhsOpsParseCount("128"),
        followers: xhsOpsParseCount("1.2万"),
        likesCollects: xhsOpsParseCount("8.9万"),
      },
      notes: [
        expect.objectContaining({ i: 1, title: "通勤穿搭合集 [联系方式]" }),
        expect.objectContaining({ i: 2, title: "周末探店", likes: "1.1万" }),
      ],
      creator: expect.objectContaining({ views: "5230" }),
    });
    expect(Object.keys(baseline.event.payload.profile ?? {})).toEqual([
      "nickname",
      "bio",
      "occupation",
    ]);
    const serialized = JSON.stringify(baseline.event);
    for (const secret of [
      XHS_ID,
      "lin_2024abc",
      "abc123456",
      "birthday",
      "中国 上海 上海",
      DEVICE,
    ])
      expect(serialized).not.toContain(secret);
  });

  it("stops the task on needsInteraction and dispatches no further segment", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    h.phone.dispatched.length = 0;
    h.phone.queue("home", { kind: "interaction" });

    const audit = await finishedAudit(h, account);
    expect(h.phone.segments()).toEqual(["profile", "home"]);
    expect(h.phone.cancelled).toEqual([audit.home?.evidence?.taskId]);
    expect(audit.status).toBe("failed");
    expect(auditSegments(audit)).toEqual({
      profile: "read",
      home: "failed",
      creator: "skipped",
    });
    expect(audit.home?.code).toBe("needs_interaction");
    expect(audit.flags).not.toContain("cancellationUnconfirmed");
    const after = must(await h.store.getAccount(account.id));
    expect(after.takeover?.deviceHold).toBeNull();
    expect(after.takeover?.latestAuditId).toBeNull();
    expect(await lockFree(h, account.id)).toBe(true);
  });

  it("holds the device and keeps the lock when the stop is never confirmed", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    h.phone.confirmCancel = false;
    h.phone.queue("home", { kind: "interaction" });

    const audit = await finishedAudit(h, account);
    const taskId = must(audit.home?.evidence?.taskId);
    expect(audit.status).toBe("failed");
    expect(audit.flags).toContain("cancellationUnconfirmed");
    expect(audit.reason).toContain("停止未确认");
    const held = must(await h.store.getAccount(account.id));
    expect(held.takeover?.deviceHold).toMatchObject({
      taskId,
      sourceRef: audit.id,
    });
    expect(await lockFree(h, account.id)).toBe(false);
    const project = await h.store.getProject(account.projectId);
    expect(xhsOpsAccountNurtureIssues(held, project)).toContain(
      "手机上的任务停止未确认，请到手机上确认后在接管卡片解除",
    );

    await h.store.releaseTakeoverDeviceHold(account.id, {
      expectedUpdatedAt: held.updatedAt,
      stoppedOnPhone: true,
    });
    expect(await lockFree(h, account.id)).toBe(true);
  });

  it("stops a timed-out task by the id the error names, and holds the device when no id is known", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    h.phone.queue("profile", { kind: "timeout" });
    const timedOut = await finishedAudit(h, account);
    expect(timedOut.status).toBe("failed");
    expect(timedOut.profile).toMatchObject({
      status: "failed",
      code: "timeout",
    });
    expect(h.phone.cancelled).toEqual([timedOut.profile?.evidence?.taskId]);
    expect(
      (await h.store.getAccount(account.id))?.takeover?.deviceHold,
    ).toBeNull();

    h.phone.queue("profile", { kind: "transport" });
    const lost = await finishedAudit(h, account);
    expect(lost.profile).toMatchObject({
      status: "failed",
      code: "device_unavailable",
    });
    expect(lost.flags).toContain("cancellationUnconfirmed");
    expect(
      (await h.store.getAccount(account.id))?.takeover?.deviceHold,
    ).toMatchObject({ sourceRef: lost.id });
    expect(await lockFree(h, account.id)).toBe(false);
  });

  it("fails a segment the dispatch never reached without holding the device", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    h.phone.queue("home", { kind: "reject" });
    const audit = await finishedAudit(h, account);
    expect(audit.home).toMatchObject({
      status: "failed",
      code: "dispatch_rejected",
    });
    expect(audit.creator?.status).toBe("skipped");
    expect(h.phone.cancelled).toEqual([]);
    expect(await lockFree(h, account.id)).toBe(true);
  });

  it("marks the audit interrupted on a restart and reconciles it by activeTaskId", async () => {
    // Finished on the phone while the desktop was down: the receipt is read back.
    {
      const h = harness();
      const account = await lockedAccount(h);
      h.phone.queue("profile", { kind: "hang" });
      const started = await h.service.startAudit(account.id);
      const taskId = await until(
        async () => (await h.store.getAudit(started.id))?.activeTaskId,
        "activeTaskId",
      );
      h.phone.forgetPending();
      h.phone.finish(taskId, { message: profileReceipt() });

      const restarted = h.reopen();
      const recovery = await restarted.recoverInterruptedTakeoverWork();
      expect(recovery.audits).toEqual([
        expect.objectContaining({
          id: started.id,
          status: "interrupted",
          activeTaskId: taskId,
          profile: expect.objectContaining({ status: "interrupted" }),
        }),
      ]);
      const outcomes = await h
        .serviceFor(restarted)
        .reconcileInterruptedAudits(recovery.audits);
      expect(outcomes).toEqual([
        { auditId: started.id, outcome: "recovered", taskId },
      ]);
      const recovered = must(await restarted.getAudit(started.id));
      expect(recovered).toMatchObject({
        status: "interrupted",
        activeTaskId: null,
        profile: { status: "read", values: PROFILE_VALUES },
      });
      expect(h.phone.segments().filter((s) => s !== "identity")).toEqual([
        "profile",
      ]);
      expect(h.phone.cancelled).toEqual([]);
    }
    // Still running and the stop is not confirmed: the device is held.
    {
      const h = harness();
      const account = await lockedAccount(h);
      h.phone.queue("profile", { kind: "hang" });
      const started = await h.service.startAudit(account.id);
      const taskId = await until(
        async () => (await h.store.getAudit(started.id))?.activeTaskId,
        "activeTaskId",
      );
      h.phone.forgetPending();
      h.phone.confirmCancel = false;
      const restarted = h.reopen();
      const recovery = await restarted.recoverInterruptedTakeoverWork();
      const outcomes = await h
        .serviceFor(restarted)
        .reconcileInterruptedAudits(recovery.audits);
      expect(outcomes).toEqual([
        { auditId: started.id, outcome: "held", taskId },
      ]);
      expect(h.phone.cancelled).toEqual([taskId]);
      expect(
        (await restarted.getAccount(account.id))?.takeover?.deviceHold,
      ).toMatchObject({ taskId, sourceRef: started.id });
      expect((await restarted.getAudit(started.id))?.flags).toContain(
        "cancellationUnconfirmed",
      );
    }
    // Still running and the stop is confirmed.
    {
      const h = harness();
      const account = await lockedAccount(h);
      h.phone.queue("profile", { kind: "hang" });
      const started = await h.service.startAudit(account.id);
      const taskId = await until(
        async () => (await h.store.getAudit(started.id))?.activeTaskId,
        "activeTaskId",
      );
      h.phone.forgetPending();
      const restarted = h.reopen();
      const recovery = await restarted.recoverInterruptedTakeoverWork();
      const outcomes = await h
        .serviceFor(restarted)
        .reconcileInterruptedAudits(recovery.audits);
      expect(outcomes).toEqual([
        { auditId: started.id, outcome: "stopped", taskId },
      ]);
      expect(
        (await restarted.getAccount(account.id))?.takeover?.deviceHold,
      ).toBeNull();
      expect((await restarted.getAudit(started.id))?.activeTaskId).toBeNull();
    }
  });

  it("reconciles without a known task id by marker, and holds the device when the phone state stays unknown", async () => {
    // The phone never named its task: the receipt is found by its marker.
    {
      const h = harness();
      const account = await lockedAccount(h);
      h.phone.reportTaskId = false;
      h.phone.queue("home", { kind: "hang" });
      const started = await h.service.startAudit(account.id);
      const taskId = await until(
        async () =>
          h.phone.segments().includes("home")
            ? h.phone.started[h.phone.started.length - 1]
            : null,
        "home dispatch",
      );
      expect((await h.store.getAudit(started.id))?.activeTaskId).toBeNull();
      h.phone.forgetPending();
      h.phone.finish(taskId, { message: homeReceipt() });

      const restarted = h.reopen();
      const recovery = await restarted.recoverInterruptedTakeoverWork();
      const outcomes = await h
        .serviceFor(restarted)
        .reconcileInterruptedAudits(recovery.audits);
      expect(outcomes).toEqual([
        { auditId: started.id, outcome: "recovered", taskId },
      ]);
      expect(must(await restarted.getAudit(started.id))).toMatchObject({
        status: "interrupted",
        profile: { status: "read" },
        home: { status: "read", evidence: { taskId } },
        creator: null,
      });
    }
    // Offline after the restart: nothing proves the task ended.
    {
      const h = harness();
      const account = await lockedAccount(h);
      h.phone.queue("profile", { kind: "hang" });
      const started = await h.service.startAudit(account.id);
      const taskId = await until(
        async () => (await h.store.getAudit(started.id))?.activeTaskId,
        "activeTaskId",
      );
      h.phone.forgetPending();
      h.phone.online = false;
      const restarted = h.reopen();
      const recovery = await restarted.recoverInterruptedTakeoverWork();
      const outcomes = await h
        .serviceFor(restarted)
        .reconcileInterruptedAudits(recovery.audits);
      expect(outcomes).toEqual([
        { auditId: started.id, outcome: "held", taskId },
      ]);
      expect(h.phone.cancelled).toEqual([]);
      expect(
        (await restarted.getAccount(account.id))?.takeover?.deviceHold,
      ).toMatchObject({ taskId, sourceRef: started.id });
    }
    // The reconcile itself fails midway: the device is held all the same.
    {
      const h = harness();
      const account = await lockedAccount(h);
      h.phone.queue("profile", { kind: "hang" });
      const started = await h.service.startAudit(account.id);
      const taskId = await until(
        async () => (await h.store.getAudit(started.id))?.activeTaskId,
        "activeTaskId",
      );
      h.phone.forgetPending();
      const restarted = h.reopenFlaky();
      const recovery = await restarted.recoverInterruptedTakeoverWork();
      const outcomes = await h
        .serviceFor(restarted)
        .reconcileInterruptedAudits(recovery.audits);
      expect(outcomes).toEqual([
        { auditId: started.id, outcome: "held", taskId },
      ]);
      expect(
        (await restarted.getAccount(account.id))?.takeover?.deviceHold,
      ).toMatchObject({ taskId, sourceRef: started.id });
      expect((await restarted.getAudit(started.id))?.flags).toContain(
        "cancellationUnconfirmed",
      );
    }
  });

  it("cancels: stops the task on the phone and gives the lock back only after the stop is confirmed", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    h.phone.queue("home", { kind: "hang" });
    const started = await h.service.startAudit(account.id);
    const taskId = await until(async () => {
      const audit = await h.store.getAudit(started.id);
      return audit?.home?.status === "running" ? audit.activeTaskId : null;
    }, "home task id");
    expect(await lockFree(h, account.id)).toBe(false);

    const cancelled = await h.service.cancelAudit(started.id);
    expect(h.phone.cancelled).toEqual([taskId]);
    expect(cancelled.status).toBe("cancelled");
    expect(auditSegments(cancelled)).toEqual({
      profile: "read",
      home: "cancelled",
      creator: "skipped",
    });
    expect(h.phone.segments().filter((s) => s !== "identity")).toEqual([
      "profile",
      "home",
    ]);
    expect(await lockFree(h, account.id)).toBe(true);
    await expect(h.service.cancelAudit(started.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("keeps takeover.activeAuditId on the running audit and clears it however the audit ends (§2.1)", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    const project = await h.store.getProject(account.projectId);
    const pointer = async () =>
      (await h.store.getAccount(account.id))?.takeover?.activeAuditId;

    // Running: the nurture gate sees it on the row, without listing audits.
    h.phone.queue("profile", { kind: "hang" });
    const cancelled = await h.service.startAudit(account.id);
    expect(await pointer()).toBe(cancelled.id);
    expect(
      xhsOpsAccountNurtureIssues(
        must(await h.store.getAccount(account.id)),
        project,
      ),
    ).toContain("只读盘点进行中");
    await until(
      async () => (await h.store.getAudit(cancelled.id))?.activeTaskId,
      "activeTaskId",
    );
    expect((await h.service.cancelAudit(cancelled.id)).status).toBe(
      "cancelled",
    );
    expect(await pointer()).toBeNull();

    expect((await finishedAudit(h, account)).status).toBe("completed");
    expect(await pointer()).toBeNull();

    h.phone.queue("home", { kind: "interaction" });
    expect((await finishedAudit(h, account)).status).toBe("failed");
    expect(await pointer()).toBeNull();

    // A restart interrupts it; the startup sweep lets go of it.
    h.phone.queue("profile", { kind: "hang" });
    const interrupted = await h.service.startAudit(account.id);
    await until(
      async () => (await h.store.getAudit(interrupted.id))?.activeTaskId,
      "activeTaskId",
    );
    expect(await pointer()).toBe(interrupted.id);
    h.phone.forgetPending();
    const restarted = h.reopen();
    await restarted.recoverInterruptedTakeoverWork();
    expect((await restarted.getAudit(interrupted.id))?.status).toBe(
      "interrupted",
    );
    expect(
      (await restarted.getAccount(account.id))?.takeover?.activeAuditId,
    ).toBeNull();
  });

  it("closes a cancelled audit with a device hold when the phone never confirms the stop", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    h.phone.queue("home", { kind: "hang" });
    const started = await h.service.startAudit(account.id);
    const taskId = await until(async () => {
      const audit = await h.store.getAudit(started.id);
      return audit?.home?.status === "running" ? audit.activeTaskId : null;
    }, "home task id");
    h.phone.confirmCancel = false;

    const cancelled = await h.service.cancelAudit(started.id);
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(cancelled.home?.status).toBe("cancelled");
    expect(cancelled.flags).toContain("cancellationUnconfirmed");
    expect(
      (await h.store.getAccount(account.id))?.takeover?.deviceHold,
    ).toMatchObject({ taskId, sourceRef: started.id });
    expect(await lockFree(h, account.id)).toBe(false);
  });

  it("discards everything and pauses the takeover when the 小红书号 does not match", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    h.phone.dispatched.length = 0;
    h.phone.queue("profile", {
      kind: "result",
      result: {
        message: profileReceipt({ accountMatched: false, bio: "别人的简介" }),
      },
    });
    const audit = await finishedAudit(h, account);
    expect(h.phone.segments()).toEqual(["profile"]);
    expect(audit.status).toBe("failed");
    expect(audit.profile).toMatchObject({
      status: "failed",
      code: "account_mismatch",
      accountMatched: false,
      values: null,
      evidence: { screenshotUrl: null },
    });
    expect(auditSegments(audit)).toMatchObject({
      home: "skipped",
      creator: "skipped",
    });
    expect(JSON.stringify(audit)).not.toContain("别人的简介");
    const after = must(await h.store.getAccount(account.id));
    expect(after.takeover?.safetyPause).toMatchObject({
      code: "account_mismatch",
      sourceRef: audit.id,
    });
    expect(after.takeover?.latestAuditId).toBeNull();
    await expect(h.service.confirmBaseline(audit.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("ends the session on rate_limited, pauses the takeover and refuses audits for 24 hours", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    h.phone.dispatched.length = 0;
    h.phone.queue("home", {
      kind: "result",
      result: {
        message: homeReceipt({ status: "unavailable", code: "rate_limited" }),
      },
    });
    const audit = await finishedAudit(h, account);
    expect(h.phone.segments()).toEqual(["profile", "home"]);
    expect(audit.status).toBe("failed");
    expect(audit.home).toMatchObject({
      status: "unavailable",
      code: "rate_limited",
    });
    expect(
      (await h.store.getAccount(account.id))?.takeover?.safetyPause,
    ).toMatchObject({ code: "rate_limited", sourceRef: audit.id });

    h.advance(HOUR);
    await expect(h.service.startAudit(account.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("24 小时内出现过风控安全停止"),
    });
    h.advance(XHS_AUDIT_SAFETY_STOP_COOLDOWN_MS);
    const again = await finishedAudit(h, account);
    expect(again.status).toBe("completed");
  });

  it("maps a signed-out 「我」 page to a login_required pause and keeps what was read before it", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    h.phone.queue("creator", {
      kind: "result",
      result: {
        message: creatorReceipt({
          status: "unavailable",
          code: "not_logged_in",
        }),
      },
    });
    const audit = await finishedAudit(h, account);
    expect(audit.status).toBe("failed");
    expect(auditSegments(audit)).toEqual({
      profile: "read",
      home: "read",
      creator: "unavailable",
    });
    expect(audit.creator?.code).toBe("not_logged_in");
    expect(audit.reason).toContain("桌面不会代为登录");
    const after = must(await h.store.getAccount(account.id));
    expect(after.takeover?.safetyPause).toMatchObject({
      code: "login_required",
      sourceRef: audit.id,
      resumableAfter: null,
    });
    expect(after.takeover?.latestAuditId).toBeNull();
    // Not a risk-control stop: the next audit is not held back 24 hours.
    await expect(finishedAudit(h, account)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("retries a POLICY_ACTION_NOT_ALLOWED segment once, then gives up", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    const blocked = {
      kind: "result" as const,
      result: {
        success: false,
        status: "failed",
        errorCode: "POLICY_ACTION_NOT_ALLOWED",
        message: "动作 SLIDE 不在本任务允许范围内",
      },
    };
    h.phone.dispatched.length = 0;
    h.phone.queue("home", blocked);
    const retried = await finishedAudit(h, account);
    expect(h.phone.segments()).toEqual(["profile", "home", "home", "creator"]);
    expect(retried.status).toBe("completed");
    expect(retried.home?.evidence?.warnings[0]).toContain("已重试一次");

    h.phone.dispatched.length = 0;
    h.phone.queue("home", blocked, blocked);
    const failed = await finishedAudit(h, account);
    expect(h.phone.segments()).toEqual(["profile", "home", "home"]);
    expect(failed.status).toBe("failed");
    expect(failed.home).toMatchObject({
      status: "failed",
      code: "policy_blocked",
    });
    expect(failed.creator?.status).toBe("skipped");
  });

  it("flags header counts by grade and requires a manual check before the baseline", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    h.phone.queue("home", {
      kind: "result",
      result: {
        message: homeReceipt({
          followingText: "128",
          followersText: "500",
          likesCollectsText: "890",
          headerEnd: {
            followingText: "129",
            followersText: "530",
            likesCollectsText: "890",
          },
        }),
      },
    });
    h.phone.queue("creator", {
      kind: "result",
      result: {
        message: creatorReceipt({
          followingText: "129",
          followersText: "531",
          likesCollectsText: "892",
        }),
      },
    });
    const audit = await finishedAudit(h, account);
    expect(audit.status).toBe("completed");
    expect(audit.flags).toEqual(["countsChanged", "possibleSelfLike"]);

    await expect(h.service.confirmBaseline(audit.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("已人工检查"),
    });
    h.advance(MINUTE);
    const baseline = await h.service.confirmBaseline(audit.id, {
      manualChecked: true,
    });
    expect(baseline.audit.manualCheckAt).toBe(
      new Date(START + 3 * MINUTE).toISOString(),
    );
    expect(baseline.account.takeover?.baselineAuditId).toBe(audit.id);
    expect(baseline.event.payload.flags).toEqual([
      "countsChanged",
      "possibleSelfLike",
    ]);
  });

  it("grades header diffs: followers and approximate counts never flag, a larger likes rise is growth", () => {
    const counts = (
      following: string,
      followers: string,
      likesCollects: string,
    ): XhsOpsHeaderCounts => ({
      following: xhsOpsParseCount(following),
      followers: xhsOpsParseCount(followers),
      likesCollects: xhsOpsParseCount(likesCollects),
    });
    const audit = (
      header: XhsOpsHeaderCounts,
      headerEnd: XhsOpsHeaderCounts,
      creatorHeader: XhsOpsHeaderCounts,
    ): XhsOpsAccountAudit =>
      xhsOpsAccountAuditSchema.parse({
        id: "a",
        projectId: "p",
        accountId: "acc",
        deviceId: DEVICE,
        platformAccountId: XHS_ID,
        status: "completed",
        startedAt: new Date(START).toISOString(),
        createdAt: new Date(START).toISOString(),
        updatedAt: new Date(START).toISOString(),
        home: {
          status: "read",
          code: "ok",
          evidence: null,
          nickname: "",
          header,
          headerEnd,
          notesEnd: true,
          notes: [],
        },
        creator: {
          status: "read",
          code: "ok",
          evidence: null,
          nickname: "",
          header: creatorHeader,
          periodLabel: "",
          views: null,
          interactions: null,
          newFollowers: null,
          profileVisitors: null,
          accountStatus: "",
        },
      });
    const none = { audits: [], changeOrders: [] };
    expect(
      auditDerivedFlags(
        audit(
          counts("128", "500", "890"),
          counts("128", "560", "890"),
          counts("128", "590", "895"),
        ),
        none,
      ),
    ).toEqual([]);
    expect(
      auditDerivedFlags(
        audit(
          counts("1.2万", "1.2万", "8.9万"),
          counts("1.3万", "1.3万", "9.0万"),
          counts("1.3万", "1.3万", "9.0万"),
        ),
        none,
      ),
    ).toEqual([]);
    expect(
      auditDerivedFlags(
        audit(
          counts("128", "500", "890"),
          counts("128", "500", "891"),
          counts("128", "500", "891"),
        ),
        none,
      ),
    ).toEqual(["possibleSelfLike"]);
  });

  it("does not trust evidence without a receipt line, over the click ceiling or contradicted by the phone", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    h.phone.queue("profile", {
      kind: "result",
      result: { message: profileReceipt({}, null) },
    });
    h.phone.queue("home", {
      kind: "result",
      result: { message: homeReceipt({}, 9) },
    });
    h.phone.queue("creator", {
      kind: "result",
      result: {
        success: false,
        status: "error",
        errorCode: "REPORT_AUDIT_CONTRADICTED",
        message: creatorReceipt(),
      },
    });
    const audit = await finishedAudit(h, account);
    expect(audit.profile?.evidence).toMatchObject({
      receiptClicks: null,
      trusted: false,
    });
    expect(audit.home?.evidence).toMatchObject({
      receiptClicks: 9,
      trusted: false,
    });
    expect(audit.creator).toMatchObject({
      status: "partial",
      evidence: { trusted: false },
    });
    expect(audit.status).toBe("partial");
    expect(audit.reason).toContain("创作者数据");
    // Only an over-ceiling count is a warning; a missing line is just untrusted.
    expect(audit.flags).toEqual(["unexpectedClicks"]);
    await expect(h.service.confirmBaseline(audit.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      h.service.confirmBaseline(audit.id, { manualChecked: true }),
    ).resolves.toMatchObject({ audit: { id: audit.id } });
  });

  it("flags a name the pages disagree on, and treats missing creator data as normal", async () => {
    const h = harness();
    const account = await lockedAccount(h);
    h.phone.queue("home", {
      kind: "result",
      result: { message: homeReceipt({ nickname: "别的名字" }) },
    });
    h.phone.queue("creator", {
      kind: "result",
      result: {
        message: creatorReceipt({
          status: "unavailable",
          code: "creator_unavailable",
        }),
      },
    });
    const audit = await finishedAudit(h, account);
    expect(audit.status).toBe("completed");
    expect(audit.creator).toMatchObject({
      status: "unavailable",
      code: "creator_unavailable",
    });
    expect(audit.flags).toEqual(["nicknameInconsistent", "creatorUnavailable"]);
    const baseline = await h.service.confirmBaseline(audit.id);
    expect(baseline.event.payload.creator).toBeNull();
  });

  it("checks the phone, the binding and unfinished device work before dispatching anything", async () => {
    const h = harness();
    const account = await authorizedAccount(h);
    await expect(h.service.startAudit(account.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("锁定"),
    });

    const locked = await (async () => {
      h.advance(MINUTE);
      const read = await h.service.readTakeoverIdentity(account.id);
      h.advance(MINUTE);
      return (
        await h.service.confirmTakeoverIdentity(account.id, {
          identityTaskId: read.identity.taskId,
          platformAccountId: XHS_ID,
        })
      ).account;
    })();
    h.phone.dispatched.length = 0;

    h.phone.status = "busy";
    h.phone.currentTaskId = "someone-elses-task";
    await expect(h.service.startAudit(locked.id)).rejects.toMatchObject({
      status: 409,
    });
    h.phone.status = "idle";
    h.phone.currentTaskId = undefined;
    h.phone.online = false;
    await expect(h.service.startAudit(locked.id)).rejects.toMatchObject({
      status: 409,
    });
    h.phone.online = true;

    const run = await h.store.createRun({
      projectId: locked.projectId,
      accountId: locked.id,
      deviceId: DEVICE,
      accountLabel: locked.label,
      date: "2026-10-21",
      status: "planned",
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
        browsedTotal: 0,
        searchBrowsed: 0,
        homeBrowsed: 0,
        interactions: { like: 0, collect: 0, follow: 0 },
        anomalyCount: 0,
        durationMs: null,
      },
      notes: "",
      error: null,
      startedAt: null,
      completedAt: null,
    });
    await expect(h.service.startAudit(locked.id)).rejects.toMatchObject({
      status: 409,
      message: "今天还有待执行的养号或评论任务，请先取消或等它结束",
    });
    await h.store.deleteRun(run.id);

    h.phone.queue("profile", { kind: "hang" });
    const running = await h.service.startAudit(locked.id);
    await expect(h.service.startAudit(locked.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(h.phone.segments()).toEqual(["profile"]);
    await until(
      async () => (await h.store.getAudit(running.id))?.activeTaskId,
      "activeTaskId",
    );
    await h.service.cancelAudit(running.id);
  });

  it("refuses a phone not in enforce mode before the read, the audit and every segment (§5.2)", async () => {
    const h = harness();
    const account = await authorizedAccount(h);
    h.advance(MINUTE);
    for (const mode of ["audit", "off"] as const) {
      h.phone.policyMode = mode;
      const read = await h.service.readTakeoverIdentity(account.id);
      expect(read.identity).toMatchObject({ status: "unavailable" });
      expect(read.identity.reason).toContain("enforce");
    }
    expect(h.phone.dispatched).toEqual([]);

    h.phone.policyMode = "enforce";
    const read = await h.service.readTakeoverIdentity(account.id);
    h.advance(MINUTE);
    const { account: locked } = await h.service.confirmTakeoverIdentity(
      account.id,
      { identityTaskId: read.identity.taskId, platformAccountId: XHS_ID },
    );
    h.phone.dispatched.length = 0;
    h.phone.policyMode = "off";
    await expect(h.service.startAudit(locked.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("enforce"),
    });
    expect(h.phone.dispatched).toEqual([]);

    // The first segment's task reports another mode: the first-progress
    // check fails that very segment and pauses the takeover; no second one.
    h.phone.policyMode = "enforce";
    h.phone.afterTask = () => {
      h.phone.policyMode = "audit";
    };
    const audit = await finishedAudit(h, locked);
    expect(h.phone.segments()).toEqual(["profile"]);
    expect(audit.status).toBe("failed");
    expect(audit.profile).toMatchObject({
      status: "failed",
      code: "policy_not_enforce",
    });
    expect(audit.home).toMatchObject({ status: "skipped" });
    expect(
      (await h.store.getAccount(locked.id))?.takeover?.safetyPause,
    ).toMatchObject({ code: "manual", sourceRef: audit.id });
    expect(await lockFree(h, locked.id)).toBe(true);
  });

  it("stops a segment the moment its task reports another mode, then pauses the takeover (§5.2 前提)", async () => {
    const h = harness();
    const locked = await lockedAccount(h);
    // The mode is unknown until a task reports it: the audit is let through.
    h.phone.queue("profile", { kind: "hang" });
    h.phone.reportOnStart = "audit";
    const audit = await finishedAudit(h, locked);
    expect(h.phone.segments()).toEqual(["identity", "profile"]);
    expect(h.phone.cancelled).toEqual([h.phone.started.at(-1)]);
    expect(audit).toMatchObject({
      status: "failed",
      profile: { status: "failed", code: "policy_not_enforce" },
      home: { status: "skipped" },
    });
    expect(audit.reason).toContain(takeoverPolicyBreachReason("audit"));
    expect(audit.flags).not.toContain("cancellationUnconfirmed");
    expect((await h.store.getAccount(locked.id))?.takeover).toMatchObject({
      safetyPause: {
        code: "manual",
        sourceRef: audit.id,
        reason: takeoverPolicyBreachReason("audit"),
      },
      deviceHold: null,
    });
    expect(await lockFree(h, locked.id)).toBe(true);
  });

  it("stops the identity read too, and keeps nothing it read", async () => {
    const h = harness();
    const account = await authorizedAccount(h);
    h.advance(MINUTE);
    h.phone.queue("identity", { kind: "hang" });
    h.phone.reportOnStart = "off";
    const read = await h.service.readTakeoverIdentity(account.id);
    expect(read.identity).toMatchObject({
      status: "unavailable",
      reason: takeoverPolicyBreachReason("off"),
    });
    expect(h.phone.cancelled).toEqual(h.phone.started);
    expect((await h.store.getAccount(account.id))?.takeover).toMatchObject({
      pendingIdentity: null,
      safetyPause: { code: "manual", sourceRef: "takeover-identity" },
    });
    expect(await lockFree(h, account.id)).toBe(true);
  });
});

// ─── Re-baseline and drift ──────────────────────────────────────────────────

describe("re-baselining", () => {
  it("syncs draft and awaiting_confirm orders, drops fields already at their target and cancels empty orders", async () => {
    const h = harness();
    const { account, audit: first } = await baselinedAccount(h);
    const seed = {
      projectId: account.projectId,
      accountId: account.id,
      deviceId: DEVICE,
      platformAccountId: XHS_ID,
      diagnosisId: null,
    };
    const textOrder = await h.store.createChangeOrder({
      ...seed,
      proposalIds: ["P4", "P5"],
      batchIndex: 1,
      risk: "L1",
      fields: [
        { field: "bio", baselineValue: PROFILE_VALUES.bio, after: "新简介" },
        { field: "occupation", baselineValue: "设计师", after: "产品经理" },
      ],
      status: "draft",
    });
    const pendingOrder = await h.store.createChangeOrder({
      ...seed,
      proposalIds: ["P6"],
      batchIndex: 2,
      risk: "L2",
      fields: [
        { field: "nickname", baselineValue: "通勤小林", after: "通勤护肤日记" },
      ],
      status: "draft",
    });
    await h.store.mutateTakeover(account.id, (snapshot) => ({
      account: {
        ...snapshot.account,
        takeover: {
          ...must(snapshot.account.takeover),
          activeChangeOrderId: pendingOrder.id,
        },
      },
      changeOrders: snapshot.changeOrders.map((order) =>
        order.id === pendingOrder.id
          ? {
              ...order,
              status: "awaiting_confirm" as const,
              precheck: {
                taskId: "precheck-task",
                readAt: snapshot.now,
                accountMatched: true,
                drift: [],
                confirmDigest: "a".repeat(64),
                expiresAt: new Date(START + HOUR).toISOString(),
              },
            }
          : order,
      ),
      result: null,
    }));
    const regionOrder = await h.store.createChangeOrder({
      ...seed,
      proposalIds: ["P8"],
      batchIndex: 2,
      risk: "L2",
      fields: [
        {
          field: "region",
          baselineValue: PROFILE_VALUES.region,
          after: "中国 北京 北京",
        },
      ],
      status: "draft",
    });

    h.advance(HOUR);
    h.phone.queue("profile", {
      kind: "result",
      result: {
        message: profileReceipt({
          bio: "新简介",
          occupation: "教师",
          nickname: "小林同学",
          region: "中国 北京 北京",
        }),
      },
    });
    h.phone.queue("home", {
      kind: "result",
      result: { message: homeReceipt({ nickname: "小林同学" }) },
    });
    h.phone.queue("creator", {
      kind: "result",
      result: { message: creatorReceipt({ nickname: "小林同学" }) },
    });
    const second = await finishedAudit(h, account);
    expect(second.trigger).toBe("manual");
    expect(second.flags).toEqual(["profileDrift"]);
    await expect(h.service.confirmBaseline(first.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(h.service.confirmBaseline(second.id)).rejects.toMatchObject({
      status: 409,
    });

    const rebased = await h.service.confirmBaseline(second.id, {
      manualChecked: true,
    });
    expect(rebased.account.takeover).toMatchObject({
      baselineAuditId: second.id,
      activeChangeOrderId: null,
    });
    expect(rebased.changeOrders.map((order) => order.id).sort()).toEqual(
      [textOrder.id, pendingOrder.id, regionOrder.id].sort(),
    );
    expect(must(await h.store.getChangeOrder(textOrder.id))).toMatchObject({
      status: "draft",
      proposalIds: ["P5"],
      fields: [
        expect.objectContaining({
          field: "occupation",
          baselineValue: "教师",
          after: "产品经理",
        }),
      ],
    });
    expect(must(await h.store.getChangeOrder(pendingOrder.id))).toMatchObject({
      status: "draft",
      precheck: null,
      fields: [
        expect.objectContaining({
          field: "nickname",
          baselineValue: "小林同学",
        }),
      ],
    });
    expect(must(await h.store.getChangeOrder(regionOrder.id))).toMatchObject({
      status: "cancelled",
      fields: [expect.objectContaining({ note: "手机上已是目标值" })],
    });
  });

  it("treats a region the phone shows with spaces as the target written without them (B5)", async () => {
    const h = harness();
    const { account } = await baselinedAccount(h);
    const order = await h.store.createChangeOrder({
      projectId: account.projectId,
      accountId: account.id,
      deviceId: DEVICE,
      platformAccountId: XHS_ID,
      diagnosisId: null,
      proposalIds: ["P6", "P8"],
      batchIndex: 2,
      risk: "L2",
      fields: [
        { field: "nickname", baselineValue: "通勤小林", after: "通勤护肤日记" },
        {
          field: "region",
          baselineValue: PROFILE_VALUES.region,
          after: "中国浙江杭州",
        },
      ],
      status: "draft",
    });

    // Someone moved the region on the phone; the page lays it out with spaces.
    h.advance(HOUR);
    h.phone.queue("profile", {
      kind: "result",
      result: { message: profileReceipt({ region: "中国 浙江 杭州" }) },
    });
    const second = await finishedAudit(h, account);
    expect(second.flags).toEqual(["profileDrift"]);
    const rebased = await h.service.confirmBaseline(second.id, {
      manualChecked: true,
    });

    expect(rebased.changeOrders.map((entry) => entry.id)).toEqual([order.id]);
    // The region already is the target: it leaves the order, the nickname stays.
    expect(must(await h.store.getChangeOrder(order.id))).toMatchObject({
      status: "draft",
      proposalIds: ["P6"],
      fields: [
        expect.objectContaining({
          field: "nickname",
          baselineValue: "通勤小林",
          after: "通勤护肤日记",
        }),
      ],
    });
  });

  it("does not call a change our own order made a drift", async () => {
    const h = harness();
    const { account } = await baselinedAccount(h);
    const order = await h.store.createChangeOrder({
      projectId: account.projectId,
      accountId: account.id,
      deviceId: DEVICE,
      platformAccountId: XHS_ID,
      diagnosisId: null,
      proposalIds: [],
      batchIndex: 1,
      risk: "L1",
      fields: [
        { field: "bio", baselineValue: PROFILE_VALUES.bio, after: "新简介" },
      ],
      status: "draft",
    });
    h.advance(HOUR);
    await h.store.updateChangeOrder(order.id, (current) => ({
      ...current,
      status: "observing",
      confirmedAt: new Date(START + 2 * HOUR).toISOString(),
      applyTaskId: "apply-task",
      verificationTaskId: "verify-task",
      fields: current.fields.map((field) => ({
        ...field,
        outcome: "verified" as const,
      })),
    }));
    h.advance(2 * HOUR);
    h.phone.queue("profile", {
      kind: "result",
      result: { message: profileReceipt({ bio: "新简介" }) },
    });
    const audit = await finishedAudit(h, account);
    expect(audit.status).toBe("completed");
    expect(audit.flags).toEqual([]);
    await expect(h.service.confirmBaseline(audit.id)).resolves.toMatchObject({
      audit: { id: audit.id, manualCheckAt: null },
    });
  });
});

// ─── Audit comparison: pin state (§7.1) ─────────────────────────────────────

describe("audit comparison: pins (§7.1)", () => {
  function gridAudit(
    id: string,
    notes: ReadonlyArray<readonly [title: string, pinned: boolean]> | null,
  ): XhsOpsAccountAudit {
    const at = new Date(START).toISOString();
    return xhsOpsAccountAuditSchema.parse({
      id,
      projectId: "project-1",
      accountId: "account-1",
      deviceId: DEVICE,
      platformAccountId: XHS_ID,
      status: "completed",
      startedAt: at,
      createdAt: at,
      updatedAt: at,
      home:
        notes === null
          ? null
          : {
              status: "read",
              code: "ok",
              evidence: null,
              nickname: "通勤小林",
              header: null,
              headerEnd: null,
              notesEnd: true,
              notes: notes.map(([title, pinned], index) => ({
                i: index + 1,
                title,
                likes: null,
                video: false,
                pinned,
              })),
            },
    });
  }

  it("reports the cards a re-audit finds pinned or unpinned, after the advice was acted on", async () => {
    const h = harness();
    const { account, audit: base } = await baselinedAccount(h);
    expect(base.home?.notes.map((note) => note.pinned)).toEqual([true, false]);

    // The owner unpinned the first note and pinned the second one; the second
    // title now comes back cut short, and a new pinned note appeared.
    h.advance(HOUR);
    h.phone.queue("home", {
      kind: "result",
      result: {
        message: homeReceipt({
          notes: [
            {
              i: 1,
              title: "周末探店…",
              likesText: "1.1万",
              video: true,
              pinned: true,
            },
            {
              i: 2,
              title: "新品试用 一周反馈",
              likesText: "12",
              video: false,
              pinned: true,
            },
            {
              i: 3,
              title: "通勤穿搭合集 微信abc123456",
              likesText: "356",
              video: false,
              pinned: false,
            },
          ],
        }),
      },
    });
    const review = await finishedAudit(h, account);

    const comparison = compareXhsOpsAudits(base, review);
    expect(comparison.pins).toEqual({
      pinned: ["周末探店…"],
      unpinned: [must(review.home?.notes[2]).title],
    });
    // A card the base grid never held is a new note, not a pin change.
    expect(comparison.notes?.added).toEqual(["新品试用 一周反馈"]);
    expect(compareXhsOpsAudits(base, base).pins).toEqual({
      pinned: [],
      unpinned: [],
    });
  });

  it("matches cards by title prefix and reports nothing when a grid was not read", () => {
    const base = gridAudit("audit-base", [
      ["静安寺 咖啡探店 第二篇", true],
      ["早八通勤妆", false],
      ["早八通勤妆", true],
      ["只在基线里的笔记", true],
    ]);
    const target = gridAudit("audit-target", [
      // Spacing and the cut-off ellipsis do not make another card.
      ["静安寺咖啡探店第二篇…", false],
      // The first card per prefix counts on both sides.
      ["早八通勤妆", true],
      ["早八通勤妆", false],
    ]);
    expect(compareXhsOpsAudits(base, target).pins).toEqual({
      pinned: ["早八通勤妆"],
      unpinned: ["静安寺咖啡探店第二篇…"],
    });
    expect(compareXhsOpsAudits(base, target).notes?.removed).toEqual([
      "只在基线里的笔记",
    ]);
    expect(
      compareXhsOpsAudits(gridAudit("audit-x", null), target).pins,
    ).toBeNull();
    expect(
      compareXhsOpsAudits(base, gridAudit("audit-y", null)).pins,
    ).toBeNull();
  });
});

describe("privacy", () => {
  it("masks contact details in phone text before it reaches an event", () => {
    expect(
      xhsOpsRedactContact(
        "合作加 vx: lin_2024abc 或 13812345678，邮箱 a.b@example.com，主页 https://x.example/u 号 1234567",
      ),
    ).toBe("合作加 [联系方式] 或 [电话]，邮箱 [邮箱]，主页 [链接] 号 [号码]");
    expect(xhsOpsRedactContact("通勤穿搭合集 第3篇")).toBe(
      "通勤穿搭合集 第3篇",
    );
  });
});
