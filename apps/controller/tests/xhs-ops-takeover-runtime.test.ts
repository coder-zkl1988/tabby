import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  type DeviceExecuteTaskBody,
  type DeviceInfo,
  type TaskResult,
  type XhsOpsAccount,
  type XhsOpsPlanSkip,
  type XhsOpsRun,
  deviceInfoSchema,
  xhsOpsAccountNurtureIssues,
  xhsOpsTakeoverStage,
} from "@nexu/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControllerContainer } from "../src/app/container.js";
import { logger } from "../src/lib/logger.js";
import { localDateString } from "../src/lib/xhs-ops-common.js";
import { registerDeviceControlRoutes } from "../src/routes/device-control-routes.js";
import { registerXhsOpsRoutes } from "../src/routes/xhs-ops-routes.js";
import { XhsOpsChangeOrderService } from "../src/services/xhs-ops-change-order-service.js";
import {
  buildPreparationRequest,
  buildTakeoverIdentityGateRequest,
  takeoverSafetyPause,
} from "../src/services/xhs-ops-preparation.js";
import {
  XHS_EXISTING_TASK_POLICY,
  XHS_PACKAGE,
  XHS_TASK_POLICY,
  XhsOpsRunService,
  commentTaskPolicy,
} from "../src/services/xhs-ops-run-service.js";
import { XhsOpsScheduler } from "../src/services/xhs-ops-scheduler.js";
import { takeoverPolicyBreachReason } from "../src/services/xhs-ops-takeover-phone.js";
import type { XhsOpsTakeoverRecoveryState } from "../src/services/xhs-ops-takeover-recovery.js";
import { XHS_AUDIT_CLICK_LIMITS } from "../src/services/xhs-ops-task-builder.js";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";
import type { ControllerBindings } from "../src/types.js";

// Runtime wiring of 老号接管 (takeover §5.3 #5/#7, §5.4 N3, §5.2 前提, §6.1,
// §6.5; P0 acceptance #5, #6, #7, #10): what the run service and the
// scheduler dispatch for existing accounts, and what they refuse to.

// Local 10:00: inside the comment window, and the day noNurtureDates uses.
const START = new Date(2026, 9, 21, 10, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const XHS_ID = "xhs-owner-001";
const RECEIPT = "[回执] 各应用生效点击: com.xingin.xhs=2";
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

const sha256 = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

const QUIET_INTERACTION = {
  like: { enabled: false, dailyCap: 0, ratioPercent: 0 },
  collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
  follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
  comment: { enabled: false, dailyCap: 2 },
};

/** Two posts a day in one segment: one search keyword and one home post. */
const SMALL_BROWSE = {
  dwellSecMin: 11,
  dwellSecMax: 20,
  searchRatioPercent: 50,
  postsPerKeyword: 1,
  homeFeedCount: 1,
  dailyTargetPosts: 2,
  dailySegments: 1,
};

// ─── Fake phone ─────────────────────────────────────────────────────────────

type Kind = "gate" | "preparation" | "search" | "home" | "comment";

function kindOf(body: DeviceExecuteTaskBody): Kind {
  if (body.taskPolicy?.operationClass === "account.login")
    return body.task.includes("【接管账号运行前身份闸门】")
      ? "gate"
      : "preparation";
  if (body.task.includes("【小红书评论任务")) return "comment";
  return body.task.includes("首页推荐流") ? "home" : "search";
}

/** What a browse chunk asks for, read back off its task text. */
function chunkOf(task: string): { keyword: string | null; count: number } {
  const search = /搜索「(.+?)」，完整浏览 (\d+) 篇/.exec(task);
  if (search) return { keyword: search[1] ?? "", count: Number(search[2]) };
  const home = /首页推荐流自然浏览 (\d+) 篇/.exec(task);
  return { keyword: null, count: Number(home?.[1] ?? 0) };
}

class FakePhone {
  status: DeviceInfo["status"] = "idle";
  currentTaskId: string | undefined;
  /** The mode the device status carries; undefined before the phone's first task. */
  policyMode: DeviceInfo["devicePolicyMode"];
  /** The mode a task of this kind reports at TASK_START (tabby-control keeps it). */
  readonly reports = new Map<
    Kind,
    NonNullable<DeviceInfo["devicePolicyMode"]>
  >();
  /** Tasks of these kinds keep running until they are cancelled. */
  readonly hang = new Set<Kind>();
  /** Runs once a task of this kind started, before it ends. */
  readonly onStart = new Map<Kind, () => Promise<void>>();
  /** The message a task of this kind returns instead of its receipt. */
  readonly messages = new Map<Kind, string>();
  /** What a browse chunk of this kind records as its anomalies. */
  readonly anomalies = new Map<Kind, Array<{ type: string; detail: string }>>();
  /**
   * Calls of these kinds lose their answer: the dispatch throws
   * `message(taskId)`; with `busy` the task stays on the device.
   */
  readonly lose = new Map<
    Kind,
    { message: (taskId: string) => string; busy: boolean }
  >();
  gate = { status: "ready", code: "ready" };
  readonly dispatched: Array<{
    kind: Kind;
    body: DeviceExecuteTaskBody;
    taskId: string;
  }> = [];
  readonly cancelled: string[] = [];
  running = 0;
  maxRunning = 0;
  private readonly pending = new Map<string, (result: TaskResult) => void>();
  private seq = 0;

  constructor(private readonly clock: { now: number }) {}

  kinds(): Kind[] {
    return this.dispatched.map((entry) => entry.kind);
  }

  bodies(): DeviceExecuteTaskBody[] {
    return this.dispatched.map((entry) => entry.body);
  }

  private end(taskId: string): void {
    this.running -= 1;
    if (this.currentTaskId === taskId) {
      this.status = "idle";
      this.currentTaskId = undefined;
    }
  }

  private respond(kind: Kind, taskId: string, task: string): TaskResult {
    const message = this.messages.get(kind);
    if (message !== undefined)
      return { taskId, success: true, status: "completed", message };
    if (kind === "gate" || kind === "preparation") {
      const { status, code } = this.gate;
      return {
        taskId,
        success: status === "ready",
        status: "completed",
        message: `PREPARATION_JSON:${JSON.stringify({ v: 1, status, code, profileVerified: status === "ready" })}`,
      };
    }
    if (kind === "comment")
      return {
        taskId,
        success: true,
        status: "completed",
        message: `ok\nCOMMENT_JSON:{"status":"sent","detail":"评论区已出现"}\n${RECEIPT}`,
      };
    const { keyword, count } = chunkOf(task);
    return {
      taskId,
      success: true,
      status: "completed",
      message: `RECORD_JSON:${JSON.stringify({
        mode: kind,
        keyword,
        planned: count,
        browsed: count,
        refreshCount: kind === "home" ? 1 : 0,
        posts: Array.from({ length: count }, (_, index) => ({
          title: `第${index + 1}篇`,
          dwellSeconds: 12,
          commentsRead: 0,
          commentsComplete: true,
          actions: [],
        })),
        interactions: { like: 0, collect: 0, follow: 0 },
        anomalies: this.anomalies.get(kind) ?? [],
        observation: "推荐流匹配度：中。",
      })}`,
    };
  }

  readonly control = {
    getDevice: async (deviceId: string): Promise<DeviceInfo> => ({
      deviceId,
      status: this.status,
      currentTaskId: this.currentTaskId,
      connectedAt: 1,
      lastSeen: this.clock.now,
      ...(this.policyMode ? { devicePolicyMode: this.policyMode } : {}),
    }),
    executeTask: async (
      _deviceId: string,
      body: DeviceExecuteTaskBody,
    ): Promise<{ result: TaskResult }> => {
      const kind = kindOf(body);
      const taskId = `task-${++this.seq}`;
      this.dispatched.push({ kind, body, taskId });
      this.running += 1;
      this.maxRunning = Math.max(this.maxRunning, this.running);
      this.status = "busy";
      this.currentTaskId = taskId;
      const reported = this.reports.get(kind);
      if (reported) this.policyMode = reported;
      await this.onStart.get(kind)?.();
      const lost = this.lose.get(kind);
      if (lost) {
        if (!lost.busy) this.end(taskId);
        throw new Error(lost.message(taskId));
      }
      if (this.hang.has(kind)) {
        const result = await new Promise<TaskResult>((resolve) => {
          this.pending.set(taskId, resolve);
        });
        return { result };
      }
      // Long enough for the policy poll to see the task running.
      await sleep(5);
      // Each post dwells 12 s, so the chunk's fake time has to cover them.
      this.clock.now += (chunkOf(body.task).count * 12 + 5) * 1000;
      const result = this.respond(kind, taskId, body.task);
      this.end(taskId);
      return { result };
    },
    cancelTask: async (_deviceId: string, { taskId }: { taskId: string }) => {
      this.cancelled.push(taskId);
      const pending = this.pending.get(taskId);
      if (pending) {
        this.pending.delete(taskId);
        this.end(taskId);
        pending({
          taskId,
          success: false,
          status: "aborted",
          errorCode: "USER_CANCELLED",
        });
      }
      return { cancelled: true };
    },
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

async function world(
  options: {
    recovery?: XhsOpsTakeoverRecoveryState;
    deviceWorkWaitMs?: number;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "xhs-takeover-runtime-"));
  directories.push(directory);
  const clock = { now: START };
  let id = 0;
  const store = new XhsOpsStore(join(directory, "state.json"), {
    now: () => new Date(clock.now).toISOString(),
    genId: () => `id-${++id}`,
  });
  const phone = new FakePhone(clock);
  const service = new XhsOpsRunService({
    store,
    deviceControl: phone.control,
    takeoverRecovery: options.recovery,
    options: {
      now: () => clock.now,
      idlePollIntervalMs: 1,
      policyPollIntervalMs: 1,
      deviceWorkWaitMs: options.deviceWorkWaitMs ?? 0,
    },
  });
  const created = await store.createProject({
    name: "接管运行",
    business: { industry: "美妆", product: "护肤品" },
    audience: {
      ageRange: "25–32",
      genderRatio: "女80%男20%",
      regions: ["上海"],
    },
  });
  const project = await store.confirmProfile(created.id, {
    profile: {
      summary: "上海职场女性",
      base: { ageRange: "25–32", genderRatio: "女80%男20%", regions: ["上海"] },
      verticalInterests: ["护肤"],
      generalInterests: ["咖啡", "通勤"],
    },
    expectedUpdatedAt: created.updatedAt,
  });
  return { directory, store, phone, service, clock, project };
}
type World = Awaited<ReturnType<typeof world>>;

type AccountInput = Partial<Parameters<XhsOpsStore["createAccount"]>[0]>;

/** An existing row the pre-takeover flow verified: it nurtures without a takeover (D5). */
async function legacyAccount(
  w: World,
  overrides: AccountInput = {},
): Promise<XhsOpsAccount> {
  const account = await w.store.createAccount({
    projectId: w.project.id,
    entryMode: "existing",
    label: "老号·一号机",
    positioning: "通勤护肤记录",
    interestPool: { core: ["通勤护肤"], extended: [], general: [] },
    browseDefaults: SMALL_BROWSE,
    interaction: QUIET_INTERACTION,
    platformAccountId: XHS_ID,
    deviceId: "phone-1",
    deviceName: "一号机",
    ...overrides,
  });
  const at = new Date(w.clock.now - HOUR).toISOString();
  return must(
    await w.store.updateAccount(
      account.id,
      {},
      {
        profileApplyResult: {
          expectedProfileDraft: account.profileDraft,
          expectedPlatformAccountId: account.platformAccountId,
          appliedAt: at,
          applyStatus: "applied",
          applyResult: "legacy verified",
          verifiedAt: at,
          verifiedAccountId: account.platformAccountId,
          verificationTaskId: "legacy-verification",
        },
      },
    ),
  );
}

/** A verified row whose takeover was authorized: identity preset as legacy, it keeps nurturing. */
async function takeoverAccount(
  w: World,
  overrides: AccountInput = {},
): Promise<XhsOpsAccount> {
  const legacy = await legacyAccount(w, overrides);
  return w.store.authorizeTakeover(legacy.id, {
    expectedUpdatedAt: legacy.updatedAt,
    ownershipConfirmed: true,
  });
}

function planFor(account: XhsOpsAccount) {
  return {
    keywords: [
      { keyword: account.interestPool.core[0] ?? "通勤护肤", count: 1 },
    ],
    homeFeedCount: 1,
    dwellSecMin: 11,
    dwellSecMax: 20,
    interaction: account.interaction,
  };
}

async function startRun(w: World, account: XhsOpsAccount): Promise<string> {
  const run = await w.service.createRun({
    projectId: w.project.id,
    accountId: account.id,
    plan: planFor(account),
  });
  await w.service.startRun(run.id);
  return run.id;
}

async function runOnce(w: World, account: XhsOpsAccount): Promise<XhsOpsRun> {
  const runId = await startRun(w, account);
  await w.service.waitForRun(runId);
  return must(await w.store.getRun(runId));
}

/** P0 #6: an existing account's task never opens system settings or SMS, and never types while login is allowed. */
function expectExistingAccountPolicy(body: DeviceExecuteTaskBody): void {
  const policy = body.taskPolicy;
  expect(policy?.allowedAppRoles).not.toContain("system_settings");
  expect(policy?.allowedAppRoles).not.toContain("default_sms");
  if (policy?.allowedActions?.includes("TYPE")) {
    expect(policy.confirmationPolicy?.login).toBe("forbidden");
    expect(policy.operationClass).not.toBe("account.login");
  }
}

function schedulerFor(w: World) {
  return new XhsOpsScheduler({
    store: w.store,
    runService: w.service,
    changeOrders: {
      listChangeOrders: (accountId: string) =>
        w.store.listChangeOrders({ accountId }),
    },
    now: () => w.clock.now,
  });
}

async function runsOf(w: World, accountId: string): Promise<XhsOpsRun[]> {
  return w.store.listRuns({ accountId });
}

/** Comments switched on, today's browsing that earns two, and one approved draft. */
async function seedCommentQuota(w: World, account: XhsOpsAccount) {
  // Browsing earns the comment quota: one comment per 8 posts today.
  await w.store.createRun({
    projectId: w.project.id,
    accountId: account.id,
    deviceId: "phone-1",
    accountLabel: account.label,
    date: "2026-10-21",
    status: "completed",
    plan: {
      ...planFor(account),
      keywords: [{ keyword: "通勤护肤", count: 8 }],
    },
    segment: null,
    queuedBehindRunId: null,
    chunks: [],
    notes: "",
    error: null,
    startedAt: new Date(START - 2 * HOUR).toISOString(),
    completedAt: new Date(START - HOUR).toISOString(),
    summary: {
      plannedTotal: 16,
      browsedTotal: 16,
      searchBrowsed: 8,
      homeBrowsed: 8,
      interactions: { like: 0, collect: 0, follow: 0 },
      anomalyCount: 0,
      durationMs: 1000,
    },
  });
  await w.store.createComment({
    projectId: w.project.id,
    accountId: account.id,
    deviceId: "phone-1",
    sourceRunId: "r0",
    sourceChunkIndex: 0,
    sourcePostIndex: 0,
    post: { title: "通勤护肤帖", author: "作者", summary: "" },
    candidates: ["写得很实用"],
    text: "写得很实用",
    status: "approved",
    reviewedAt: new Date(START - HOUR).toISOString(),
    reviewNote: "",
    sentRunId: null,
    sentAt: null,
    sendResult: null,
  });
}

const COMMENTS_ON = {
  interaction: {
    ...QUIET_INTERACTION,
    comment: { enabled: true, dailyCap: 2 },
  },
};

// ─── §5.3 #7: the pre-run identity gate ─────────────────────────────────────

describe("pre-run identity gate of existing accounts (§5.3 #7)", () => {
  it("schedules a verified row without a takeover as before, its preparation being the read-only gate (#6, #7)", async () => {
    const w = await world();
    const account = await legacyAccount(w);
    const result = await schedulerFor(w).triggerProject(w.project.id, {
      reason: "schedule",
    });
    expect(result).toMatchObject({ created: 1, started: 1, skipped: [] });
    const [run] = await runsOf(w, account.id);
    await w.service.waitForRun(must(run).id);

    expect(w.phone.kinds()).toEqual(["gate", "search", "home"]);
    expect(w.phone.dispatched[0]?.body).toEqual(
      buildTakeoverIdentityGateRequest(XHS_PACKAGE, XHS_ID),
    );
    for (const body of w.phone.bodies()) expectExistingAccountPolicy(body);
    expect(
      w.phone
        .bodies()
        .slice(1)
        .map((body) => body.taskPolicy),
    ).toEqual([XHS_EXISTING_TASK_POLICY, XHS_EXISTING_TASK_POLICY]);
    expect(await w.store.getRun(must(run).id)).toMatchObject({
      status: "completed",
      preparation: { status: "ready", reasonCode: "ready" },
    });
    expect((await w.store.getAccount(account.id))?.takeover).toBeNull();
  });

  it.each([
    ["phone_required", "请账号本人在手机上登录原账号，桌面不会代为登录"],
    [
      "account_mismatch",
      "手机上当前登录的不是这个账号，请账号本人在手机上切换回来",
    ],
  ])(
    "fails a row without a takeover on %s without a pause, and the next round runs the gate again",
    async (code, reason) => {
      const w = await world();
      const account = await legacyAccount(w);
      w.phone.gate = { status: "blocked", code };
      const scheduler = schedulerFor(w);
      await scheduler.triggerProject(w.project.id, { reason: "schedule" });
      const [first] = await runsOf(w, account.id);
      await w.service.waitForRun(must(first).id);
      expect(await w.store.getRun(must(first).id)).toMatchObject({
        status: "failed",
        error: reason,
        preparation: { status: "blocked", reasonCode: code, reason },
        chunks: [{ status: "skipped" }, { status: "skipped" }],
      });
      expect(w.phone.kinds()).toEqual(["gate"]);
      // Nowhere to keep a pause: the row is exactly as it was.
      expect((await w.store.getAccount(account.id))?.takeover).toBeNull();
      expect(
        xhsOpsAccountNurtureIssues(
          must(await w.store.getAccount(account.id)),
          w.project,
        ),
      ).toEqual([]);

      // The next round: the gate runs again and, ready now, nurture follows.
      w.clock.now += DAY;
      w.phone.gate = { status: "ready", code: "ready" };
      const next = await scheduler.triggerProject(w.project.id, {
        reason: "schedule",
      });
      expect(next).toMatchObject({ created: 1, started: 1, skipped: [] });
      const [second] = await runsOf(w, account.id);
      await w.service.waitForRun(must(second).id);
      expect(w.phone.kinds()).toEqual(["gate", "gate", "search", "home"]);
      expect((await w.store.getRun(must(second).id))?.status).toBe("completed");
    },
  );

  it.each([
    ["phone_required", "login_required", false],
    ["account_mismatch", "account_mismatch", false],
    ["rate_limited", "rate_limited", true],
    ["account_restricted", "account_restricted", true],
  ] as const)(
    "pauses a takeover whose gate answers %s as %s",
    async (code, pauseCode, cooldown) => {
      const w = await world();
      const account = await takeoverAccount(w);
      w.phone.gate = { status: "blocked", code };
      const run = await runOnce(w, account);
      expect(run).toMatchObject({
        status: "failed",
        preparation: { status: "blocked", reasonCode: code },
      });
      expect(w.phone.kinds()).toEqual(["gate"]);
      const pause = must(
        (await w.store.getAccount(account.id))?.takeover?.safetyPause,
      );
      expect(pause).toMatchObject({
        code: pauseCode,
        sourceRef: run.id,
        reason: takeoverSafetyPause(code, "run")?.reason,
      });
      if (cooldown)
        expect(
          Date.parse(must(pause.resumableAfter)) - Date.parse(pause.since),
        ).toBe(48 * HOUR);
      else expect(pause.resumableAfter).toBeNull();
    },
  );

  it("lets a ready gate that clicked past XHS_AUDIT_CLICK_LIMITS.gate go ahead, with a logged warning on the preparation (§3.2 点击对账)", async () => {
    const w = await world();
    const account = await takeoverAccount(w);
    const ready = `PREPARATION_JSON:${JSON.stringify({ v: 1, status: "ready", code: "ready", profileVerified: true })}`;
    const receipt = (clicks: number) =>
      `${ready}\n[回执] 各应用生效点击: ${XHS_PACKAGE}=${clicks}`;
    const NOTICE =
      "xhs-ops: identity gate receipt needs a look, run goes ahead";
    const warn = vi.spyOn(logger, "warn");
    try {
      // Exactly the expected navigation: nothing to report.
      w.phone.messages.set("gate", receipt(XHS_AUDIT_CLICK_LIMITS.gate));
      const quiet = await runOnce(w, account);
      expect(quiet).toMatchObject({
        status: "completed",
        preparation: { status: "ready", reasonCode: "ready" },
      });
      expect(quiet.preparation?.warnings).toBeUndefined();

      w.clock.now += DAY;
      const clicks = XHS_AUDIT_CLICK_LIMITS.gate + 4;
      w.phone.messages.set("gate", receipt(clicks));
      const run = await runOnce(w, account);
      expect(run).toMatchObject({
        status: "completed",
        error: null,
        preparation: {
          status: "ready",
          reasonCode: "ready",
          warnings: [
            `身份闸门点击 ${clicks} 次，超过预期路径的 ${XHS_AUDIT_CLICK_LIMITS.gate} 次，请到手机上看看资料是否被误改`,
          ],
        },
      });
      expect(run.chunks.map((chunk) => chunk.status)).toEqual([
        "completed",
        "completed",
      ]);
      expect(w.phone.kinds()).toEqual([
        "gate",
        "search",
        "home",
        "gate",
        "search",
        "home",
      ]);
      // A click count is only a hint: no pause, the account keeps nurturing.
      expect(
        (await w.store.getAccount(account.id))?.takeover?.safetyPause,
      ).toBeNull();
      const notices = warn.mock.calls.filter(
        ([, message]) => message === NOTICE,
      );
      expect(notices).toEqual([
        [
          {
            runId: run.id,
            accountId: account.id,
            taskId: run.preparation?.taskId,
          },
          NOTICE,
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves a takeover unpaused for a gate code that is no reason to pause", async () => {
    const w = await world();
    const account = await takeoverAccount(w);
    w.phone.gate = { status: "blocked", code: "verification_required" };
    const run = await runOnce(w, account);
    expect(run).toMatchObject({
      status: "failed",
      error: "手机上需要人工验证，本次任务未开始；请账号本人在手机上处理后重试",
    });
    expect(
      (await w.store.getAccount(account.id))?.takeover?.safetyPause,
    ).toBeNull();
  });

  it("dispatches only gated, login-forbidden tasks for every existing account, comment chunks included (#6)", async () => {
    const w = await world();
    const account = await legacyAccount(w, COMMENTS_ON);
    await seedCommentQuota(w, account);
    await runOnce(w, account);
    // A comment goes out at least ten minutes after the last browse.
    w.clock.now += 11 * MINUTE;
    const comment = await w.service.createCommentRun({
      projectId: w.project.id,
      accountId: account.id,
    });
    await w.service.startRun(comment.id);
    await w.service.waitForRun(comment.id);

    // The comment run passes the identity gate first, like the nurture run.
    expect(w.phone.kinds()).toEqual([
      "gate",
      "search",
      "home",
      "gate",
      "comment",
    ]);
    for (const body of w.phone.bodies()) expectExistingAccountPolicy(body);
    expect(w.phone.bodies()[3]).toEqual(
      buildTakeoverIdentityGateRequest(XHS_PACKAGE, XHS_ID),
    );
    expect(w.phone.bodies()[4]?.taskPolicy).toEqual(
      commentTaskPolicy("写得很实用", XHS_EXISTING_TASK_POLICY),
    );
    expect(await w.store.getRun(comment.id)).toMatchObject({
      status: "completed",
      preparation: { status: "ready", reasonCode: "ready" },
    });
  });
});

// ─── §6.1, §8.2 误判身份 ④: comment runs pass the gate too ────────────────────

describe("comment runs behind the identity gate (§6.1, §8.2)", () => {
  async function commentRun(w: World, account: XhsOpsAccount) {
    await seedCommentQuota(w, account);
    const run = await w.service.createCommentRun({
      projectId: w.project.id,
      accountId: account.id,
    });
    await w.service.startRun(run.id);
    await w.service.waitForRun(run.id);
    return must(await w.store.getRun(run.id));
  }

  async function draftsOf(w: World, account: XhsOpsAccount) {
    return (await w.store.listComments({ accountId: account.id })).map(
      (draft) => ({ status: draft.status, sentRunId: draft.sentRunId }),
    );
  }

  it.each([
    ["phone_required", "login_required"],
    ["account_mismatch", "account_mismatch"],
    ["rate_limited", "rate_limited"],
  ] as const)(
    "pauses a takeover whose comment-run gate answers %s as %s, and sends nothing",
    async (code, pauseCode) => {
      const w = await world();
      const account = await takeoverAccount(w, COMMENTS_ON);
      w.phone.gate = { status: "blocked", code };
      const run = await commentRun(w, account);
      expect(w.phone.kinds()).toEqual(["gate"]);
      expect(w.phone.dispatched[0]?.body).toEqual(
        buildTakeoverIdentityGateRequest(XHS_PACKAGE, XHS_ID),
      );
      expect(run).toMatchObject({
        status: "failed",
        preparation: { status: "blocked", reasonCode: code },
        chunks: [{ status: "skipped" }],
      });
      expect(
        (await w.store.getAccount(account.id))?.takeover?.safetyPause,
      ).toMatchObject({
        code: pauseCode,
        sourceRef: run.id,
        reason: takeoverSafetyPause(code, "run")?.reason,
      });
      // The unsent draft goes back to the approved pool.
      expect(await draftsOf(w, account)).toEqual([
        { status: "approved", sentRunId: null },
      ]);
    },
  );

  it.each([
    ["phone_required", "请账号本人在手机上登录原账号，桌面不会代为登录"],
    [
      "account_mismatch",
      "手机上当前登录的不是这个账号，请账号本人在手机上切换回来",
    ],
  ])(
    "fails the comment run of a row without a takeover on %s, without a pause",
    async (code, reason) => {
      const w = await world();
      const account = await legacyAccount(w, COMMENTS_ON);
      w.phone.gate = { status: "blocked", code };
      const run = await commentRun(w, account);
      expect(w.phone.kinds()).toEqual(["gate"]);
      expect(run).toMatchObject({
        status: "failed",
        error: reason,
        preparation: { status: "blocked", reasonCode: code, reason },
        chunks: [{ status: "skipped" }],
      });
      expect((await w.store.getAccount(account.id))?.takeover).toBeNull();
      expect(await draftsOf(w, account)).toEqual([
        { status: "approved", sentRunId: null },
      ]);
    },
  );

  it("sends the comment of a takeover once its gate is ready", async () => {
    const w = await world();
    const account = await takeoverAccount(w, COMMENTS_ON);
    const run = await commentRun(w, account);
    expect(w.phone.kinds()).toEqual(["gate", "comment"]);
    for (const body of w.phone.bodies()) expectExistingAccountPolicy(body);
    expect(run).toMatchObject({
      status: "completed",
      preparation: { status: "ready", reasonCode: "ready" },
    });
    expect(
      (await w.store.getAccount(account.id))?.takeover?.safetyPause,
    ).toBeNull();
    expect(await draftsOf(w, account)).toEqual([
      { status: "sent", sentRunId: run.id },
    ]);
  });

  it("leaves a new account's comment run without any preparation", async () => {
    const w = await world();
    const account = await w.store.createAccount({
      projectId: w.project.id,
      label: "新号·一号机",
      interaction: COMMENTS_ON.interaction,
      platformAccountId: XHS_ID,
      deviceId: "phone-1",
    });
    // A new account's comment run never reaches the gate.
    w.phone.gate = { status: "blocked", code: "phone_required" };
    const run = await commentRun(w, account);
    expect(w.phone.kinds()).toEqual(["comment"]);
    expect(w.phone.bodies()[0]?.taskPolicy).toEqual(
      commentTaskPolicy("写得很实用"),
    );
    expect(run.status).toBe("completed");
    expect(run.preparation).toBeUndefined();
  });
});

// ─── §6.5: a safety stop inside a run ───────────────────────────────────────

describe("a safety stop inside a run (§6.5, §8.2 风控)", () => {
  it.each([
    ["rate_limited", true],
    ["account_restricted", true],
    ["login_required", false],
  ] as const)(
    "pauses a takeover whose chunk reports %s, in fixed words",
    async (type, cooldown) => {
      const w = await world();
      const account = await takeoverAccount(w);
      w.phone.anomalies.set("search", [
        { type, detail: `页面提示，账号 ${XHS_ID}` },
      ]);
      const run = await runOnce(w, account);
      expect(w.phone.kinds()).toEqual(["gate", "search"]);
      expect(run).toMatchObject({
        status: "failed",
        chunks: [{ status: "completed" }, { status: "skipped" }],
      });
      expect(run.error).toContain(`安全停机：手机报告 ${type}`);
      const pause = must(
        (await w.store.getAccount(account.id))?.takeover?.safetyPause,
      );
      expect(pause).toMatchObject({ code: type, sourceRef: run.id });
      // Nothing the phone wrote goes into the pause the card shows.
      expect(pause.reason).not.toContain(XHS_ID);
      if (cooldown)
        expect(
          Date.parse(must(pause.resumableAfter)) - Date.parse(pause.since),
        ).toBe(48 * HOUR);
      else expect(pause.resumableAfter).toBeNull();

      // Tomorrow the scheduler leaves the account out until a person resumes it.
      w.clock.now += DAY;
      const next = await schedulerFor(w).triggerProject(w.project.id, {
        reason: "schedule",
      });
      expect(next.skipped).toEqual([
        `${account.label}：账号暂停中：${pause.reason}`,
      ]);
      expect(w.phone.kinds()).toEqual(["gate", "search"]);
    },
  );

  it("only stops the run of a row without a takeover", async () => {
    const w = await world();
    const account = await legacyAccount(w);
    w.phone.anomalies.set("search", [
      { type: "rate_limited", detail: "操作频繁" },
    ]);
    const run = await runOnce(w, account);
    expect(run).toMatchObject({
      status: "failed",
      chunks: [{ status: "completed" }, { status: "skipped" }],
    });
    expect((await w.store.getAccount(account.id))?.takeover).toBeNull();
  });

  it("refuses a comment run for a paused takeover before anything is claimed", async () => {
    const w = await world();
    const account = await takeoverAccount(w, COMMENTS_ON);
    await seedCommentQuota(w, account);
    await w.store.pauseTakeover(account.id, {
      code: "manual",
      reason: "运营手动暂停",
      sourceRef: "card",
    });
    await expect(
      w.service.createCommentRun({
        projectId: w.project.id,
        accountId: account.id,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "账号暂停中：运营手动暂停",
      code: "takeover_paused",
    });
    // The route answers with the stable code next to the message (A13).
    const app = new OpenAPIHono<ControllerBindings>();
    registerXhsOpsRoutes(app, {
      xhsOpsStore: w.store,
      xhsOpsRunService: w.service,
    } as ControllerContainer);
    const response = await app.request(
      `/api/v1/xhs-ops/projects/${w.project.id}/comment-runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "账号暂停中：运营手动暂停",
      code: "takeover_paused",
    });
    expect(w.phone.dispatched).toEqual([]);
    expect(
      (await w.store.listComments({ accountId: account.id })).map(
        (draft) => draft.sentRunId,
      ),
    ).toEqual([null]);
  });
});

// ─── §5.2 前提: enforce mode ────────────────────────────────────────────────

describe("phone policy mode (§5.2 前提, #6)", () => {
  it.each(["audit", "off"] as const)(
    "refuses every dispatch of an existing account while the phone reports %s",
    async (mode) => {
      for (const create of [legacyAccount, takeoverAccount]) {
        const w = await world();
        const account = await create(w);
        w.phone.policyMode = mode;
        const run = await runOnce(w, account);
        expect(w.phone.dispatched).toEqual([]);
        expect(run).toMatchObject({
          status: "failed",
          preparation: { status: "failed", reasonCode: "policy_not_enforce" },
        });
        expect(run.error).toContain(`策略模式是 ${mode}`);
        // A refusal sent nothing, so there is nothing to pause for.
        expect(
          (await w.store.getAccount(account.id))?.takeover?.safetyPause ?? null,
        ).toBeNull();
      }
    },
  );

  it("stops the gate the moment its task reports another mode and pauses the takeover", async () => {
    const w = await world();
    const account = await takeoverAccount(w);
    // Unknown before the first report: let through (the documented residual).
    w.phone.reports.set("gate", "audit");
    w.phone.hang.add("gate");
    const run = await runOnce(w, account);
    expect(w.phone.kinds()).toEqual(["gate"]);
    expect(w.phone.cancelled).toEqual([w.phone.dispatched[0]?.taskId]);
    expect(run).toMatchObject({
      status: "failed",
      error: takeoverPolicyBreachReason("audit"),
      preparation: { status: "failed", reasonCode: "policy_not_enforce" },
      chunks: [{ status: "skipped" }, { status: "skipped" }],
    });
    expect(
      (await w.store.getAccount(account.id))?.takeover?.safetyPause,
    ).toMatchObject({
      code: "manual",
      sourceRef: run.id,
      reason: takeoverPolicyBreachReason("audit"),
    });
  });

  it("stops a nurture chunk that reports another mode, pauses the takeover and sends nothing after it", async () => {
    const w = await world();
    const account = await takeoverAccount(w);
    w.phone.reports.set("search", "off");
    w.phone.hang.add("search");
    const run = await runOnce(w, account);
    expect(w.phone.kinds()).toEqual(["gate", "search"]);
    expect(w.phone.cancelled).toEqual([w.phone.dispatched[1]?.taskId]);
    expect(run).toMatchObject({
      status: "failed",
      error: takeoverPolicyBreachReason("off"),
      chunks: [
        { status: "failed", error: takeoverPolicyBreachReason("off") },
        { status: "skipped" },
      ],
    });
    expect(
      (await w.store.getAccount(account.id))?.takeover?.safetyPause,
    ).toMatchObject({ code: "manual", sourceRef: run.id });
  });

  it("only fails the run of a row without a takeover, and the next one is refused before dispatch", async () => {
    const w = await world();
    const account = await legacyAccount(w);
    w.phone.reports.set("home", "audit");
    w.phone.hang.add("home");
    const run = await runOnce(w, account);
    expect(w.phone.kinds()).toEqual(["gate", "search", "home"]);
    expect(run).toMatchObject({
      status: "failed",
      chunks: [{ status: "completed" }, { status: "failed" }],
    });
    expect((await w.store.getAccount(account.id))?.takeover).toBeNull();

    // The phone's last report stays: nothing more goes out to it.
    const next = await runOnce(w, account);
    expect(w.phone.kinds()).toEqual(["gate", "search", "home"]);
    expect(next.preparation).toMatchObject({
      status: "failed",
      reasonCode: "policy_not_enforce",
    });
  });

  it.each(["gate", "search"] as const)(
    "stops the %s task by the device's task when the call's answer was lost (A4)",
    async (kind) => {
      const w = await world();
      const account = await takeoverAccount(w);
      w.phone.reports.set(kind, "audit");
      // A transport failure names no task; the device still runs ours.
      w.phone.lose.set(kind, { message: () => "socket hang up", busy: true });
      const run = await runOnce(w, account);
      const lost = w.phone.dispatched.at(-1);
      expect(lost?.kind).toBe(kind);
      expect(w.phone.cancelled).toEqual([lost?.taskId]);
      expect(run.status).not.toBe("completed");
      expect(
        (await w.store.getAccount(account.id))?.takeover?.safetyPause,
      ).toMatchObject({
        code: "manual",
        reason: takeoverPolicyBreachReason("audit"),
      });
    },
  );

  it("stops a lost chunk by the task its error names (A4)", async () => {
    const w = await world();
    const account = await takeoverAccount(w);
    w.phone.reports.set("search", "off");
    // The device no longer shows it, so only the error's id can stop it.
    w.phone.lose.set("search", {
      message: (taskId) => `TIMEOUT: task ${taskId} made no progress`,
      busy: false,
    });
    await runOnce(w, account);
    const lost = w.phone.dispatched.at(-1);
    expect(lost?.kind).toBe("search");
    expect(w.phone.cancelled).toEqual([lost?.taskId]);
  });

  it("still pauses when the report is only seen after a short task ended", async () => {
    const w = await world();
    const account = await takeoverAccount(w);
    w.phone.reports.set("search", "audit");
    const run = await runOnce(w, account);
    expect(w.phone.kinds()).toEqual(["gate", "search"]);
    expect(run).toMatchObject({
      status: "failed",
      chunks: [
        { status: "failed", error: takeoverPolicyBreachReason("audit") },
        { status: "skipped" },
      ],
    });
    expect(
      (await w.store.getAccount(account.id))?.takeover?.safetyPause,
    ).toMatchObject({ code: "manual", sourceRef: run.id });
  });
});

// ─── §5.4 N3: device exclusivity per dispatch ───────────────────────────────

describe("device exclusivity before every dispatch (§5.4 N3)", () => {
  it("skips the gate while another flow holds the device lock, and runs once it is given back", async () => {
    const w = await world();
    const account = await legacyAccount(w);
    const release = await w.store.acquireDeviceBinding(account.id, "phone-1");
    const skipped = await runOnce(w, account);
    expect(w.phone.dispatched).toEqual([]);
    expect(skipped).toMatchObject({
      status: "failed",
      preparation: { status: "failed", reasonCode: "device_busy" },
      chunks: [{ status: "skipped" }, { status: "skipped" }],
    });
    expect(skipped.error).toContain("等待超时，本次已跳过");

    release();
    expect((await runOnce(w, account)).status).toBe("completed");
  });

  it("waits for the lock instead of dispatching past it", async () => {
    const w = await world({ deviceWorkWaitMs: 60 * MINUTE });
    const account = await legacyAccount(w);
    const release = await w.store.acquireDeviceBinding(account.id, "phone-1");
    const runId = await startRun(w, account);
    await sleep(20);
    expect(w.phone.dispatched).toEqual([]);
    release();
    await w.service.waitForRun(runId);
    expect(w.phone.kinds()).toEqual(["gate", "search", "home"]);
    expect((await w.store.getRun(runId))?.status).toBe("completed");
  });

  it.each([
    [
      "a device hold",
      "手机上的任务停止未确认",
      async (w: World, account: XhsOpsAccount) => {
        await w.store.holdTakeoverDevice(account.id, {
          taskId: "other-task",
          sourceRef: "audit-elsewhere",
        });
      },
    ],
    [
      "a running audit",
      "只读盘点进行中",
      async (w: World, account: XhsOpsAccount) => {
        await w.store.createAudit({
          projectId: account.projectId,
          accountId: account.id,
          deviceId: "phone-1",
          platformAccountId: XHS_ID,
          trigger: "manual",
          status: "running",
          startedAt: new Date(w.clock.now).toISOString(),
        });
      },
    ],
    [
      "a change order on the phone",
      "有资料变更单正在执行或待核验",
      async (w: World, account: XhsOpsAccount) => {
        await w.store.createChangeOrder({
          projectId: account.projectId,
          accountId: account.id,
          deviceId: "phone-1",
          platformAccountId: XHS_ID,
          diagnosisId: null,
          proposalIds: [],
          batchIndex: 1,
          risk: "L1",
          fields: [{ field: "bio", baselineValue: "旧简介", after: "新简介" }],
          status: "applying",
        });
      },
    ],
    [
      "another flow's device lock",
      "手机正在执行只读盘点、资料变更或资料应用任务",
      async (w: World, account: XhsOpsAccount) => {
        await w.store.acquireDeviceBinding(account.id, "phone-1");
      },
    ],
  ])(
    "skips a chunk when %s took the phone after the gate",
    async (_label, message, takePhone) => {
      const w = await world();
      const account = await takeoverAccount(w);
      w.phone.onStart.set("gate", () => takePhone(w, account));
      const run = await runOnce(w, account);
      expect(w.phone.kinds()).toEqual(["gate"]);
      expect(run).toMatchObject({
        status: "failed",
        preparation: { status: "ready" },
        chunks: [{ status: "skipped" }, { status: "skipped" }],
      });
      expect(run.chunks[0]?.error).toContain(message);
      expect(run.chunks[0]?.error).toContain("等待超时，本次已跳过");
    },
  );
});

// ─── §2.6: the startup recovery ─────────────────────────────────────────────

describe("takeover startup recovery (§2.6)", () => {
  it("holds a takeover's dispatch until the recovery settled, not a row without one", async () => {
    const recovery: XhsOpsTakeoverRecoveryState = { settled: false };
    const w = await world({ recovery, deviceWorkWaitMs: 60 * MINUTE });
    const account = await takeoverAccount(w);
    const runId = await startRun(w, account);
    await sleep(20);
    expect(w.phone.dispatched).toEqual([]);
    recovery.settled = true;
    await w.service.waitForRun(runId);
    expect(w.phone.kinds()).toEqual(["gate", "search", "home"]);

    const other = await world({ recovery: { settled: false } });
    const legacy = await legacyAccount(other);
    expect((await runOnce(other, legacy)).status).toBe("completed");
  });

  it("skips a takeover's run that waited past the limit", async () => {
    const w = await world({ recovery: { settled: false } });
    const account = await takeoverAccount(w);
    const run = await runOnce(w, account);
    expect(w.phone.dispatched).toEqual([]);
    expect(run.preparation).toMatchObject({
      status: "failed",
      reasonCode: "device_busy",
    });
    expect(run.error).toContain("接管任务的恢复检查还没完成");
  });

  it("dispatches nothing from the scheduler for a takeover until then", async () => {
    const recovery: XhsOpsTakeoverRecoveryState = { settled: false };
    const w = await world({ recovery });
    const takeover = await takeoverAccount(w);
    const legacy = await legacyAccount(w, {
      label: "老号·二号机",
      deviceId: "phone-2",
    });
    const listed: string[] = [];
    const scheduler = new XhsOpsScheduler({
      store: w.store,
      runService: w.service,
      changeOrders: {
        listChangeOrders: async (accountId: string) => {
          listed.push(accountId);
          return w.store.listChangeOrders({ accountId });
        },
      },
      takeoverRecovery: recovery,
      now: () => w.clock.now,
    });
    const first = await scheduler.triggerProject(w.project.id, {
      reason: "schedule",
    });
    expect(first.skipped).toEqual([
      `${takeover.label}：控制器刚重启，接管任务的恢复检查还没完成，稍后自动重试`,
    ]);
    expect(await runsOf(w, takeover.id)).toEqual([]);
    const [legacyRun] = await runsOf(w, legacy.id);
    await w.service.waitForRun(must(legacyRun).id);
    expect(listed).toEqual([]);
    expect(
      (await w.store.getProject(w.project.id))?.schedule.lastTriggeredDate,
    ).toBeNull();

    recovery.settled = true;
    const second = await scheduler.triggerProject(w.project.id, {
      reason: "schedule",
    });
    expect(second.skipped).toEqual([]);
    expect(listed).toEqual([takeover.id]);
    const [takeoverRun] = await runsOf(w, takeover.id);
    await w.service.waitForRun(must(takeoverRun).id);
    expect((await w.store.getRun(must(takeoverRun).id))?.status).toBe(
      "completed",
    );
  });
});

// ─── §6.1: the scheduler and change orders ──────────────────────────────────

describe("scheduler and takeover change orders (§6.1)", () => {
  it("lists a takeover's change orders first, so a stale precheck no longer holds its nurture", async () => {
    const w = await world();
    const account = await takeoverAccount(w);
    const order = await w.store.createChangeOrder({
      projectId: account.projectId,
      accountId: account.id,
      deviceId: "phone-1",
      platformAccountId: XHS_ID,
      diagnosisId: null,
      proposalIds: [],
      batchIndex: 1,
      risk: "L1",
      fields: [{ field: "bio", baselineValue: "旧简介", after: "新简介" }],
      status: "awaiting_confirm",
      precheck: {
        taskId: "precheck-task",
        readAt: new Date(START - 2 * HOUR).toISOString(),
        accountMatched: true,
        drift: [],
        confirmDigest: "digest",
        expiresAt: new Date(START - HOUR).toISOString(),
      },
    });
    await w.store.mutateTakeover(account.id, ({ account: current }) => ({
      account: {
        ...current,
        takeover: {
          ...must(current.takeover),
          activeChangeOrderId: order.id,
        },
      },
      result: null,
    }));
    const unrefreshed = new XhsOpsScheduler({
      store: w.store,
      runService: w.service,
      now: () => w.clock.now,
    });
    const blocked = await unrefreshed.triggerProject(w.project.id, {
      reason: "manual",
    });
    expect(blocked.skipped[0]).toContain("有资料变更单正在执行或待核验");

    const unused = async (): Promise<never> => {
      throw new Error("not used by a listing");
    };
    const changeOrders = new XhsOpsChangeOrderService({
      store: w.store,
      deviceControl: w.phone.control,
      profile: { applyChangeOrder: unused, reconcile: unused },
      audits: { startAudit: unused, waitForAudit: unused },
      mediaRoot: join(w.directory, "media"),
      options: { now: () => w.clock.now },
    });
    const scheduler = new XhsOpsScheduler({
      store: w.store,
      runService: w.service,
      changeOrders,
      now: () => w.clock.now,
    });
    const result = await scheduler.triggerProject(w.project.id, {
      reason: "manual",
    });
    expect(result).toMatchObject({ created: 1, started: 1, skipped: [] });
    expect(await w.store.getChangeOrder(order.id)).toMatchObject({
      status: "draft",
    });
    const [run] = await runsOf(w, account.id);
    await w.service.waitForRun(must(run).id);
    expect((await w.store.getRun(must(run).id))?.status).toBe("completed");
  });
});

// ─── The schedule's bookkeeping through a long pause ────────────────────────

describe("scheduler bookkeeping while a takeover stays paused (§6.5)", () => {
  it("does not rewrite an unchanged scheduled outcome, so a card's expectedUpdatedAt stays valid", async () => {
    const w = await world();
    const paused = await takeoverAccount(w);
    const other = await legacyAccount(w, {
      label: "老号·二号机",
      deviceId: "phone-2",
    });
    await w.store.pauseTakeover(paused.id, {
      code: "rate_limited",
      reason: "运行中手机提示操作频繁",
      sourceRef: "run-x",
    });
    const scheduler = schedulerFor(w);
    const trigger = (reason: "schedule" | "manual" = "schedule") =>
      scheduler.triggerProject(w.project.id, { reason });
    expect(await trigger()).toMatchObject({ started: 1 });
    const [otherRun] = await runsOf(w, other.id);
    await w.service.waitForRun(must(otherRun).id);

    const waiting = [`${paused.label}：账号暂停中：运行中手机提示操作频繁`];
    w.clock.now += MINUTE;
    expect(await trigger()).toMatchObject({ started: 0, skipped: waiting });
    const written = must(await w.store.getProject(w.project.id));
    expect(written.schedule.lastTriggeredDate).toBeNull();
    expect(written.schedule.lastResult).toContain("10:01 定时");

    // Every later tick of the 48-hour cooldown finds the same: nothing is written.
    for (const minutes of [1, 2, 600]) {
      w.clock.now += minutes * MINUTE;
      expect((await trigger()).skipped).toEqual(waiting);
    }
    const quiet = must(await w.store.getProject(w.project.id));
    expect(quiet.updatedAt).toBe(written.updatedAt);
    expect(quiet.schedule).toEqual(written.schedule);
    // A card that loaded the project before those ticks still saves.
    const renamed = must(
      await w.store.updateProject(w.project.id, {
        name: "接管运行（改名）",
        expectedUpdatedAt: written.updatedAt,
      }),
    );
    // 「立即执行一次」 is always recorded.
    await trigger("manual");
    const manual = must(await w.store.getProject(w.project.id));
    expect(manual.updatedAt).not.toBe(renamed.updatedAt);
    expect(manual.schedule.lastResult).toContain("手动");

    // Once the outcome changes, the scheduled pass writes it again.
    await w.store.mutateTakeover(paused.id, ({ account }) => ({
      account: {
        ...account,
        takeover: { ...must(account.takeover), safetyPause: null },
      },
      result: null,
    }));
    w.clock.now += MINUTE;
    expect(await trigger()).toMatchObject({ started: 1, skipped: [] });
    const after = must(await w.store.getProject(w.project.id));
    expect(after.updatedAt).not.toBe(manual.updatedAt);
    expect(after.schedule.lastTriggeredDate).toBe("2026-10-21");
    const [pausedRun] = await runsOf(w, paused.id);
    await w.service.waitForRun(must(pausedRun).id);
    expect((await w.store.getRun(must(pausedRun).id))?.status).toBe(
      "completed",
    );
  });
});

// ─── #5: a confirmed plan and its daily segments ────────────────────────────

/** Fully taken over: identity locked, baseline confirmed, a small two-segment plan confirmed. */
async function plannedTakeover(w: World, overrides: AccountInput = {}) {
  const created = await w.store.createAccount({
    projectId: w.project.id,
    entryMode: "existing",
    label: "接管·一号机",
    deviceId: "phone-1",
    deviceName: "一号机",
    ...overrides,
  });
  const authorized = await w.store.authorizeTakeover(created.id, {
    expectedUpdatedAt: created.updatedAt,
    ownershipConfirmed: true,
  });
  w.clock.now += MINUTE;
  await w.store.recordTakeoverIdentityRead(authorized.id, {
    taskId: "identity-task",
    deviceId: must(authorized.deviceId),
    screenshotUrl: "/api/v1/media/screenshots/identity.png",
    readAccountId: XHS_ID,
  });
  w.clock.now += MINUTE;
  const locked = await w.store.confirmTakeoverIdentity(authorized.id, {
    identityTaskId: "identity-task",
    platformAccountId: XHS_ID,
  });
  const audit = await w.store.createAudit({
    projectId: locked.projectId,
    accountId: locked.id,
    deviceId: must(locked.deviceId),
    platformAccountId: XHS_ID,
    trigger: "takeover",
    status: "completed",
    startedAt: new Date(w.clock.now).toISOString(),
    profile: {
      status: "read",
      code: "ok",
      evidence: null,
      accountMatched: true,
      values: {
        nickname: "通勤小林",
        bio: "上海通勤",
        occupation: "设计师",
        gender: "女",
        birthdayFilled: true,
        region: "中国 上海 上海",
      },
    },
  });
  await w.store.mutateTakeover(locked.id, ({ account }) => ({
    account: {
      ...account,
      takeover: {
        ...must(account.takeover),
        baselineAuditId: audit.id,
        latestAuditId: audit.id,
      },
    },
    result: null,
  }));
  const diagnosis = await w.store.createDiagnosis(
    {
      projectId: locked.projectId,
      accountId: locked.id,
      auditId: audit.id,
      version: 1,
      status: "ready",
      playbookVersion: "2026-10-21.1",
      facts: { tier: "established" },
      cadence: {
        browseDefaults: {
          ...SMALL_BROWSE,
          dailyTargetPosts: 4,
          dailySegments: 2,
        },
        interaction: QUIET_INTERACTION,
        rationale: ["测试用小计划"],
      },
      proposals: [
        {
          id: "P1",
          kind: "interestPool",
          core: ["通勤护肤", "敏感肌护理", "护肤成分"],
          extended: ["通勤穿搭"],
          general: ["咖啡"],
          rationale: "旧主线留在扩展层过渡",
          ruleIds: ["NU-08"],
          risk: "L0",
          batch: 0,
        },
        {
          id: "P2",
          kind: "toneGuide",
          guide: { summary: "真实通勤体验", commentStyle: "像朋友一样聊" },
          rationale: "保留口语化",
          ruleIds: ["TN-08"],
          risk: "L0",
          batch: 0,
        },
      ],
      decisions: {
        P1: {
          decision: "adopt",
          decidedAt: new Date(w.clock.now).toISOString(),
        },
        P2: {
          decision: "adopt",
          decidedAt: new Date(w.clock.now).toISOString(),
        },
      },
      generator: { botId: "bot-1", model: null },
    },
    { activate: true },
  );
  return { account: locked, diagnosis };
}

describe("a confirmed takeover plan in the daily schedule (#5)", () => {
  it("no longer 409s once the plan is confirmed, and one account's 409 spares the others", async () => {
    const w = await world();
    const { account, diagnosis } = await plannedTakeover(w);
    const other = await legacyAccount(w, {
      label: "老号·二号机",
      deviceId: "phone-2",
    });
    const skips: XhsOpsPlanSkip[] = [];
    const before = await w.service.suggestPlans(w.project.id, {
      onSkipped: (skip) => skips.push(skip),
    });
    expect(before.map((plan) => plan.accountId)).toEqual([other.id]);
    expect(skips).toEqual([
      {
        accountId: account.id,
        accountLabel: account.label,
        reason:
          "本段搜索目标 36 篇至少需要 5 个兴趣词，当前只有 0 个，请补充兴趣池或增加每日分段",
      },
    ]);

    await w.store.confirmTakeoverPlan(diagnosis.id, {
      expectedUpdatedAt: diagnosis.updatedAt,
      keepAllPublic: true,
    });
    skips.length = 0;
    const after = await w.service.suggestPlans(w.project.id, {
      onSkipped: (skip) => skips.push(skip),
    });
    expect(skips).toEqual([]);
    expect(
      after
        .filter((plan) => plan.accountId === account.id)
        .map((plan) => plan.segment),
    ).toEqual([
      { index: 1, count: 2 },
      { index: 2, count: 2 },
    ]);
  });

  it("runs both segments of a taken-over account one after the other", async () => {
    const w = await world();
    const { account, diagnosis } = await plannedTakeover(w);
    await w.store.confirmTakeoverPlan(diagnosis.id, {
      expectedUpdatedAt: diagnosis.updatedAt,
      keepAllPublic: true,
    });
    const result = await schedulerFor(w).triggerProject(w.project.id, {
      reason: "schedule",
    });
    expect(result).toMatchObject({
      planned: 2,
      created: 2,
      started: 1,
      queued: 1,
      skipped: [],
    });
    const runs = [...(await runsOf(w, account.id))].sort(
      (left, right) => (left.segment?.index ?? 0) - (right.segment?.index ?? 0),
    );
    await w.service.waitForRun(must(runs[0]).id);
    await w.service.waitForRun(must(runs[1]).id);

    expect(w.phone.kinds()).toEqual([
      "gate",
      "search",
      "home",
      "gate",
      "search",
      "home",
    ]);
    expect(w.phone.maxRunning).toBe(1);
    for (const run of runs)
      expect((await w.store.getRun(run.id))?.status).toBe("completed");
    for (const body of w.phone.bodies()) expectExistingAccountPolicy(body);
  });

  it("nurtures on the observation days after a change: only the day in noNurtureDates is off (MT-03)", async () => {
    const w = await world();
    const { account, diagnosis } = await plannedTakeover(w);
    await w.store.confirmTakeoverPlan(diagnosis.id, {
      expectedUpdatedAt: diagnosis.updatedAt,
      keepAllPublic: true,
    });
    // An L1 order applied today and now observing for 72 hours.
    const appliedAt = new Date(w.clock.now).toISOString();
    const until = new Date(w.clock.now + 72 * HOUR).toISOString();
    const order = await w.store.createChangeOrder({
      projectId: account.projectId,
      accountId: account.id,
      deviceId: "phone-1",
      platformAccountId: XHS_ID,
      diagnosisId: diagnosis.id,
      proposalIds: [],
      batchIndex: 1,
      risk: "L1",
      fields: [
        {
          field: "bio",
          baselineValue: "上海通勤",
          before: "上海通勤",
          after: "上海通勤护肤",
          outcome: "verified",
        },
      ],
      status: "observing",
      confirmedAt: appliedAt,
      applyTaskId: "apply-task",
      observation: {
        until,
        auditId: null,
        baseAuditId: null,
        verdict: "pending",
        notes: [],
      },
    });
    const changeDay = localDateString(new Date(w.clock.now));
    await w.store.mutateTakeover(account.id, ({ account: current }) => ({
      account: {
        ...current,
        takeover: {
          ...must(current.takeover),
          observationUntil: until,
          noNurtureDates: [changeDay],
        },
      },
      result: null,
    }));
    const scheduler = schedulerFor(w);

    const sameDay = await scheduler.triggerProject(w.project.id, {
      reason: "schedule",
    });
    expect(sameDay).toMatchObject({ created: 0, started: 0 });
    expect(sameDay.skipped).toEqual([
      `${account.label}：今天改过公开资料，按规则当天不养号`,
    ]);
    expect(w.phone.kinds()).toEqual([]);

    for (const day of [1, 2]) {
      w.clock.now += DAY;
      const current = must(await w.store.getAccount(account.id));
      expect(xhsOpsTakeoverStage(current, w.clock.now), `day ${day}`).toBe(
        "observing",
      );
      expect(current.takeover?.noNurtureDates).toEqual([changeDay]);
      const result = await scheduler.triggerProject(w.project.id, {
        reason: "schedule",
      });
      expect(result, `day ${day}`).toMatchObject({
        created: 2,
        started: 1,
        queued: 1,
        skipped: [],
      });
      const today = localDateString(new Date(w.clock.now));
      // Segment 2 waits in the device queue behind segment 1.
      const runs = (await runsOf(w, account.id))
        .filter((run) => run.date === today)
        .sort(
          (left, right) =>
            (left.segment?.index ?? 0) - (right.segment?.index ?? 0),
        );
      for (const run of runs) await w.service.waitForRun(run.id);
      for (const run of runs)
        expect((await w.store.getRun(run.id))?.status, `day ${day}`).toBe(
          "completed",
        );
    }
    expect(w.phone.kinds()).toEqual(
      Array.from({ length: 4 }, () => ["gate", "search", "home"]).flat(),
    );
    expect((await w.store.getChangeOrder(order.id))?.status).toBe("observing");
  });

  it("keeps nurturing after the interest pool is adjusted (N1)", async () => {
    const w = await world();
    const { account, diagnosis } = await plannedTakeover(w);
    await w.store.confirmTakeoverPlan(diagnosis.id, {
      expectedUpdatedAt: diagnosis.updatedAt,
      keepAllPublic: true,
    });
    const tuned = must(
      await w.store.updateAccount(account.id, {
        interestPool: {
          core: ["通勤护肤", "油皮护理", "防晒"],
          extended: ["通勤穿搭"],
          general: ["咖啡"],
        },
      }),
    );
    expect(tuned.takeover?.planConfirmedAt).not.toBeNull();
    expect(xhsOpsAccountNurtureIssues(tuned, w.project)).toEqual([]);
    const run = await runOnce(w, tuned);
    expect(run.status).toBe("completed");
    expect(w.phone.kinds()).toEqual(["gate", "search", "home"]);
  });
});

// ─── New accounts are untouched ─────────────────────────────────────────────

/** A new account the old flow prepared, applied and verified: it nurtures through the login preparation. */
async function newAccount(w: World): Promise<XhsOpsAccount> {
  const image = join(w.directory, "image.png");
  writeFileSync(image, "fixture");
  const created = await w.store.createAccount({
    projectId: w.project.id,
    label: "新号",
    positioning: "记录通勤护肤",
    persona: {
      age: "28岁",
      gender: "女",
      region: "上海",
      occupation: "设计师",
      lifeStatus: "通勤上班",
    },
    personaTags: { vertical: ["护肤"], general: ["咖啡", "通勤"] },
    interestPool: {
      core: ["通勤护肤"],
      extended: ["通勤穿搭"],
      general: ["咖啡"],
    },
    browseDefaults: SMALL_BROWSE,
    interaction: QUIET_INTERACTION,
    platformAccountId: "49268961587",
    deviceId: "phone-1",
    profileDraft: {
      nickname: "通勤小林",
      bio: "上海通勤 | 护肤记录",
      gender: "女",
      birthday: "1997-01-01",
      region: "上海",
      interestTags: ["护肤", "咖啡"],
      avatarCandidates: [image],
      coverCandidates: [image],
      avatarPath: image,
      coverPath: image,
    },
  });
  const project = must(await w.store.getProject(w.project.id));
  await w.store.confirmPersonas(project.id, {
    accounts: [{ accountId: created.id, expectedUpdatedAt: created.updatedAt }],
    expectedUpdatedAt: project.updatedAt,
    distributionReviewed: true,
    reviewNote: "已核对",
  });
  const confirmed = must(await w.store.confirmProfileDraft(created.id));
  const at = new Date(START - HOUR).toISOString();
  return must(
    await w.store.updateAccount(
      confirmed.id,
      {},
      {
        profileApplyResult: {
          expectedProfileDraft: confirmed.profileDraft,
          expectedPlatformAccountId: confirmed.platformAccountId,
          appliedAt: at,
          applyStatus: "applied",
          applyResult: "verified",
          verifiedAt: at,
          verifiedAccountId: confirmed.platformAccountId,
          verificationTaskId: "verification",
        },
      },
    ),
  );
}

describe("new-account runs", () => {
  it("still prepare with the login task and browse on XHS_TASK_POLICY, policy mode or not", async () => {
    const w = await world();
    const account = await newAccount(w);
    // The guard is for existing accounts only.
    w.phone.policyMode = "audit";
    const run = await runOnce(w, account);
    expect(run.status).toBe("completed");
    expect(w.phone.kinds()).toEqual(["preparation", "search", "home"]);
    const [preparation, ...chunks] = w.phone.bodies();
    expect(preparation).toEqual(
      buildPreparationRequest(XHS_PACKAGE, "49268961587"),
    );
    // The digests the takeover work pinned before it changed anything.
    expect(sha256(preparation)).toBe(
      "858acb9d5beef6d91dbb18a42e7b853e507cb5c254e61732f3d6fcea4d96314f",
    );
    for (const chunk of chunks) {
      expect(chunk.taskPolicy).toBe(XHS_TASK_POLICY);
      expect(sha256(chunk.taskPolicy)).toBe(
        "2c9ed445ef767f6faf9deb52cea0aa89e6e3bbd938b8df29401206d1efa84711",
      );
    }
    expect(w.phone.cancelled).toEqual([]);
  });

  it("records device_busy when the receipt re-check finds the phone taken (A10)", async () => {
    const w = await world();
    const account = await newAccount(w);
    // The login task ends without its receipt, so a re-check follows; by
    // then other work holds the device and the wait gives up at once.
    w.phone.messages.set("preparation", "已完成登录检查");
    const held: { release?: () => void } = {};
    w.phone.onStart.set("preparation", async () => {
      held.release ??= await w.store.acquireDeviceBinding(
        account.id,
        "phone-1",
      );
    });
    const run = await runOnce(w, account);
    held.release?.();
    expect(w.phone.kinds()).toEqual(["preparation"]);
    expect(run.preparation).toMatchObject({
      status: "failed",
      reasonCode: "device_busy",
      reason:
        "手机正在执行只读盘点、资料变更或资料应用任务；等待超时，本次已跳过",
    });
    expect(run.status).toBe("failed");
  });
});

// ─── What the takeover card reads off the device ────────────────────────────

describe("device status of a takeover phone (§5.2 前提, §3.5)", () => {
  it("passes the reported policy mode and skill bundle through the device routes", async () => {
    // tabby-control keeps these on its DeviceInfo: the mode from each task's
    // TASK_START, the bundle from the phone's skill.hello / ack.
    const reported = {
      deviceId: "phone-1",
      status: "idle",
      connectedAt: 1,
      lastSeen: 2,
      devicePolicyMode: "enforce",
      skillBundleVersion: 66,
      skillSyncStatus: "current",
      skillDigest: "sha256-of-the-bundle",
    } as const;
    const device = deviceInfoSchema.parse(reported);
    expect(device).toMatchObject({
      devicePolicyMode: "enforce",
      skillBundleVersion: 66,
      skillSyncStatus: "current",
    });
    const app = new OpenAPIHono<ControllerBindings>();
    registerDeviceControlRoutes(app, {
      deviceControlService: {
        isAvailable: async () => true,
        listDevices: async () => ({ devices: [reported] }),
        getDevice: async () => reported,
      },
      deviceNameStore: { get: () => undefined },
    } as unknown as ControllerContainer);
    const one = (await (
      await app.request("/api/v1/devices/phone-1")
    ).json()) as Record<string, unknown>;
    expect(one).toMatchObject({
      devicePolicyMode: "enforce",
      skillBundleVersion: 66,
      skillSyncStatus: "current",
    });
    const list = (await (await app.request("/api/v1/devices")).json()) as {
      devices: Array<Record<string, unknown>>;
    };
    expect(list.devices[0]).toMatchObject({
      devicePolicyMode: "enforce",
      skillBundleVersion: 66,
      skillSyncStatus: "current",
    });
  });
});
