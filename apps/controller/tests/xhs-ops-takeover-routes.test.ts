import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  type DeviceExecuteTaskBody,
  type DeviceInfo,
  PHONE_SKILLS_BUNDLE,
  type TaskResult,
  XHS_OPS_PLAYBOOK,
  XHS_OPS_PLAYBOOK_VERSION,
  XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE,
  XHS_TAKEOVER_IMAGE_PHONE_UNREACHABLE_MESSAGE,
  XHS_TAKEOVER_PROFILE_DRAFT_LOCKED_MESSAGE,
  type XhsOpsAccount,
  type XhsOpsAccountAudit,
  type XhsOpsAccountDiagnosis,
  type XhsOpsChangeOrder,
  xhsOpsAccountConflictResponseSchema,
  xhsOpsAccountDiagnosedEvent,
  xhsOpsAccountResponseSchema,
  xhsOpsAuditBaselineResponseSchema,
  xhsOpsAuditListResponseSchema,
  xhsOpsAuditResponseSchema,
  xhsOpsChangeOrderActionResponseSchema,
  xhsOpsChangeOrderListResponseSchema,
  xhsOpsChangeOrderResponseSchema,
  xhsOpsDiagnosisResponseSchema,
  xhsOpsDiagnosisViewResponseSchema,
  xhsOpsParseCount,
  xhsOpsPlaybookResponseSchema,
  xhsOpsTakeoverIdentityConfirmResponseSchema,
  xhsOpsTakeoverIdentityReadResponseSchema,
  xhsOpsTakeoverPlanConfirmedEvent,
  xhsOpsTakeoverPlanResponseSchema,
  xhsOpsTakeoverPlanRevertResponseSchema,
  xhsOpsTakeoverResumeResponseSchema,
} from "@nexu/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControllerContainer } from "../src/app/container.js";
import { XhsOpsError } from "../src/lib/xhs-ops-common.js";
import { registerXhsOpsRoutes } from "../src/routes/xhs-ops-routes.js";
import {
  type XhsOpsAuditDeviceControl,
  XhsOpsAuditService,
} from "../src/services/xhs-ops-audit-service.js";
import { XhsOpsChangeOrderService } from "../src/services/xhs-ops-change-order-service.js";
import { XhsOpsDiagnosisService } from "../src/services/xhs-ops-diagnosis-service.js";
import {
  type XhsOpsProfileDeviceControl,
  XhsOpsProfileService,
} from "../src/services/xhs-ops-profile-service.js";
import {
  XHS_AUDIT_TASK_POLICY,
  XHS_OPS_DEFAULT_OFFLINE_AFTER_MS,
} from "../src/services/xhs-ops-run-service.js";
import { recoverXhsOpsTakeoverWork } from "../src/services/xhs-ops-takeover-recovery.js";
import { XHS_IDENTITY_MARKER } from "../src/services/xhs-ops-task-builder.js";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";
import type { ControllerBindings } from "../src/types.js";

// Route-level coverage of the takeover HTTP surface (takeover design §9 P0
// 路由): each route reaches its service method with the parsed body, answers
// with the shared response envelope (events included), and the guards the
// routes own — profile-draft 409s, imageFieldsSupported, the resume gate —
// behave as §2.5, §5.2 and §6.5 say. The services' own flows are covered by
// their test files.

const START = Date.parse("2026-10-21T02:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const XHS_ID = "xhs-owner-001";
const DEVICE = "phone-1";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ACTION_RECEIPT = "[回执] 各应用生效点击: com.xingin.xhs=2";
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

function gateReceipt(status: string, code: string): string {
  return `PREPARATION_JSON:${JSON.stringify({
    v: 1,
    status,
    code,
    profileVerified: status === "ready",
  })}\n${ACTION_RECEIPT}`;
}

/** A phone that answers each dispatched task with the next scripted result. */
class FakePhone {
  online = true;
  status: DeviceInfo["status"] = "idle";
  currentTaskId: string | undefined;
  osVersion: string | number | undefined = "Android 13";
  policyMode: DeviceInfo["devicePolicyMode"] = "enforce";
  getDeviceThrows = false;
  /**
   * When the phone last reported. null: just now, by both clocks in play —
   * the routes read Date.now(), the services the harness clock.
   */
  lastSeenAt: number | null = null;
  confirmCancel = true;
  readonly dispatched: DeviceExecuteTaskBody[] = [];
  readonly cancelled: string[] = [];
  private readonly scripted: Array<Partial<TaskResult>> = [];
  private seq = 0;

  constructor(private readonly now: () => number) {}

  next(result: Partial<TaskResult>): void {
    this.scripted.push(result);
  }

  readonly control: XhsOpsAuditDeviceControl & XhsOpsProfileDeviceControl = {
    getDevice: async (deviceId) => {
      if (this.getDeviceThrows)
        throw new Error("Device control RPC failed: 503");
      if (!this.online) return null;
      return {
        deviceId,
        status: this.status,
        ...(this.currentTaskId ? { currentTaskId: this.currentTaskId } : {}),
        connectedAt: 1,
        lastSeen: this.lastSeenAt ?? Math.max(this.now(), Date.now()),
        ...(this.osVersion === undefined ? {} : { osVersion: this.osVersion }),
        ...(this.policyMode === undefined
          ? {}
          : { devicePolicyMode: this.policyMode }),
      };
    },
    executeTask: async (_deviceId, body) => {
      this.dispatched.push(body);
      const taskId = `task-${++this.seq}`;
      const scripted = this.scripted.shift() ?? {};
      if (scripted.needsInteraction) {
        // CALL_USER: the call returns while the phone keeps waiting.
        this.status = "busy";
        this.currentTaskId = taskId;
        return {
          result: {
            taskId,
            success: false,
            message: "需要人工处理",
            ...scripted,
          },
        };
      }
      return {
        result: {
          taskId,
          success: true,
          status: "completed",
          finalScreenshot: `/tmp/shots/${taskId}.png`,
          ...scripted,
        },
      };
    },
    cancelTask: async (_deviceId, { taskId }) => {
      this.cancelled.push(taskId);
      if (!this.confirmCancel) return { cancelled: false };
      if (this.currentTaskId === taskId) {
        this.status = "idle";
        this.currentTaskId = undefined;
      }
      return { cancelled: true };
    },
    getTaskResults: async () => [],
    pushMedia: async () => ({ results: [] }),
  };
}

const NO_MEDIA = {
  generateImage: vi.fn(async () => ({ path: "", items: [] })),
  generateText: vi.fn(async () => ({
    text: '{"nickname":"新号昵称","bio":"新号简介"}',
  })),
};

function harness(overrides: Partial<ControllerContainer> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "xhs-takeover-routes-"));
  directories.push(directory);
  const clock = { now: START };
  let id = 0;
  const store = new XhsOpsStore(join(directory, "state.json"), {
    now: () => new Date(clock.now).toISOString(),
    genId: () => `id-${++id}`,
  });
  const mediaRoot = join(directory, "media");
  const phone = new FakePhone(() => clock.now);
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
    takeoverIdentity: audits,
    now: () => clock.now,
  });
  const app = new OpenAPIHono<ControllerBindings>();
  registerXhsOpsRoutes(app, {
    xhsOpsStore: store,
    xhsOpsAuditService: audits,
    xhsOpsProfileService: profile,
    deviceControlService: phone.control,
    ...overrides,
  } as ControllerContainer);
  const request = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> => {
    const response = await app.request(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    store,
    phone,
    audits,
    profile,
    clock,
    mediaRoot,
    request,
    advance: (ms: number) => {
      clock.now += ms;
    },
  };
}
type Harness = ReturnType<typeof harness>;

function messageOf(body: unknown): string {
  if (body && typeof body === "object" && "message" in body)
    return String(body.message);
  return "";
}

async function project(h: Harness) {
  const created = await h.store.createProject({
    name: "接管项目",
    business: { industry: "美妆", product: "护肤品" },
    audience: {
      ageRange: "25–32",
      genderRatio: "女80%男20%",
      regions: ["上海"],
    },
  });
  return h.store.confirmProfile(created.id, {
    profile: {
      summary: "上海职场女性",
      base: { ageRange: "25–32", genderRatio: "女80%男20%", regions: ["上海"] },
      verticalInterests: ["护肤"],
      generalInterests: ["咖啡", "通勤"],
    },
    expectedUpdatedAt: created.updatedAt,
  });
}

/** An existing row on DEVICE; authorized and identity-locked on request. */
async function existingAccount(
  h: Harness,
  options: { authorize?: boolean; lock?: boolean } = {},
): Promise<XhsOpsAccount> {
  const owner = await project(h);
  const account = await h.store.createAccount({
    projectId: owner.id,
    entryMode: "existing",
    label: "接管·测试机",
    deviceId: DEVICE,
    deviceName: "测试机",
  });
  if (!options.authorize && !options.lock) return account;
  const authorized = await h.store.authorizeTakeover(account.id, {
    expectedUpdatedAt: account.updatedAt,
    ownershipConfirmed: true,
  });
  if (!options.lock) return authorized;
  h.advance(MINUTE);
  await h.store.recordTakeoverIdentityRead(authorized.id, {
    taskId: "identity-task",
    deviceId: DEVICE,
    screenshotUrl: null,
    readAccountId: XHS_ID,
  });
  h.advance(MINUTE);
  return h.store.confirmTakeoverIdentity(authorized.id, {
    identityTaskId: "identity-task",
    platformAccountId: XHS_ID,
  });
}

async function completedAudit(
  h: Harness,
  account: XhsOpsAccount,
): Promise<XhsOpsAccountAudit> {
  const now = new Date(h.clock.now).toISOString();
  return h.store.createAudit({
    projectId: account.projectId,
    accountId: account.id,
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
}

async function readyDiagnosis(
  h: Harness,
  account: XhsOpsAccount,
  auditId: string,
): Promise<XhsOpsAccountDiagnosis> {
  return h.store.createDiagnosis({
    projectId: account.projectId,
    accountId: account.id,
    auditId,
    version: 1,
    status: "ready",
    playbookVersion: XHS_OPS_PLAYBOOK_VERSION,
    facts: { tier: "growing" },
    cadence: { browseDefaults: {}, interaction: {}, rationale: [] },
    summary: "通勤穿搭为主的成长期账号",
    generator: { botId: "bot-1", model: null },
  });
}

async function draftOrder(
  h: Harness,
  account: XhsOpsAccount,
  fields: Array<{
    field: "bio" | "occupation" | "avatar" | "cover";
    after: string;
  }>,
  status: XhsOpsChangeOrder["status"] = "draft",
): Promise<XhsOpsChangeOrder> {
  return h.store.createChangeOrder({
    projectId: account.projectId,
    accountId: account.id,
    deviceId: DEVICE,
    platformAccountId: XHS_ID,
    diagnosisId: null,
    proposalIds: [],
    batchIndex: fields.some((entry) => entry.field === "avatar") ? 3 : 1,
    risk: fields.some((entry) => entry.field === "avatar") ? "L2" : "L1",
    fields: fields.map((entry) => ({
      field: entry.field,
      baselineValue: "",
      after: entry.after,
    })),
    status,
  });
}

// ─── Takeover account routes ────────────────────────────────────────────────

describe("takeover account routes", () => {
  it("authorizes, reads and locks the identity, pauses and releases a device hold", async () => {
    const h = harness();
    const account = await existingAccount(h);
    const base = `/api/v1/xhs-ops/accounts/${account.id}/takeover`;

    const unticked = await h.request("POST", `${base}/authorize`, {
      expectedUpdatedAt: account.updatedAt,
    });
    expect(unticked.status).toBe(400);
    const authorized = await h.request("POST", `${base}/authorize`, {
      expectedUpdatedAt: account.updatedAt,
      ownershipConfirmed: true,
      authorizationNote: "客户书面授权",
    });
    expect(authorized.status).toBe(200);
    const afterAuthorize = xhsOpsAccountResponseSchema.parse(
      authorized.body,
    ).account;
    expect(afterAuthorize.takeover?.authorizedAt).not.toBeNull();
    expect(afterAuthorize.takeover?.authorizationNote).toBe("客户书面授权");
    const again = await h.request("POST", `${base}/authorize`, {
      expectedUpdatedAt: afterAuthorize.updatedAt,
      ownershipConfirmed: true,
    });
    expect(again.status).toBe(409);
    expect(messageOf(again.body)).toContain("已授权接管");

    h.advance(MINUTE);
    h.phone.next({
      message: `已停在编辑主页\n${XHS_IDENTITY_MARKER}${JSON.stringify({
        v: 1,
        status: "visible",
        accountId: XHS_ID,
      })}`,
    });
    const read = await h.request("POST", `${base}/identity/read`);
    expect(read.status).toBe(200);
    const identity = xhsOpsTakeoverIdentityReadResponseSchema.parse(read.body);
    expect(identity.identity).toMatchObject({
      status: "visible",
      accountId: XHS_ID,
    });
    expect(identity.account.takeover?.pendingIdentity?.taskId).toBe(
      identity.identity.taskId,
    );
    // The read-only takeover variant, never XHS_TASK_POLICY.
    expect(h.phone.dispatched.at(-1)?.taskPolicy).toEqual(
      XHS_AUDIT_TASK_POLICY,
    );

    const blank = await h.request("POST", `${base}/identity/confirm`, {
      identityTaskId: identity.identity.taskId,
      platformAccountId: "",
    });
    expect(blank.status).toBe(400);
    const confirmed = await h.request("POST", `${base}/identity/confirm`, {
      identityTaskId: identity.identity.taskId,
      platformAccountId: XHS_ID,
    });
    expect(confirmed.status).toBe(200);
    const locked = xhsOpsTakeoverIdentityConfirmResponseSchema.parse(
      confirmed.body,
    );
    expect(locked.account.takeover?.identityConfirmedAt).not.toBeNull();
    expect(locked.event.name).toBe("xhs_ops_takeover_identity_locked");
    expect(JSON.stringify(locked.event)).not.toContain(XHS_ID);

    expect(
      (await h.request("POST", `${base}/pause`, { reason: "" })).status,
    ).toBe(400);
    const paused = await h.request("POST", `${base}/pause`, {
      reason: "客户要求先停一下",
    });
    expect(paused.status).toBe(200);
    expect(
      xhsOpsAccountResponseSchema.parse(paused.body).account.takeover
        ?.safetyPause,
    ).toMatchObject({ code: "manual", reason: "客户要求先停一下" });

    const current = must(await h.store.getAccount(account.id));
    expect(
      (
        await h.request("POST", `${base}/device-hold/release`, {
          expectedUpdatedAt: current.updatedAt,
        })
      ).status,
    ).toBe(400);
    const nothingHeld = await h.request("POST", `${base}/device-hold/release`, {
      expectedUpdatedAt: current.updatedAt,
      stoppedOnPhone: true,
    });
    expect(nothingHeld.status).toBe(409);
    const held = await h.store.holdTakeoverDevice(account.id, {
      taskId: "task-x",
      sourceRef: "audit-1",
    });
    const released = await h.request("POST", `${base}/device-hold/release`, {
      expectedUpdatedAt: held.updatedAt,
      stoppedOnPhone: true,
    });
    expect(released.status).toBe(200);
    expect(
      xhsOpsAccountResponseSchema.parse(released.body).account.takeover
        ?.deviceHold,
    ).toBeNull();

    const missing = await h.request(
      "POST",
      "/api/v1/xhs-ops/accounts/nope/takeover/pause",
      { reason: "x" },
    );
    expect(missing.status).toBe(404);
  });

  it("serves the playbook the diagnoses cite", async () => {
    const h = harness();
    const response = await h.request("GET", "/api/v1/xhs-ops/playbook");
    expect(response.status).toBe(200);
    const playbook = xhsOpsPlaybookResponseSchema.parse(response.body);
    expect(playbook.version).toBe(XHS_OPS_PLAYBOOK_VERSION);
    // The bundle the doc excerpts were checked against, for the card's device check (§4.5).
    expect(playbook.bundleVersion).toBe(PHONE_SKILLS_BUNDLE);
    expect(playbook.rules.map((rule) => rule.id)).toEqual(
      XHS_OPS_PLAYBOOK.map((rule) => rule.id),
    );
  });

  it("answers a takeover's over-tier PATCH with a 409 carrying code and issues (§2.5, §6.3)", async () => {
    const h = harness();
    const account = await existingAccount(h, { authorize: true });
    const route = `/api/v1/xhs-ops/accounts/${account.id}`;
    const follow = {
      ...account.interaction,
      follow: { enabled: true, dailyCap: 2, ratioPercent: 2 },
    };

    const refused = await h.request("PATCH", route, { interaction: follow });
    expect(refused.status).toBe(409);
    expect(xhsOpsAccountConflictResponseSchema.parse(refused.body)).toEqual({
      message:
        "开启关注超出新号默认值（默认关闭：关注列表公开，老粉看得到）。超出接管档位的调整需要填写理由",
      code: "takeover_override_reason_required",
      issues: [
        {
          field: "interaction.follow.enabled",
          message:
            "开启关注超出新号默认值（默认关闭：关注列表公开，老粉看得到）",
          overridable: true,
        },
      ],
    });

    const hard = await h.request("PATCH", route, {
      browseDefaults: { ...account.browseDefaults, dwellSecMin: 8 },
      overrideReason: "想快一点",
    });
    expect(hard.status).toBe(409);
    expect(xhsOpsAccountConflictResponseSchema.parse(hard.body)).toEqual({
      message: "单篇最短停留必须至少 11 秒",
      code: "takeover_param_hard_limit",
      issues: [
        {
          field: "browseDefaults.dwellSecMin",
          message: "单篇最短停留必须至少 11 秒",
          overridable: false,
        },
      ],
    });

    const accepted = await h.request("PATCH", route, {
      interaction: follow,
      overrideReason: "客户要求回关老粉",
    });
    expect(accepted.status).toBe(200);
    expect(
      xhsOpsAccountResponseSchema.parse(accepted.body).account.takeover
        ?.paramOverrides,
    ).toMatchObject([
      { reason: "客户要求回关老粉", fields: ["interaction.follow.enabled"] },
    ]);

    // Every other 409 of the PATCH stays a bare message.
    const locked = await h.request("PATCH", route, { entryMode: "new" });
    expect(locked.status).toBe(409);
    expect(locked.body).toEqual({
      message: XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE,
    });
  });

  it("reverts a confirmed plan through the store", async () => {
    const h = harness();
    const account = await existingAccount(h, { lock: true });
    const route = `/api/v1/xhs-ops/accounts/${account.id}/takeover/plan/revert`;
    const noPlan = await h.request("POST", route, {
      expectedUpdatedAt: account.updatedAt,
    });
    expect(noPlan.status).toBe(409);
    const { account: planned } = await h.store.mutateTakeover(
      account.id,
      ({ account: current }) => ({
        account: {
          ...current,
          label: "方案后的定位",
          takeover: {
            ...must(current.takeover),
            planConfirmedAt: new Date(h.clock.now).toISOString(),
            prePlanSnapshot: {
              label: current.label,
              positioning: current.positioning,
              persona: current.persona,
              personaTags: current.personaTags,
              interestPool: current.interestPool,
              interaction: current.interaction,
              browseDefaults: current.browseDefaults,
              toneGuide: current.toneGuide,
            },
          },
        },
        result: null,
      }),
    );
    expect(
      (await h.request("POST", route, { expectedUpdatedAt: "stale" })).status,
    ).toBe(409);
    const reverted = await h.request("POST", route, {
      expectedUpdatedAt: planned.updatedAt,
    });
    expect(reverted.status).toBe(200);
    const result = xhsOpsTakeoverPlanRevertResponseSchema.parse(reverted.body);
    expect(result.account.label).toBe("接管·测试机");
    expect(result.account.takeover?.planConfirmedAt).toBeNull();
    expect(result.diagnosis).toBeNull();
    expect(result.changeOrders).toEqual([]);
  });
});

// ─── Audits ─────────────────────────────────────────────────────────────────

describe("takeover audit routes", () => {
  it("map start, list, get, cancel and baseline to the audit service", async () => {
    const seed = harness();
    const account = await existingAccount(seed, { lock: true });
    const audit = await completedAudit(seed, account);
    const event = {
      name: "xhs_ops_account_audited" as const,
      payload: { auditId: audit.id, baseline: true },
    };
    const fake = {
      startAudit: vi.fn(async () => audit),
      listAudits: vi.fn(async () => [audit]),
      getAudit: vi.fn(async (auditId: string) => {
        if (auditId !== audit.id) throw new XhsOpsError(404, "盘点记录不存在");
        return audit;
      }),
      cancelAudit: vi.fn(async () => {
        throw new XhsOpsError(409, "盘点已结束，无需取消");
      }),
      confirmBaseline: vi.fn(async () => ({
        account,
        audit,
        changeOrders: [],
        event,
      })),
    };
    const h = harness({
      xhsOpsStore: seed.store,
      xhsOpsAuditService: fake as unknown as XhsOpsAuditService,
    });
    const accounts = `/api/v1/xhs-ops/accounts/${account.id}/audits`;

    expect((await h.request("POST", accounts, { noteLimit: 21 })).status).toBe(
      400,
    );
    const started = await h.request("POST", accounts, {});
    expect(started.status).toBe(200);
    expect(xhsOpsAuditResponseSchema.parse(started.body).audit.id).toBe(
      audit.id,
    );
    expect(fake.startAudit).toHaveBeenCalledWith(account.id, { noteLimit: 20 });

    const listed = await h.request("GET", accounts);
    expect(listed.status).toBe(200);
    expect(
      xhsOpsAuditListResponseSchema.parse(listed.body).audits,
    ).toHaveLength(1);
    expect(
      (await h.request("GET", "/api/v1/xhs-ops/accounts/nope/audits")).status,
    ).toBe(404);

    const got = await h.request("GET", `/api/v1/xhs-ops/audits/${audit.id}`);
    expect(got.status).toBe(200);
    expect(
      (await h.request("GET", "/api/v1/xhs-ops/audits/missing")).status,
    ).toBe(404);

    const cancelled = await h.request(
      "POST",
      `/api/v1/xhs-ops/audits/${audit.id}/cancel`,
    );
    expect(cancelled.status).toBe(409);
    expect(messageOf(cancelled.body)).toBe("盘点已结束，无需取消");

    const baseline = await h.request(
      "POST",
      `/api/v1/xhs-ops/audits/${audit.id}/baseline`,
      { manualChecked: true },
    );
    expect(baseline.status).toBe(200);
    expect(
      xhsOpsAuditBaselineResponseSchema.parse(baseline.body),
    ).toMatchObject({ audit: { id: audit.id }, event });
    expect(fake.confirmBaseline).toHaveBeenCalledWith(audit.id, {
      manualChecked: true,
    });
  });
});

// ─── Diagnoses and plan ─────────────────────────────────────────────────────

function fakeDiagnosisService(input: {
  account: XhsOpsAccount;
  diagnosis: XhsOpsAccountDiagnosis;
}) {
  const { account, diagnosis } = input;
  return {
    generate: vi.fn(async () => ({ ...diagnosis, status: "generating" })),
    regenerate: vi.fn(async () => ({ ...diagnosis, version: 2 })),
    get: vi.fn(async () => ({
      diagnosis,
      event: xhsOpsAccountDiagnosedEvent({ account, diagnosis }),
    })),
    decide: vi.fn(async () => diagnosis),
    confirmPlan: vi.fn<XhsOpsDiagnosisService["confirmPlan"]>(async () => ({
      account,
      diagnosis: { ...diagnosis, status: "confirmed" as const },
      changeOrders: [],
      skippedFields: [
        {
          proposalId: "P5",
          field: "avatar" as const,
          reason: "这台手机系统版本过低，不支持自动换图",
        },
      ],
      event: xhsOpsTakeoverPlanConfirmedEvent({
        account,
        diagnosis,
        changeOrders: [],
        skippedFields: [],
      }),
    })),
  };
}

describe("takeover diagnosis routes", () => {
  it("map generate, get, regenerate, decisions and confirm to the diagnosis service", async () => {
    const seed = harness();
    const account = await existingAccount(seed, { lock: true });
    const audit = await completedAudit(seed, account);
    const diagnosis = await readyDiagnosis(seed, account, audit.id);
    const fake = fakeDiagnosisService({ account, diagnosis });
    const h = harness({
      xhsOpsStore: seed.store,
      xhsOpsDiagnosisService:
        fake as unknown as ControllerContainer["xhsOpsDiagnosisService"],
    });
    const one = `/api/v1/xhs-ops/diagnoses/${diagnosis.id}`;

    const noAudit = await h.request(
      "POST",
      `/api/v1/xhs-ops/accounts/${account.id}/diagnoses`,
      { feedback: "护肤慢慢加进来" },
    );
    expect(noAudit.status).toBe(400);
    const generated = await h.request(
      "POST",
      `/api/v1/xhs-ops/accounts/${account.id}/diagnoses`,
      { auditId: audit.id, feedback: "护肤慢慢加进来" },
    );
    expect(generated.status).toBe(200);
    expect(
      xhsOpsDiagnosisResponseSchema.parse(generated.body).diagnosis.status,
    ).toBe("generating");
    expect(fake.generate).toHaveBeenCalledWith(account.id, {
      auditId: audit.id,
      feedback: "护肤慢慢加进来",
    });

    const got = await h.request("GET", one);
    expect(got.status).toBe(200);
    const view = xhsOpsDiagnosisViewResponseSchema.parse(got.body);
    expect(view.event?.name).toBe("xhs_ops_account_diagnosed");

    const regenerated = await h.request("POST", `${one}/regenerate`, {
      feedback: "昵称保留",
    });
    expect(regenerated.status).toBe(200);
    expect(fake.regenerate).toHaveBeenCalledWith(diagnosis.id, {
      feedback: "昵称保留",
    });

    expect(
      (
        await h.request("POST", `${one}/decisions`, {
          expectedUpdatedAt: diagnosis.updatedAt,
          decisions: { X1: { decision: "adopt" } },
        })
      ).status,
    ).toBe(400);
    const decided = await h.request("POST", `${one}/decisions`, {
      expectedUpdatedAt: diagnosis.updatedAt,
      decisions: { P1: { decision: "adopt" } },
    });
    expect(decided.status).toBe(200);
    expect(fake.decide).toHaveBeenCalledWith(diagnosis.id, {
      expectedUpdatedAt: diagnosis.updatedAt,
      decisions: { P1: { decision: "adopt" } },
    });

    const confirmed = await h.request("POST", `${one}/confirm`, {
      expectedUpdatedAt: diagnosis.updatedAt,
    });
    expect(confirmed.status).toBe(200);
    const plan = xhsOpsTakeoverPlanResponseSchema.parse(confirmed.body);
    expect(plan.event.name).toBe("xhs_ops_takeover_plan_confirmed");
    expect(plan.skippedFields).toEqual([
      {
        proposalId: "P5",
        field: "avatar",
        reason: "这台手机系统版本过低，不支持自动换图",
      },
    ]);
    expect(fake.confirmPlan).toHaveBeenCalledWith(
      diagnosis.id,
      { expectedUpdatedAt: diagnosis.updatedAt },
      { imageFieldsSupported: true },
    );
  });

  it("passes imageFieldsSupported from the bound phone's osVersion (Android 10 / API 29)", async () => {
    const unreachable = {
      imageFieldsSupported: false,
      imageFieldsSkipReason: XHS_TAKEOVER_IMAGE_PHONE_UNREACHABLE_MESSAGE,
    };
    const cases: Array<{
      osVersion: string | number | undefined;
      throws?: boolean;
      offline?: boolean;
      /** Still known to tabby-control, silent for longer than the offline threshold. */
      stale?: boolean;
      expected: {
        imageFieldsSupported: boolean;
        imageFieldsSkipReason?: string;
      };
    }> = [
      { osVersion: "Android 9", expected: { imageFieldsSupported: false } },
      { osVersion: "Android 10", expected: { imageFieldsSupported: true } },
      { osVersion: "Android 12L", expected: { imageFieldsSupported: true } },
      { osVersion: 28, expected: { imageFieldsSupported: false } },
      { osVersion: "29", expected: { imageFieldsSupported: true } },
      // §5.2: a phone that reports no version counts as too old.
      { osVersion: undefined, expected: { imageFieldsSupported: false } },
      // A phone that cannot be asked is not blamed on its version.
      { osVersion: "Android 14", throws: true, expected: unreachable },
      { osVersion: "Android 14", offline: true, expected: unreachable },
      // A cached status is no answer: the same probe as the change orders'.
      { osVersion: "Android 14", stale: true, expected: unreachable },
    ];
    for (const entry of cases) {
      const seed = harness();
      const account = await existingAccount(seed, { lock: true });
      const audit = await completedAudit(seed, account);
      const diagnosis = await readyDiagnosis(seed, account, audit.id);
      const fake = fakeDiagnosisService({ account, diagnosis });
      seed.phone.osVersion = entry.osVersion;
      seed.phone.getDeviceThrows = entry.throws === true;
      seed.phone.online = entry.offline !== true;
      seed.phone.lastSeenAt = entry.stale
        ? Date.now() - XHS_OPS_DEFAULT_OFFLINE_AFTER_MS - 1_000
        : null;
      const h = harness({
        xhsOpsStore: seed.store,
        xhsOpsDiagnosisService:
          fake as unknown as ControllerContainer["xhsOpsDiagnosisService"],
        deviceControlService: seed.phone
          .control as ControllerContainer["deviceControlService"],
      });
      const confirmed = await h.request(
        "POST",
        `/api/v1/xhs-ops/diagnoses/${diagnosis.id}/confirm`,
        { expectedUpdatedAt: diagnosis.updatedAt, keepAllPublic: false },
      );
      expect(confirmed.status).toBe(200);
      expect(fake.confirmPlan.mock.calls[0]?.[2]).toEqual(entry.expected);
    }

    // No device bound: no osVersion to read.
    const seed = harness();
    const owner = await project(seed);
    const unbound = await seed.store.createAccount({
      projectId: owner.id,
      entryMode: "existing",
      label: "未绑定",
    });
    const diagnosis = await readyDiagnosis(seed, unbound, "audit-x");
    const fake = fakeDiagnosisService({ account: unbound, diagnosis });
    const h = harness({
      xhsOpsStore: seed.store,
      xhsOpsDiagnosisService:
        fake as unknown as ControllerContainer["xhsOpsDiagnosisService"],
    });
    await h.request(
      "POST",
      `/api/v1/xhs-ops/diagnoses/${diagnosis.id}/confirm`,
      {
        expectedUpdatedAt: diagnosis.updatedAt,
      },
    );
    expect(fake.confirmPlan.mock.calls[0]?.[2]).toEqual(unreachable);
  });

  it("drafts no avatar order for a phone only cached as Android 14, and says the phone was unreachable (B12)", async () => {
    const header = {
      following: xhsOpsParseCount("128"),
      followers: xhsOpsParseCount("1.2万"),
      likesCollects: xhsOpsParseCount("8.9万"),
    };
    const reply = JSON.stringify({
      s: "通勤穿搭为主的成熟账号",
      p: {
        a: "28岁",
        g: "女",
        r: "上海",
        o: "设计师",
        l: "通勤上班",
        c: "通勤穿搭",
        k: "medium",
      },
      d: [{ d: "activity", r: "good", n: "更新稳定" }],
      f: [
        {
          i: "F1",
          d: "persona_fit",
          v: "medium",
          s: "头像与护肤方向不符",
          e: ["profile.bio"],
          r: ["MT-01"],
        },
      ],
      q: [],
      x: [
        {
          i: "P1",
          k: "pool",
          co: ["通勤护肤", "敏感肌护理", "护肤成分"],
          ex: ["通勤穿搭"],
          ge: ["咖啡", "通勤"],
          w: "旧主线留在扩展层过渡",
          f: ["F1"],
          r: ["NU-08", "MT-04"],
        },
        {
          i: "P2",
          k: "field",
          fd: "avatar",
          to: "清爽的通勤自拍",
          w: "头像贴近护肤方向",
          f: ["F1"],
          r: ["PF-04"],
        },
      ],
    });
    const confirmWith = async (phone: { stale: boolean }) => {
      const seed = harness();
      const account = await existingAccount(seed, { lock: true });
      const now = new Date(seed.clock.now).toISOString();
      const audit = await seed.store.createAudit({
        projectId: account.projectId,
        accountId: account.id,
        deviceId: DEVICE,
        platformAccountId: XHS_ID,
        trigger: "takeover",
        status: "completed",
        startedAt: now,
        completedAt: now,
        profile: (await completedAudit(seed, account)).profile,
        home: {
          status: "read",
          code: "ok",
          evidence: null,
          nickname: "通勤小林",
          header,
          headerEnd: header,
          notesEnd: false,
          notes: [],
        },
      });
      await seed.store.mutateTakeover(account.id, ({ account: current }) => ({
        account: {
          ...current,
          takeover: {
            ...must(current.takeover),
            baselineAuditId: audit.id,
            latestAuditId: audit.id,
          },
        },
        result: null,
      }));
      const diagnoses = new XhsOpsDiagnosisService({
        store: seed.store,
        media: { generateText: async () => ({ text: reply }) },
        now: () => seed.clock.now,
      });
      const started = await diagnoses.generate(account.id, {
        auditId: audit.id,
      });
      const ready = must(await diagnoses.waitForGeneration(started.id));
      expect(ready.status).toBe("ready");
      const avatar = must(
        ready.proposals.find(
          (entry) => entry.kind === "profileField" && entry.field === "avatar",
        ),
      );
      const pool = must(
        ready.proposals.find((entry) => entry.kind === "interestPool"),
      );
      const decided = await diagnoses.decide(ready.id, {
        expectedUpdatedAt: ready.updatedAt,
        decisions: {
          [pool.id]: { decision: "adopt" },
          [avatar.id]: { decision: "adopt" },
        },
      });
      seed.phone.osVersion = "Android 14";
      seed.phone.lastSeenAt = phone.stale
        ? Date.now() - XHS_OPS_DEFAULT_OFFLINE_AFTER_MS - 1_000
        : null;
      const h = harness({
        xhsOpsStore: seed.store,
        xhsOpsDiagnosisService: diagnoses,
        deviceControlService: seed.phone
          .control as ControllerContainer["deviceControlService"],
      });
      const confirmed = await h.request(
        "POST",
        `/api/v1/xhs-ops/diagnoses/${ready.id}/confirm`,
        { expectedUpdatedAt: decided.updatedAt },
      );
      expect(confirmed.status).toBe(200);
      return {
        avatarId: avatar.id,
        plan: xhsOpsTakeoverPlanResponseSchema.parse(confirmed.body),
      };
    };
    const avatarOrders = (plan: { changeOrders: XhsOpsChangeOrder[] }) =>
      plan.changeOrders.filter((order) =>
        order.fields.some((entry) => entry.field === "avatar"),
      );

    // Reachable: the avatar becomes a draft.
    const live = await confirmWith({ stale: false });
    expect(live.plan.skippedFields).toEqual([]);
    expect(avatarOrders(live.plan)).toHaveLength(1);

    // Silent past the offline threshold: the cached Android 14 is no answer.
    const stale = await confirmWith({ stale: true });
    expect(avatarOrders(stale.plan)).toEqual([]);
    expect(stale.plan.skippedFields).toEqual([
      {
        proposalId: stale.avatarId,
        field: "avatar",
        reason: XHS_TAKEOVER_IMAGE_PHONE_UNREACHABLE_MESSAGE,
      },
    ]);
  });
});

// ─── Change orders ──────────────────────────────────────────────────────────

describe("takeover change-order routes", () => {
  it("map every change-order route to the service and attach the finished event", async () => {
    const seed = harness();
    const account = await existingAccount(seed, { lock: true });
    const draft = await draftOrder(seed, account, [
      { field: "bio", after: "通勤护肤记录" },
    ]);
    const observing: XhsOpsChangeOrder = {
      ...draft,
      status: "observing",
      confirmedAt: new Date(START).toISOString(),
      applyTaskId: "task-apply",
      fields: draft.fields.map((entry) => ({
        ...entry,
        before: "上海通勤",
        outcome: "verified",
      })),
      observation: {
        until: new Date(START + 72 * HOUR).toISOString(),
        auditId: null,
        baseAuditId: null,
        visualChecks: {},
        verdict: "pending",
        notes: [],
      },
    };
    const action = (order: XhsOpsChangeOrder) => async () => ({
      order,
      account,
    });
    const fake = {
      listChangeOrders: vi.fn(async () => [draft]),
      createChangeOrder: vi.fn(action(draft)),
      getChangeOrder: vi.fn(async () => observing),
      precheck: vi.fn(action({ ...draft, status: "prechecking" })),
      confirm: vi.fn(action({ ...draft, status: "applying" })),
      cancel: vi.fn(action({ ...draft, status: "cancelled", error: "已取消" })),
      verify: vi.fn(action({ ...draft, status: "verifying" })),
      visualCheck: vi.fn(action(observing)),
      manualCheck: vi.fn(action(observing)),
      reviewObservation: vi.fn(action(observing)),
      uploadImage: vi.fn(action(draft)),
    };
    const h = harness({
      xhsOpsStore: seed.store,
      xhsOpsChangeOrderService: fake as unknown as XhsOpsChangeOrderService,
    });
    const orders = `/api/v1/xhs-ops/accounts/${account.id}/change-orders`;
    const one = `/api/v1/xhs-ops/change-orders/${draft.id}`;
    const expectedUpdatedAt = draft.updatedAt;

    const listed = await h.request("GET", orders);
    expect(listed.status).toBe(200);
    expect(
      xhsOpsChangeOrderListResponseSchema.parse(listed.body).orders,
    ).toHaveLength(1);

    expect(
      (
        await h.request("POST", orders, {
          fields: [
            { field: "bio", after: "a" },
            { field: "occupation", after: "b" },
            { field: "nickname", after: "c" },
          ],
        })
      ).status,
    ).toBe(400);
    const created = await h.request("POST", orders, {
      fields: [{ field: "bio", after: "通勤护肤记录" }],
    });
    expect(created.status).toBe(200);
    expect(
      xhsOpsChangeOrderActionResponseSchema.parse(created.body).event,
    ).toBeNull();
    expect(fake.createChangeOrder).toHaveBeenCalledWith(account.id, {
      fields: [{ field: "bio", after: "通勤护肤记录" }],
    });

    const got = await h.request("GET", one);
    expect(got.status).toBe(200);
    const view = xhsOpsChangeOrderResponseSchema.parse(got.body);
    expect(view.event).toMatchObject({
      name: "xhs_ops_change_order_finished",
      payload: {
        orderId: draft.id,
        status: "observing",
        batchIndex: 1,
        observationUntil: new Date(START + 72 * HOUR).toISOString(),
        fields: [{ field: "bio", outcome: "verified" }],
      },
    });
    // Field names and outcomes only: never a value or the 小红书号.
    for (const secret of ["通勤护肤记录", "上海通勤", XHS_ID])
      expect(JSON.stringify(view.event)).not.toContain(secret);

    const steps: Array<{
      path: string;
      body: Record<string, unknown>;
      method: keyof typeof fake;
      event: boolean;
    }> = [
      {
        path: `${one}/precheck`,
        body: { expectedUpdatedAt },
        method: "precheck",
        event: false,
      },
      {
        path: `${one}/confirm`,
        body: {
          confirmDigest: "a".repeat(64),
          expectedUpdatedAt,
          acks: { l2SecondCheck: true },
        },
        method: "confirm",
        event: false,
      },
      {
        path: `${one}/cancel`,
        body: { expectedUpdatedAt },
        method: "cancel",
        event: true,
      },
      {
        path: `${one}/verify`,
        body: { expectedUpdatedAt },
        method: "verify",
        event: false,
      },
      {
        path: `${one}/visual-check`,
        body: { field: "avatar", result: "match", expectedUpdatedAt },
        method: "visualCheck",
        event: true,
      },
      {
        path: `${one}/manual-check`,
        body: { expectedUpdatedAt },
        method: "manualCheck",
        event: true,
      },
      {
        path: `${one}/observation/review`,
        body: { expectedUpdatedAt },
        method: "reviewObservation",
        event: true,
      },
    ];
    for (const step of steps) {
      const response = await h.request("POST", step.path, step.body);
      expect(response.status, step.path).toBe(200);
      const parsed = xhsOpsChangeOrderActionResponseSchema.parse(response.body);
      expect(parsed.event !== null, step.path).toBe(step.event);
      expect(fake[step.method]).toHaveBeenCalledWith(draft.id, step.body);
    }
    const cancelledEvent = xhsOpsChangeOrderActionResponseSchema.parse(
      (await h.request("POST", `${one}/cancel`, { expectedUpdatedAt })).body,
    ).event;
    expect(cancelledEvent?.payload).toMatchObject({
      status: "cancelled",
      reason: "已取消",
    });

    // Body validation happens before any service call.
    const invalid: Array<{ path: string; body: Record<string, unknown> }> = [
      {
        path: `${one}/confirm`,
        body: { confirmDigest: "not-hex", expectedUpdatedAt, acks: {} },
      },
      {
        path: `${one}/visual-check`,
        body: { field: "nickname", result: "match", expectedUpdatedAt },
      },
      { path: `${one}/precheck`, body: {} },
      { path: `${one}/observation/review`, body: {} },
    ];
    for (const entry of invalid)
      expect(
        (await h.request("POST", entry.path, entry.body)).status,
        entry.path,
      ).toBe(400);

    fake.precheck.mockRejectedValueOnce(
      new XhsOpsError(
        409,
        "观察期到 2026-10-24 10:00 结束，期间不能开下一张公开变更单",
      ),
    );
    const blocked = await h.request("POST", `${one}/precheck`, {
      expectedUpdatedAt,
    });
    expect(blocked.status).toBe(409);
    expect(messageOf(blocked.body)).toContain("观察期");
  });

  it("validates image uploads: the field, the data URL and the decoded file", async () => {
    const h0 = harness();
    const account = await existingAccount(h0, { lock: true });
    const order = await draftOrder(h0, account, [
      { field: "avatar", after: "清爽的职场半身照方向" },
    ]);
    const orders = new XhsOpsChangeOrderService({
      store: h0.store,
      deviceControl: h0.phone.control,
      profile: {
        applyChangeOrder: async () => {
          throw new Error("an upload never applies");
        },
        reconcile: async () => null,
      },
      audits: h0.audits,
      mediaRoot: h0.mediaRoot,
    });
    const h = harness({
      xhsOpsStore: h0.store,
      xhsOpsChangeOrderService: orders,
    });
    const image = (field: string) =>
      `/api/v1/xhs-ops/change-orders/${order.id}/fields/${field}/image`;
    const png = (content: Buffer) =>
      `data:image/png;base64,${Buffer.concat([PNG_MAGIC, content]).toString("base64")}`;
    const expectedUpdatedAt = order.updatedAt;

    expect(
      (
        await h.request("PUT", image("nickname"), {
          dataUrl: png(Buffer.from("x")),
          expectedUpdatedAt,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request("PUT", image("avatar"), {
          dataUrl: "data:image/gif;base64,R0lGODlh",
          expectedUpdatedAt,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request("PUT", image("avatar"), {
          dataUrl: png(Buffer.from("x")),
        })
      ).status,
    ).toBe(400);
    const notPng = await h.request("PUT", image("avatar"), {
      dataUrl: `data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64")}`,
      expectedUpdatedAt,
    });
    expect(notPng.status).toBe(400);
    expect(messageOf(notPng.body)).toBe("图片内容与声明的格式不符");
    const tooBig = await h.request("PUT", image("avatar"), {
      dataUrl: png(Buffer.alloc(10 * 1024 * 1024 + 1 - PNG_MAGIC.length)),
      expectedUpdatedAt,
    });
    expect(tooBig.status).toBe(400);
    expect(messageOf(tooBig.body)).toBe("图片不能超过 10MB");
    const otherField = await h.request("PUT", image("cover"), {
      dataUrl: png(Buffer.from("x")),
      expectedUpdatedAt,
    });
    expect(otherField.status).toBe(400);
    expect(messageOf(otherField.body)).toBe("这张单不改背景图");
    expect(
      (
        await h.request("PUT", image("avatar"), {
          dataUrl: png(Buffer.from("x")),
          expectedUpdatedAt: "stale",
        })
      ).status,
    ).toBe(409);

    const content = Buffer.from("avatar-picture");
    const uploaded = await h.request("PUT", image("avatar"), {
      dataUrl: png(content),
      expectedUpdatedAt,
    });
    expect(uploaded.status).toBe(200);
    const result = xhsOpsChangeOrderActionResponseSchema.parse(uploaded.body);
    const field = must(result.order.fields[0]);
    const bytes = Buffer.concat([PNG_MAGIC, content]);
    expect(field.imageSha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(field.imagePath).toBe(
      join(h0.mediaRoot, "xhs-takeover", order.id, "avatar.png"),
    );
    expect(existsSync(must(field.imagePath))).toBe(true);
    expect(readFileSync(must(field.imagePath)).equals(bytes)).toBe(true);
    expect(result.event).toBeNull();
  });
});

// ─── Profile-draft lock and entryMode lock (§2.5, §9 acceptance #9) ─────────

describe("existing accounts and the new-account profile flow", () => {
  it("answers 409 on every profile-draft route for takeover and legacy existing rows", async () => {
    const h = harness();
    const takeover = await existingAccount(h, { authorize: true });
    const owner = await project(h);
    const legacy = await h.store.createAccount({
      projectId: owner.id,
      entryMode: "existing",
      label: "旧流程已有账号",
      deviceId: "phone-legacy",
    });
    const legacyWithId = await h.store.createAccount({
      projectId: owner.id,
      entryMode: "existing",
      label: "旧流程已锁号",
      deviceId: "phone-legacy-2",
      platformAccountId: "xhs-legacy-002",
    });
    expect(legacy.takeover).toBeNull();
    expect(legacyWithId.takeover).toBeNull();
    const generateText = NO_MEDIA.generateText.mock.calls.length;
    const dispatched = h.phone.dispatched.length;
    for (const account of [takeover, legacy, legacyWithId]) {
      const base = `/api/v1/xhs-ops/accounts/${account.id}/profile-draft`;
      const responses = [
        await h.request("POST", `${base}/generate`, { parts: ["text"] }),
        await h.request("POST", `${base}/confirm`),
        await h.request("POST", `${base}/readback`),
        await h.request("POST", `${base}/apply`, { fields: ["bio"] }),
      ];
      for (const response of responses) {
        expect(response.status).toBe(409);
        expect(messageOf(response.body)).toBe(
          XHS_TAKEOVER_PROFILE_DRAFT_LOCKED_MESSAGE,
        );
      }
    }
    // Nothing was generated or dispatched for them.
    expect(NO_MEDIA.generateText.mock.calls.length).toBe(generateText);
    expect(h.phone.dispatched.length).toBe(dispatched);

    // A new account still reaches the profile service.
    const fresh = await h.store.createAccount({
      projectId: owner.id,
      label: "新号",
    });
    const generated = await h.request(
      "POST",
      `/api/v1/xhs-ops/accounts/${fresh.id}/profile-draft/generate`,
      { parts: ["text"] },
    );
    expect(messageOf(generated.body)).not.toBe(
      XHS_TAKEOVER_PROFILE_DRAFT_LOCKED_MESSAGE,
    );
    expect(
      (
        await h.request(
          "POST",
          "/api/v1/xhs-ops/accounts/nope/profile-draft/readback",
        )
      ).status,
    ).toBe(404);
  });

  it("refuses to switch a takeover or a locked legacy row back to new", async () => {
    const h = harness();
    const takeover = await existingAccount(h, { authorize: true });
    const owner = await project(h);
    const legacyWithId = await h.store.createAccount({
      projectId: owner.id,
      entryMode: "existing",
      label: "旧流程已锁号",
      platformAccountId: "xhs-legacy-002",
    });
    const unlocked = await h.store.createAccount({
      projectId: owner.id,
      entryMode: "existing",
      label: "还没填号的旧行",
    });
    for (const account of [takeover, legacyWithId]) {
      const response = await h.request(
        "PATCH",
        `/api/v1/xhs-ops/accounts/${account.id}`,
        { entryMode: "new" },
      );
      expect(response.status).toBe(409);
      expect(messageOf(response.body)).toBe(
        XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE,
      );
      expect(must(await h.store.getAccount(account.id)).entryMode).toBe(
        "existing",
      );
    }
    const switched = await h.request(
      "PATCH",
      `/api/v1/xhs-ops/accounts/${unlocked.id}`,
      { entryMode: "new" },
    );
    expect(switched.status).toBe(200);
  });

  it("hands an existing account's legacy identity/read to the takeover read", async () => {
    const h = harness();
    const unauthorized = await existingAccount(h);
    const refused = await h.request(
      "POST",
      `/api/v1/xhs-ops/accounts/${unauthorized.id}/identity/read`,
    );
    expect(refused.status).toBe(409);
    expect(messageOf(refused.body)).toBe("请先在接管卡片上授权接管该账号");
    expect(h.phone.dispatched).toHaveLength(0);

    await h.store.authorizeTakeover(unauthorized.id, {
      expectedUpdatedAt: unauthorized.updatedAt,
      ownershipConfirmed: true,
    });
    h.advance(MINUTE);
    h.phone.next({
      message: `${XHS_IDENTITY_MARKER}${JSON.stringify({
        v: 1,
        status: "visible",
        accountId: XHS_ID,
      })}`,
    });
    const read = await h.request(
      "POST",
      `/api/v1/xhs-ops/accounts/${unauthorized.id}/identity/read`,
    );
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: "visible", accountId: XHS_ID });
    expect(h.phone.dispatched.at(-1)?.taskPolicy).toEqual(
      XHS_AUDIT_TASK_POLICY,
    );
    // The same server-side pending read the takeover confirm accepts.
    const stored = must(await h.store.getAccount(unauthorized.id));
    expect(stored.takeover?.pendingIdentity?.readAccountId).toBe(XHS_ID);
  });
});

// ─── Resume (§6.5) ──────────────────────────────────────────────────────────

describe("takeover resume (§6.5)", () => {
  async function pausedAccount(
    h: Harness,
    code: "rate_limited" | "login_required" | "manual" | "observation_failed",
  ): Promise<XhsOpsAccount> {
    const account = await existingAccount(h, { lock: true });
    return h.store.pauseTakeover(account.id, {
      code,
      reason: "测试暂停",
      sourceRef: "run-1",
    });
  }

  const resume = (h: Harness, account: XhsOpsAccount, reason?: string) =>
    h.request(
      "POST",
      `/api/v1/xhs-ops/accounts/${account.id}/takeover/resume`,
      {
        expectedUpdatedAt: account.updatedAt,
        ...(reason === undefined ? {} : { reason }),
      },
    );

  it("lifts a cooldown pause without the gate once a reason is given and the cooldown passed", async () => {
    const h = harness();
    const paused = await pausedAccount(h, "rate_limited");
    const noReason = await resume(h, paused);
    expect(noReason.status).toBe(409);
    expect(messageOf(noReason.body)).toBe("恢复这类暂停需要填写原因");
    const early = await resume(h, paused, "已人工确认风控解除");
    expect(early.status).toBe(409);
    expect(messageOf(early.body)).toContain("冷却期未结束");

    h.advance(48 * HOUR + MINUTE);
    const resumed = await resume(h, paused, "已人工确认风控解除");
    expect(resumed.status).toBe(200);
    const result = xhsOpsTakeoverResumeResponseSchema.parse(resumed.body);
    expect(result).toMatchObject({ resumed: true, gate: null });
    expect(result.account.takeover?.safetyPause).toBeNull();
    expect(h.phone.dispatched).toHaveLength(0);
    // The written reason outlives the pause it lifted.
    expect(result.account.takeover?.resumeHistory).toEqual([
      {
        at: new Date(h.clock.now).toISOString(),
        code: "rate_limited",
        since: paused.takeover?.safetyPause?.since,
        sourceRef: "run-1",
        pauseReason: "测试暂停",
        reason: "已人工确认风控解除",
        gateTaskId: null,
      },
    ]);
  });

  it("runs the read-only identity gate for login_required and lifts the pause only on ready", async () => {
    const h = harness();
    const paused = await pausedAccount(h, "login_required");
    h.phone.next({ message: gateReceipt("ready", "ready") });
    const resumed = await resume(h, paused);
    expect(resumed.status).toBe(200);
    const result = xhsOpsTakeoverResumeResponseSchema.parse(resumed.body);
    expect(result.resumed).toBe(true);
    expect(result.gate).toMatchObject({ status: "ready", code: "ready" });
    expect(result.account.takeover?.safetyPause).toBeNull();
    expect(result.account.takeover?.resumeHistory).toMatchObject([
      {
        code: "login_required",
        reason: "",
        gateTaskId: result.gate?.taskId,
      },
    ]);

    const gate = must(h.phone.dispatched[0]);
    expect(gate.task).toContain("【接管账号运行前身份闸门】");
    expect(gate.task).toContain(`任务指定值「${XHS_ID}」`);
    expect(gate.taskPolicy?.operationClass).toBe("account.login");
    expect(gate.taskPolicy?.confirmationPolicy?.login).toBe("forbidden");
    expect(gate.taskPolicy?.allowedActions).not.toContain("TYPE");
    expect(gate.taskPolicy?.allowedAppRoles).not.toContain("default_sms");
    expect(gate.taskPolicy?.allowedAppRoles).not.toContain("system_settings");
    // The lock is back once the gate ended.
    const release = await h.store.acquireExclusiveDeviceBinding(
      paused.id,
      DEVICE,
    );
    release();
  });

  it("keeps the pause when the gate is not ready, recording what the gate found", async () => {
    const h = harness();
    const paused = await pausedAccount(h, "manual");
    h.phone.next({ message: gateReceipt("blocked", "phone_required") });
    const signedOut = await resume(h, paused);
    expect(signedOut.status).toBe(200);
    const first = xhsOpsTakeoverResumeResponseSchema.parse(signedOut.body);
    expect(first.resumed).toBe(false);
    expect(first.gate).toMatchObject({
      status: "blocked",
      code: "phone_required",
    });
    expect(first.account.takeover?.safetyPause?.code).toBe("login_required");

    h.phone.next({ message: gateReceipt("blocked", "account_mismatch") });
    const mismatched = xhsOpsTakeoverResumeResponseSchema.parse(
      (await resume(h, first.account)).body,
    );
    expect(mismatched.resumed).toBe(false);
    expect(mismatched.account.takeover?.safetyPause?.code).toBe(
      "account_mismatch",
    );

    // No usable receipt: the pause stays exactly as it was.
    h.phone.next({ message: "没有回执" });
    const unusable = xhsOpsTakeoverResumeResponseSchema.parse(
      (await resume(h, mismatched.account)).body,
    );
    expect(unusable.resumed).toBe(false);
    expect(unusable.gate?.code).toBe("invalid_result");
    expect(unusable.account.takeover?.safetyPause).toEqual(
      mismatched.account.takeover?.safetyPause,
    );
    // Nothing was lifted, so nothing is in the history.
    expect(unusable.account.takeover?.resumeHistory).toEqual([]);
    for (const body of h.phone.dispatched)
      expect(body.taskPolicy?.confirmationPolicy?.login).toBe("forbidden");
  });

  it("stops a gate that asks for a human, and holds the device when the stop is unconfirmed", async () => {
    const h = harness();
    const paused = await pausedAccount(h, "manual");
    h.phone.next({ needsInteraction: true });
    const stopped = xhsOpsTakeoverResumeResponseSchema.parse(
      (await resume(h, paused)).body,
    );
    expect(stopped.resumed).toBe(false);
    expect(stopped.gate?.status).toBe("blocked");
    expect(h.phone.cancelled).toEqual([stopped.gate?.taskId]);
    expect(stopped.account.takeover?.deviceHold).toBeNull();

    h.phone.confirmCancel = false;
    h.phone.next({ needsInteraction: true });
    const held = xhsOpsTakeoverResumeResponseSchema.parse(
      (await resume(h, stopped.account)).body,
    );
    expect(held.resumed).toBe(false);
    expect(held.account.takeover?.deviceHold).toMatchObject({
      taskId: held.gate?.taskId,
      sourceRef: "takeover-resume",
    });
    expect(held.account.takeover?.safetyPause).not.toBeNull();
    // The device stays locked until a human releases the hold.
    await expect(
      h.store.acquireExclusiveDeviceBinding(paused.id, DEVICE),
    ).rejects.toThrow();
  });

  it("answers 409 before dispatching anything when the resume cannot run", async () => {
    const h = harness();
    const paused = await pausedAccount(h, "observation_failed");
    expect(messageOf((await resume(h, paused)).body)).toBe(
      "恢复这类暂停需要填写原因",
    );
    expect(
      (
        await h.request(
          "POST",
          `/api/v1/xhs-ops/accounts/${paused.id}/takeover/resume`,
          { expectedUpdatedAt: "stale", reason: "已回滚" },
        )
      ).status,
    ).toBe(409);
    h.phone.online = false;
    expect((await resume(h, paused, "已回滚")).status).toBe(409);
    h.phone.online = true;
    h.phone.policyMode = "audit";
    const audit = await resume(h, paused, "已回滚");
    expect(audit.status).toBe(409);
    expect(messageOf(audit.body)).toContain("enforce");
    h.phone.policyMode = "enforce";
    h.phone.status = "busy";
    expect((await resume(h, paused, "已回滚")).status).toBe(409);
    expect(h.phone.dispatched).toHaveLength(0);
    expect(
      must(await h.store.getAccount(paused.id)).takeover?.safetyPause?.code,
    ).toBe("observation_failed");

    const h2 = harness();
    const notPaused = await existingAccount(h2, { lock: true });
    const response = await resume(h2, notPaused);
    expect(response.status).toBe(409);
    expect(messageOf(response.body)).toBe("账号没有暂停，无需恢复");
  });
});

// ─── Startup recovery (§2.6) ────────────────────────────────────────────────

describe("takeover startup recovery", () => {
  async function interruptedWork(h: Harness) {
    const account = await existingAccount(h, { lock: true });
    const now = new Date(h.clock.now).toISOString();
    const running = await h.store.createAudit({
      projectId: account.projectId,
      accountId: account.id,
      deviceId: DEVICE,
      platformAccountId: XHS_ID,
      status: "running",
      activeTaskId: "task-audit",
      startedAt: now,
    });
    const generating = await h.store.createDiagnosis({
      projectId: account.projectId,
      accountId: account.id,
      auditId: running.id,
      version: 1,
      status: "generating",
      playbookVersion: XHS_OPS_PLAYBOOK_VERSION,
      facts: { tier: "growing" },
      cadence: { browseDefaults: {}, interaction: {}, rationale: [] },
      generator: { botId: "bot-1", model: null },
    });
    const prechecking = await draftOrder(
      h,
      account,
      [{ field: "bio", after: "通勤护肤记录" }],
      "prechecking",
    );
    const applying = await h.store.createChangeOrder({
      projectId: account.projectId,
      accountId: account.id,
      deviceId: DEVICE,
      platformAccountId: XHS_ID,
      diagnosisId: null,
      proposalIds: [],
      batchIndex: 1,
      risk: "L1",
      fields: [{ field: "occupation", baselineValue: "", after: "互联网运营" }],
      status: "applying",
      applyTaskId: "task-apply",
    });
    return { account, running, generating, prechecking, applying };
  }

  it("sweeps the store and hands audits and change orders to their reconcile", async () => {
    const h = harness();
    const work = await interruptedWork(h);
    const reconcileInterruptedAudits = vi.fn<
      XhsOpsAuditService["reconcileInterruptedAudits"]
    >(async () => []);
    const reconcileInterruptedOrders = vi.fn<
      XhsOpsChangeOrderService["reconcileInterruptedOrders"]
    >(async () => []);
    await recoverXhsOpsTakeoverWork({
      store: h.store,
      audits: { reconcileInterruptedAudits },
      changeOrders: { reconcileInterruptedOrders },
    });
    expect(reconcileInterruptedAudits).toHaveBeenCalledTimes(1);
    expect(reconcileInterruptedAudits.mock.calls[0]?.[0]).toMatchObject([
      {
        id: work.running.id,
        status: "interrupted",
        activeTaskId: "task-audit",
      },
    ]);
    expect(reconcileInterruptedOrders).toHaveBeenCalledTimes(1);
    expect(reconcileInterruptedOrders.mock.calls[0]?.[0]).toMatchObject([
      {
        order: { id: work.prechecking.id, status: "draft" },
        previousStatus: "prechecking",
      },
      {
        order: { id: work.applying.id, status: "interrupted" },
        previousStatus: "applying",
        taskId: "task-apply",
      },
    ]);
    expect((await h.store.getDiagnosis(work.generating.id))?.status).toBe(
      "failed",
    );

    // A second start finds nothing left to do.
    reconcileInterruptedAudits.mockClear();
    reconcileInterruptedOrders.mockClear();
    await recoverXhsOpsTakeoverWork({
      store: h.store,
      audits: { reconcileInterruptedAudits },
      changeOrders: { reconcileInterruptedOrders },
    });
    expect(reconcileInterruptedAudits).not.toHaveBeenCalled();
    expect(reconcileInterruptedOrders).not.toHaveBeenCalled();
  });

  it("never throws: a failed reconcile does not skip the other, a failed sweep skips both", async () => {
    const h = harness();
    await interruptedWork(h);
    const reconcileInterruptedOrders = vi.fn(async () => []);
    await expect(
      recoverXhsOpsTakeoverWork({
        store: h.store,
        audits: {
          reconcileInterruptedAudits: async () => {
            throw new Error("device control RPC failed");
          },
        },
        changeOrders: { reconcileInterruptedOrders },
      }),
    ).resolves.toBeUndefined();
    expect(reconcileInterruptedOrders).toHaveBeenCalledTimes(1);

    const reconcileInterruptedAudits = vi.fn(async () => []);
    const state = { settled: false };
    await expect(
      recoverXhsOpsTakeoverWork({
        store: {
          recoverInterruptedTakeoverWork: async () => {
            throw new Error("state file unreadable");
          },
        },
        audits: { reconcileInterruptedAudits },
        changeOrders: { reconcileInterruptedOrders },
        state,
      }),
    ).resolves.toBeUndefined();
    expect(reconcileInterruptedAudits).not.toHaveBeenCalled();
    // Nothing is left to wait for: the takeover routes open again.
    expect(state.settled).toBe(true);
  });

  it("answers 503 on takeover work until the startup recovery settled", async () => {
    const state = { settled: false };
    const h = harness({ xhsOpsTakeoverRecovery: state });
    const work = await interruptedWork(h);
    const accountBase = `/api/v1/xhs-ops/accounts/${work.account.id}`;
    const order = `/api/v1/xhs-ops/change-orders/${work.prechecking.id}`;
    const writes: Array<{ method: string; path: string; body?: unknown }> = [
      {
        method: "POST",
        path: `${accountBase}/takeover/resume`,
        body: { expectedUpdatedAt: work.account.updatedAt },
      },
      { method: "POST", path: `${accountBase}/takeover/identity/read` },
      { method: "POST", path: `${accountBase}/audits`, body: {} },
      {
        method: "POST",
        path: `${accountBase}/diagnoses`,
        body: { auditId: work.running.id },
      },
      { method: "GET", path: `${accountBase}/change-orders` },
      { method: "GET", path: order },
      {
        method: "POST",
        path: `${order}/precheck`,
        body: { expectedUpdatedAt: work.prechecking.updatedAt },
      },
      {
        method: "PUT",
        path: `${order}/fields/avatar/image`,
        body: {
          dataUrl: `data:image/png;base64,${PNG_MAGIC.toString("base64")}`,
          expectedUpdatedAt: work.prechecking.updatedAt,
        },
      },
    ];
    for (const entry of writes) {
      const response = await h.request(entry.method, entry.path, entry.body);
      expect(response.status, entry.path).toBe(503);
      expect(messageOf(response.body), entry.path).toContain("正在收口");
    }
    // Nothing reached a service: the previous process's work is as it was.
    expect(h.phone.dispatched).toEqual([]);
    expect((await h.store.getAudit(work.running.id))?.status).toBe("running");
    expect((await h.store.getChangeOrder(work.applying.id))?.status).toBe(
      "applying",
    );

    // Reads and 「暂停接管」 stay open meanwhile.
    expect((await h.request("GET", `${accountBase}/audits`)).status).toBe(200);
    expect(
      (await h.request("GET", `/api/v1/xhs-ops/audits/${work.running.id}`))
        .status,
    ).toBe(200);
    expect((await h.request("GET", "/api/v1/xhs-ops/playbook")).status).toBe(
      200,
    );
    const paused = await h.request("POST", `${accountBase}/takeover/pause`, {
      reason: "重启期间先停一下",
    });
    expect(paused.status).toBe(200);

    await recoverXhsOpsTakeoverWork({
      store: h.store,
      audits: { reconcileInterruptedAudits: async () => [] },
      changeOrders: { reconcileInterruptedOrders: async () => [] },
      state,
    });
    expect(state.settled).toBe(true);
    const account = must(await h.store.getAccount(work.account.id));
    const released = await h.request(
      "POST",
      `${accountBase}/takeover/device-hold/release`,
      { expectedUpdatedAt: account.updatedAt, stoppedOnPhone: true },
    );
    // Past the guard: the store answers on its own.
    expect(released.status).toBe(409);
    expect(messageOf(released.body)).toBe("没有待解除的手机任务");
  });

  it("answers the same 503 on the shared account routes for an existing account, not a new one (A6)", async () => {
    const state = { settled: false };
    const h = harness({ xhsOpsTakeoverRecovery: state });
    const work = await interruptedWork(h);
    const legacy = await h.store.createAccount({
      projectId: work.account.projectId,
      entryMode: "existing",
      label: "老号·未接管",
      platformAccountId: "legacy-xhs",
      deviceId: "phone-legacy",
    });
    const fresh = await h.store.createAccount({
      projectId: work.account.projectId,
      label: "新号",
      deviceId: "phone-new",
    });
    const accounts = "/api/v1/xhs-ops/accounts";
    const transfer = `/api/v1/xhs-ops/projects/${work.account.projectId}/accounts/transfer-device`;
    for (const target of [work.account, legacy]) {
      const base = `${accounts}/${target.id}`;
      const refused: Array<{ method: string; path: string; body?: unknown }> = [
        { method: "POST", path: `${base}/identity/read` },
        { method: "POST", path: `${base}/profile-draft/reconcile` },
        { method: "PATCH", path: base, body: { deviceId: null } },
        { method: "DELETE", path: base },
        {
          method: "POST",
          path: transfer,
          body: {
            fromAccountId: target.id,
            account: { label: "新号二", deviceId: target.deviceId },
          },
        },
        {
          method: "POST",
          path: transfer,
          body: {
            fromAccountId: fresh.id,
            toAccountId: target.id,
            account: {
              label: target.label,
              entryMode: "existing",
              deviceId: "phone-new",
            },
          },
        },
      ];
      for (const entry of refused) {
        const response = await h.request(entry.method, entry.path, entry.body);
        expect(response.status, `${entry.method} ${entry.path}`).toBe(503);
        expect(messageOf(response.body)).toContain("正在收口");
      }
      // A PATCH that leaves the identity where it is goes through.
      const renamed = await h.request("PATCH", base, { label: "改个名" });
      expect(renamed.status, target.label).toBe(200);
    }
    expect(h.phone.dispatched).toEqual([]);
    expect(await h.store.getAccount(work.account.id)).toMatchObject({
      deviceId: DEVICE,
    });
    expect(await h.store.getAccount(legacy.id)).toMatchObject({
      deviceId: "phone-legacy",
    });

    // A new account is served as before.
    const freshBase = `${accounts}/${fresh.id}`;
    expect(
      (await h.request("POST", `${freshBase}/profile-draft/reconcile`)).status,
    ).toBe(200);
    expect(
      (await h.request("PATCH", freshBase, { deviceId: "phone-new-2" })).status,
    ).toBe(200);
    expect((await h.request("DELETE", freshBase)).status).toBe(200);

    await recoverXhsOpsTakeoverWork({
      store: h.store,
      audits: { reconcileInterruptedAudits: async () => [] },
      changeOrders: { reconcileInterruptedOrders: async () => [] },
      state,
    });
    // Past the guard: the store answers on its own.
    expect(
      (await h.request("PATCH", `${accounts}/${legacy.id}`, { deviceId: null }))
        .status,
    ).toBe(200);
  });

  it("queues the sweep before any takeover work started after it", async () => {
    const h = harness();
    const work = await interruptedWork(h);
    const reconcileInterruptedAudits = vi.fn<
      XhsOpsAuditService["reconcileInterruptedAudits"]
    >(async () => []);
    const recovery = recoverXhsOpsTakeoverWork({
      store: h.store,
      audits: { reconcileInterruptedAudits },
      changeOrders: { reconcileInterruptedOrders: async () => [] },
    });
    // Work of the new process, queued right after the call.
    const fresh = h.store.createAudit({
      projectId: work.account.projectId,
      accountId: work.account.id,
      deviceId: DEVICE,
      platformAccountId: XHS_ID,
      status: "running",
      startedAt: new Date(h.clock.now).toISOString(),
    });
    await recovery;
    const created = await fresh;
    expect((await h.store.getAudit(created.id))?.status).toBe("running");
    expect(reconcileInterruptedAudits.mock.calls[0]?.[0]).toHaveLength(1);
  });
});
