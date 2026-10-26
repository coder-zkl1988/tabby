import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  XHS_TAKEOVER_IMAGE_PHONE_UNREACHABLE_MESSAGE,
  XHS_TAKEOVER_IMAGE_UNSUPPORTED_MESSAGE,
  type XhsOpsAccount,
  type XhsOpsAccountAudit,
  type XhsOpsAccountDiagnosis,
  type XhsOpsChangeOrder,
  type XhsOpsTakeover,
  xhsOpsAccountAuditSchema,
  xhsOpsAccountDiagnosisSchema,
  xhsOpsAccountNurtureIssues,
  xhsOpsChangeOrderSchema,
  xhsOpsTakeoverStage,
} from "@nexu/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  type XhsOpsAuditSeed,
  type XhsOpsChangeOrderSeed,
  type XhsOpsDiagnosisSeed,
  XhsOpsStore,
} from "../src/store/xhs-ops-store.js";
import {
  XHS_OPS_MAX_AUDITS,
  XHS_OPS_MAX_CHANGE_ORDERS,
  XHS_OPS_MAX_DIAGNOSES,
  evictAudits,
  evictChangeOrders,
  evictDiagnoses,
  takeoverPlanFields,
} from "../src/store/xhs-ops-takeover-records.js";

const START = Date.parse("2026-10-21T02:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const XHS_ID = "xhs-owner-001";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "xhs-takeover-store-"));
  directories.push(directory);
  const file = join(directory, "state.json");
  let clock = START;
  let id = 0;
  const deps = {
    now: () => new Date(clock).toISOString(),
    genId: () => `id-${++id}`,
  };
  return {
    store: new XhsOpsStore(file, deps),
    advance: (ms: number) => {
      clock += ms;
    },
    at: (ms: number) => {
      clock = ms;
    },
    /** A second store on the same file: what a controller restart sees. */
    reopen: () => new XhsOpsStore(file, deps),
  };
}
type Harness = ReturnType<typeof harness>;

function takeoverOf(account: XhsOpsAccount | null | undefined): XhsOpsTakeover {
  if (!account?.takeover) throw new Error("fixture has no takeover");
  return account.takeover;
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing fixture");
  return value;
}

/** Lock a takeover to another 小红书号 through the identity flow (read, then confirm). */
async function relockIdentity(
  h: Harness,
  accountId: string,
  platformAccountId: string,
): Promise<XhsOpsAccount> {
  h.advance(MINUTE);
  await h.store.recordTakeoverIdentityRead(accountId, {
    taskId: `identity-${platformAccountId}`,
    deviceId: "phone-1",
    screenshotUrl: null,
    readAccountId: platformAccountId,
  });
  h.advance(MINUTE);
  return h.store.confirmTakeoverIdentity(accountId, {
    identityTaskId: `identity-${platformAccountId}`,
    platformAccountId,
  });
}

async function confirmedProject(h: Harness) {
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

async function authorizedAccount(
  h: Harness,
  overrides: Partial<Parameters<XhsOpsStore["createAccount"]>[0]> = {},
) {
  const project = await confirmedProject(h);
  const account = await h.store.createAccount({
    projectId: project.id,
    entryMode: "existing",
    label: "接管·测试机",
    deviceId: "phone-1",
    deviceName: "测试机",
    ...overrides,
  });
  const authorized = await h.store.authorizeTakeover(account.id, {
    expectedUpdatedAt: account.updatedAt,
    ownershipConfirmed: true,
    authorizationNote: "客户书面授权",
  });
  return { project, account: authorized };
}

async function lockedAccount(
  h: Harness,
  overrides: Partial<Parameters<XhsOpsStore["createAccount"]>[0]> = {},
) {
  const { project, account } = await authorizedAccount(h, overrides);
  h.advance(MINUTE);
  await h.store.recordTakeoverIdentityRead(account.id, {
    taskId: "identity-task",
    deviceId: "phone-1",
    screenshotUrl: "/api/v1/media/identity.png",
    readAccountId: XHS_ID,
  });
  h.advance(MINUTE);
  const locked = await h.store.confirmTakeoverIdentity(account.id, {
    identityTaskId: "identity-task",
    platformAccountId: XHS_ID,
  });
  return { project, account: locked };
}

function auditSeed(
  account: XhsOpsAccount,
  overrides: Partial<XhsOpsAuditSeed> = {},
): XhsOpsAuditSeed {
  return {
    projectId: account.projectId,
    accountId: account.id,
    deviceId: must(account.deviceId),
    platformAccountId: account.platformAccountId,
    trigger: "takeover",
    status: "completed",
    startedAt: new Date(START).toISOString(),
    profile: {
      status: "read",
      code: "",
      evidence: null,
      accountMatched: true,
      values: {
        nickname: "老昵称",
        bio: "老简介",
        occupation: "设计师",
        gender: "女",
        birthdayFilled: true,
        region: "中国 上海 上海",
      },
    },
    ...overrides,
  };
}

/** What the audit service does once a baseline is confirmed. */
async function baselinedAccount(
  h: Harness,
  overrides: Partial<Parameters<XhsOpsStore["createAccount"]>[0]> = {},
) {
  const { project, account } = await lockedAccount(h, overrides);
  const audit = await h.store.createAudit(auditSeed(account));
  const { account: baselined } = await h.store.mutateTakeover(
    account.id,
    ({ account: current }) => ({
      account: {
        ...current,
        takeover: {
          ...takeoverOf(current),
          baselineAuditId: audit.id,
          latestAuditId: audit.id,
        },
      },
      result: null,
    }),
  );
  return { project, account: baselined, audit };
}

const ESTABLISHED_CADENCE = {
  browseDefaults: {
    dwellSecMin: 11,
    dwellSecMax: 25,
    searchRatioPercent: 60,
    postsPerKeyword: 5,
    homeFeedCount: 6,
    dailyTargetPosts: 40,
    dailySegments: 2,
  },
  interaction: {
    like: { enabled: true, dailyCap: 4, ratioPercent: 8 },
    collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
    follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
    comment: { enabled: false, dailyCap: 2 },
  },
  rationale: ["粉丝下界 12000 ≥ 1000，按成熟档"],
};

const decided = (decision: "adopt" | "reject" | "defer") => ({
  decision,
  decidedAt: new Date(START).toISOString(),
});

function diagnosisSeed(
  account: XhsOpsAccount,
  auditId: string,
  decisions: XhsOpsDiagnosisSeed["decisions"] = {
    P1: decided("adopt"),
    P2: {
      decision: "edit",
      edited: { label: "通勤护肤日记" },
      decidedAt: new Date(START).toISOString(),
    },
    P3: decided("adopt"),
    // An edit changes the value only; it cannot retarget the field.
    P4: {
      decision: "edit",
      edited: { field: "gender", to: "上海通勤 | 敏感肌护肤记录" },
      decidedAt: new Date(START).toISOString(),
    },
    P5: decided("adopt"),
    P6: decided("adopt"),
    P7: decided("adopt"),
    P8: decided("adopt"),
  },
): XhsOpsDiagnosisSeed {
  return {
    projectId: account.projectId,
    accountId: account.id,
    auditId,
    version: 1,
    status: "ready",
    playbookVersion: "2026-10-20",
    facts: { tier: "established" },
    cadence: ESTABLISHED_CADENCE,
    inferredPersona: {
      persona: {
        age: "28岁",
        gender: "女",
        region: "上海",
        occupation: "设计师",
        lifeStatus: "通勤上班",
      },
      contentLine: "通勤穿搭",
      confidence: "medium",
    },
    proposals: [
      {
        id: "P1",
        kind: "interestPool",
        core: ["通勤护肤", "敏感肌护理", "护肤成分", "通勤护肤"],
        extended: ["通勤穿搭"],
        general: ["咖啡", " "],
        rationale: "旧主线留在扩展层过渡",
        ruleIds: ["NU-08", "MT-04"],
        risk: "L0",
        batch: 0,
      },
      {
        id: "P2",
        kind: "positioning",
        label: "通勤护肤号",
        positioning: "上海通勤女生的护肤记录",
        persona: {
          age: "28岁",
          gender: "女",
          region: "上海",
          occupation: "设计师",
          lifeStatus: "通勤上班",
        },
        personaTags: { vertical: ["护肤"], general: ["咖啡", "通勤"] },
        rationale: "与目标人群重合",
        ruleIds: ["MT-01"],
        risk: "L0",
        batch: 0,
      },
      {
        id: "P3",
        kind: "toneGuide",
        guide: { summary: "真实通勤体验", commentStyle: "像朋友一样聊" },
        rationale: "保留口语化",
        ruleIds: ["TN-08"],
        risk: "L0",
        batch: 0,
      },
      {
        id: "P4",
        kind: "profileField",
        field: "bio",
        to: "上海通勤 | 敏感肌护理",
        rationale: "简介补护肤方向",
        ruleIds: ["PF-06"],
        risk: "L1",
        batch: 1,
      },
      {
        id: "P5",
        kind: "profileField",
        field: "occupation",
        to: "设计师",
        rationale: "职业已对，应被代码剔除",
        ruleIds: ["MT-01"],
        risk: "L1",
        batch: 1,
      },
      {
        id: "P6",
        kind: "profileField",
        field: "nickname",
        to: "通勤护肤日记",
        rationale: "统一主线",
        ruleIds: ["PF-02"],
        risk: "L2",
        batch: 2,
      },
      {
        id: "P7",
        kind: "profileField",
        field: "avatar",
        to: "清爽职场半身照方向",
        rationale: "头像与定位一致",
        ruleIds: ["MT-02"],
        risk: "L2",
        batch: 3,
      },
      {
        id: "P8",
        kind: "profileField",
        field: "region",
        to: "中国 北京 北京",
        rationale: "运营要求",
        ruleIds: ["MT-02"],
        risk: "L2",
        batch: 2,
      },
    ],
    decisions,
    generator: { botId: "bot-1", model: null },
  };
}

async function diagnosedAccount(
  h: Harness,
  options: {
    account?: Partial<Parameters<XhsOpsStore["createAccount"]>[0]>;
    decisions?: XhsOpsDiagnosisSeed["decisions"];
  } = {},
) {
  const { project, account, audit } = await baselinedAccount(
    h,
    options.account,
  );
  const diagnosis = await h.store.createDiagnosis(
    diagnosisSeed(account, audit.id, options.decisions),
    { activate: true },
  );
  return {
    project,
    account: must(await h.store.getAccount(account.id)),
    audit,
    diagnosis,
  };
}

function orderSeed(
  account: XhsOpsAccount,
  overrides: Partial<XhsOpsChangeOrderSeed> = {},
): XhsOpsChangeOrderSeed {
  return {
    projectId: account.projectId,
    accountId: account.id,
    deviceId: must(account.deviceId),
    platformAccountId: account.platformAccountId,
    diagnosisId: null,
    proposalIds: [],
    batchIndex: 1,
    risk: "L1",
    fields: [{ field: "bio", baselineValue: "老简介", after: "新简介" }],
    status: "draft",
    ...overrides,
  };
}

/** Point activeChangeOrderId at `orderId`, as the change-order service would. */
async function activate(h: Harness, accountId: string, orderId: string) {
  await h.store.mutateTakeover(accountId, ({ account }) => ({
    account: {
      ...account,
      takeover: { ...takeoverOf(account), activeChangeOrderId: orderId },
    },
    result: null,
  }));
}

describe("takeover authorization and identity lock", () => {
  it("authorizes once, only an existing account bound to a phone", async () => {
    const h = harness();
    const { project, account } = await authorizedAccount(h);
    expect(takeoverOf(account)).toMatchObject({
      authorizedAt: new Date(START).toISOString(),
      authorizationNote: "客户书面授权",
      identityConfirmedAt: null,
      identitySource: null,
      legacyVerified: false,
    });
    expect(xhsOpsTakeoverStage(account, START)).toBe("authorized");
    await expect(
      h.store.authorizeTakeover(account.id, {
        expectedUpdatedAt: account.updatedAt,
        ownershipConfirmed: true,
      }),
    ).rejects.toMatchObject({ status: 409, message: "该账号已授权接管" });

    const fresh = await h.store.createAccount({
      projectId: project.id,
      label: "新号",
      deviceId: "phone-2",
    });
    await expect(
      h.store.authorizeTakeover(fresh.id, {
        expectedUpdatedAt: fresh.updatedAt,
        ownershipConfirmed: true,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "只有已有账号才能开始接管",
    });
    const unbound = await h.store.createAccount({
      projectId: project.id,
      entryMode: "existing",
      label: "未绑手机",
    });
    await expect(
      h.store.authorizeTakeover(unbound.id, {
        expectedUpdatedAt: unbound.updatedAt,
        ownershipConfirmed: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      h.store.authorizeTakeover(unbound.id, {
        expectedUpdatedAt: "stale",
        ownershipConfirmed: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await h.store.getAccount(unbound.id))?.takeover).toBeNull();
  });

  it("carries an old-flow verification over as a legacy identity lock (D5)", async () => {
    const h = harness();
    const project = await confirmedProject(h);
    const account = await h.store.createAccount({
      projectId: project.id,
      entryMode: "existing",
      label: "旧流程已核验",
      platformAccountId: XHS_ID,
      deviceId: "phone-1",
      interestPool: { core: ["护肤", "通勤"], extended: ["穿搭"], general: [] },
    });
    const verifiedAt = new Date(START - DAY).toISOString();
    const verified = must(
      await h.store.updateAccount(
        account.id,
        {},
        {
          profileApplyResult: {
            expectedProfileDraft: account.profileDraft,
            expectedPlatformAccountId: XHS_ID,
            appliedAt: verifiedAt,
            applyStatus: "applied",
            applyResult: "verified",
            verifiedAt,
            verifiedAccountId: XHS_ID,
            verificationTaskId: "legacy-verification",
          },
        },
      ),
    );
    const authorized = await h.store.authorizeTakeover(verified.id, {
      expectedUpdatedAt: verified.updatedAt,
      ownershipConfirmed: true,
    });
    expect(takeoverOf(authorized)).toMatchObject({
      legacyVerified: true,
      identityConfirmedAt: verifiedAt,
      identitySource: "legacy",
      identityTaskId: "legacy-verification",
    });
    // The schedule keeps running: no identity, baseline or plan issue.
    const issues = xhsOpsAccountNurtureIssues(authorized, project);
    expect(issues).not.toContain("请先读取并锁定手机上的小红书号");
    expect(issues).not.toContain("请先完成只读盘点并确认基线");
    expect(issues).not.toContain("请先确认接管方案（至少兴趣池与养号参数）");
  });

  it("confirms an identity only against the fresh server-side read", async () => {
    const h = harness();
    const { account } = await authorizedAccount(h);
    await expect(
      h.store.confirmTakeoverIdentity(account.id, {
        identityTaskId: "identity-task",
        platformAccountId: XHS_ID,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      h.store.recordTakeoverIdentityRead(account.id, {
        taskId: "identity-task",
        deviceId: "another-phone",
        screenshotUrl: null,
        readAccountId: XHS_ID,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // A read stamped no later than the authorization does not count.
    await h.store.recordTakeoverIdentityRead(account.id, {
      taskId: "identity-task",
      deviceId: "phone-1",
      screenshotUrl: null,
      readAccountId: XHS_ID,
    });
    await expect(
      h.store.confirmTakeoverIdentity(account.id, {
        identityTaskId: "identity-task",
        platformAccountId: XHS_ID,
      }),
    ).rejects.toMatchObject({ status: 409 });

    h.advance(MINUTE);
    await h.store.recordTakeoverIdentityRead(account.id, {
      taskId: "identity-task-2",
      deviceId: "phone-1",
      screenshotUrl: "/api/v1/media/identity.png",
      readAccountId: ` ${XHS_ID} `,
    });
    await expect(
      h.store.confirmTakeoverIdentity(account.id, {
        identityTaskId: "identity-task",
        platformAccountId: XHS_ID,
      }),
    ).rejects.toMatchObject({ status: 409 });
    h.advance(31 * MINUTE);
    await expect(
      h.store.confirmTakeoverIdentity(account.id, {
        identityTaskId: "identity-task-2",
        platformAccountId: XHS_ID,
      }),
    ).rejects.toMatchObject({ status: 409 });

    await h.store.recordTakeoverIdentityRead(account.id, {
      taskId: "identity-task-3",
      deviceId: "phone-1",
      screenshotUrl: "/api/v1/media/identity-3.png",
      readAccountId: XHS_ID,
    });
    h.advance(MINUTE);
    const mismatch = h.store.confirmTakeoverIdentity(account.id, {
      identityTaskId: "identity-task-3",
      platformAccountId: "typed-by-hand",
    });
    await expect(mismatch).rejects.toMatchObject({ status: 409 });
    // The 409 never echoes either 小红书号.
    const message = await mismatch.catch((error: Error) => error.message);
    expect(message).not.toContain(XHS_ID);
    expect(message).not.toContain("typed-by-hand");

    const locked = await h.store.confirmTakeoverIdentity(account.id, {
      identityTaskId: "identity-task-3",
      platformAccountId: "typed-by-hand",
      overrideRead: true,
    });
    expect(locked.platformAccountId).toBe("typed-by-hand");
    expect(takeoverOf(locked)).toMatchObject({
      identityConfirmedAt: new Date(START + 33 * MINUTE).toISOString(),
      identitySource: "takeover",
      identityTaskId: "identity-task-3",
      identityScreenshotUrl: "/api/v1/media/identity-3.png",
      pendingIdentity: null,
    });
    expect(xhsOpsTakeoverStage(locked, START)).toBe("identity_locked");
  });

  it("invalidates the lock, baseline, plan and unstarted orders when the 小红书号 changes", async () => {
    const h = harness();
    const { account, audit, diagnosis } = await diagnosedAccount(h);
    expect(takeoverOf(account).activeDiagnosisId).toBe(diagnosis.id);
    const statuses = [
      "draft",
      "awaiting_confirm",
      "prechecking",
      "applying",
      "verifying",
      "awaiting_manual_check",
    ] as const;
    const orders: XhsOpsChangeOrder[] = [];
    for (const status of statuses)
      orders.push(
        await h.store.createChangeOrder(orderSeed(account, { status })),
      );
    await activate(h, account.id, must(orders[1]).id);
    const before = must(await h.store.getAccount(account.id));

    // A PATCH cannot replace a takeover's 小红书号 (A5); the identity flow can.
    await expect(
      h.store.updateAccount(account.id, { platformAccountId: "someone-else" }),
    ).rejects.toMatchObject({ status: 409 });
    const changed = await relockIdentity(h, account.id, "someone-else");
    expect(takeoverOf(changed)).toMatchObject({
      authorizedAt: takeoverOf(before).authorizedAt,
      identitySource: "takeover",
      identityTaskId: "identity-someone-else",
      baselineAuditId: null,
      activeDiagnosisId: null,
      planConfirmedAt: null,
      activeChangeOrderId: null,
      latestAuditId: audit.id,
    });
    expect(xhsOpsTakeoverStage(changed, START)).toBe("identity_locked");
    // The diagnosis of the stale audit is kept as history, no longer active.
    expect((await h.store.getDiagnosis(diagnosis.id))?.status).toBe("ready");
    expect((await h.store.getAudit(audit.id))?.flags).toEqual([
      "identityStale",
    ]);
    const after = await Promise.all(
      orders.map(
        async (order) => (await h.store.getChangeOrder(order.id))?.status,
      ),
    );
    expect(after).toEqual([
      "cancelled",
      "cancelled",
      "draft",
      "interrupted",
      "interrupted",
      "awaiting_manual_check",
    ]);
  });

  it("keeps an applying order active through a re-lock to another 小红书号", async () => {
    const h = harness();
    const { account } = await baselinedAccount(h);
    const applying = await h.store.createChangeOrder(
      orderSeed(account, { status: "applying", applyTaskId: "apply-1" }),
    );
    await activate(h, account.id, applying.id);
    h.advance(MINUTE);
    await h.store.recordTakeoverIdentityRead(account.id, {
      taskId: "identity-relock",
      deviceId: "phone-1",
      screenshotUrl: null,
      readAccountId: "xhs-new",
    });
    h.advance(MINUTE);
    const relocked = await h.store.confirmTakeoverIdentity(account.id, {
      identityTaskId: "identity-relock",
      platformAccountId: "xhs-new",
    });
    expect(takeoverOf(relocked)).toMatchObject({
      identitySource: "takeover",
      identityTaskId: "identity-relock",
      baselineAuditId: null,
      activeChangeOrderId: applying.id,
    });
    expect(await h.store.getChangeOrder(applying.id)).toMatchObject({
      status: "interrupted",
      applyTaskId: "apply-1",
    });
  });
});

describe("takeover plan confirmation and revert", () => {
  it("confirms in one step: snapshot, L0 fields, untouched draft review and batched change orders", async () => {
    const h = harness();
    const { account, diagnosis } = await diagnosedAccount(h);
    const before = takeoverPlanFields(account);
    h.advance(MINUTE);
    const result = await h.store.confirmTakeoverPlan(
      diagnosis.id,
      { expectedUpdatedAt: diagnosis.updatedAt },
      { imageFieldsSupported: true },
    );
    const confirmedAt = new Date(START + 3 * MINUTE).toISOString();
    expect(result.account).toMatchObject({
      label: "通勤护肤日记",
      positioning: "上海通勤女生的护肤记录",
      persona: { occupation: "设计师", lifeStatus: "通勤上班" },
      interestPool: {
        core: ["通勤护肤", "敏感肌护理", "护肤成分"],
        extended: ["通勤穿搭"],
        general: ["咖啡"],
      },
      interaction: ESTABLISHED_CADENCE.interaction,
      browseDefaults: ESTABLISHED_CADENCE.browseDefaults,
      toneGuide: {
        summary: "真实通勤体验",
        commentStyle: "像朋友一样聊",
        ruleIds: ["TN-08"],
        sourceDiagnosisId: diagnosis.id,
        confirmedAt,
      },
      profileDraft: account.profileDraft,
      personaReviewedAt: account.personaReviewedAt,
    });
    expect(takeoverOf(result.account)).toMatchObject({
      planConfirmedAt: confirmedAt,
      maturity: "established",
      activeDiagnosisId: diagnosis.id,
      keepAllPublic: false,
      prePlanSnapshot: before,
    });
    expect(result.diagnosis).toMatchObject({
      status: "confirmed",
      confirmedAt,
    });
    expect(xhsOpsTakeoverStage(result.account, START)).toBe("maintaining");

    // §5.2 step 1: fixed batches, at most two fields each, never a field the
    // phone already shows.
    const drafts = [...result.changeOrders].sort(
      (left, right) => left.batchIndex - right.batchIndex,
    );
    expect(
      drafts.map((order) => ({
        batchIndex: order.batchIndex,
        risk: order.risk,
        status: order.status,
        proposalIds: order.proposalIds,
        fields: order.fields.map(({ field, baselineValue, after }) => ({
          field,
          baselineValue,
          after,
        })),
      })),
    ).toEqual([
      {
        batchIndex: 1,
        risk: "L1",
        status: "draft",
        proposalIds: ["P4"],
        fields: [
          {
            field: "bio",
            baselineValue: "老简介",
            after: "上海通勤 | 敏感肌护肤记录",
          },
        ],
      },
      {
        batchIndex: 2,
        risk: "L2",
        status: "draft",
        proposalIds: ["P6", "P8"],
        fields: [
          {
            field: "nickname",
            baselineValue: "老昵称",
            after: "通勤护肤日记",
          },
          {
            field: "region",
            baselineValue: "中国 上海 上海",
            after: "中国 北京 北京",
          },
        ],
      },
      {
        batchIndex: 3,
        risk: "L2",
        status: "draft",
        proposalIds: ["P7"],
        fields: [
          { field: "avatar", baselineValue: "", after: "清爽职场半身照方向" },
        ],
      },
    ]);
    expect(
      drafts.every(
        (order) =>
          order.platformAccountId === XHS_ID &&
          order.deviceId === "phone-1" &&
          order.diagnosisId === diagnosis.id,
      ),
    ).toBe(true);
    expect(result.skippedFields).toEqual([
      { proposalId: "P5", field: "occupation", reason: "手机上已是目标值" },
    ]);
    expect(await h.store.listChangeOrders({ accountId: account.id })).toEqual(
      result.changeOrders,
    );
  });

  it("fills only empty persona fields from the inferred persona when positioning is not adopted", async () => {
    const h = harness();
    const { diagnosis } = await diagnosedAccount(h, {
      account: {
        persona: { region: "北京" },
        interestPool: { core: ["护肤", "通勤"], extended: [], general: [] },
      },
      decisions: { P2: decided("reject"), P4: decided("defer") },
    });
    const { account, changeOrders } = await h.store.confirmTakeoverPlan(
      diagnosis.id,
      { expectedUpdatedAt: diagnosis.updatedAt },
    );
    expect(account.label).toBe("接管·测试机");
    expect(account.persona).toEqual({
      age: "28岁",
      gender: "女",
      region: "北京",
      occupation: "设计师",
      lifeStatus: "通勤上班",
    });
    expect(account.interestPool.core).toEqual(["护肤", "通勤"]);
    expect(changeOrders).toEqual([]);
  });

  it("re-checks the plan and its preconditions before writing anything", async () => {
    const h = harness();
    const { account, diagnosis } = await diagnosedAccount(h, {
      decisions: { P1: decided("reject") },
    });
    // The established cadence needs two keywords and the pool has none.
    await expect(
      h.store.confirmTakeoverPlan(diagnosis.id, {
        expectedUpdatedAt: diagnosis.updatedAt,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("至少需要 2 个兴趣词"),
    });
    await expect(
      h.store.confirmTakeoverPlan(diagnosis.id, { expectedUpdatedAt: "stale" }),
    ).rejects.toMatchObject({ status: 409 });

    const edited = must(
      await h.store.updateDiagnosis(diagnosis.id, (current) => ({
        ...current,
        decisions: {
          P1: { decision: "edit", decidedAt: new Date(START).toISOString() },
        },
      })),
    );
    await expect(
      h.store.confirmTakeoverPlan(diagnosis.id, {
        expectedUpdatedAt: edited.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const badEdit = must(
      await h.store.updateDiagnosis(diagnosis.id, (current) => ({
        ...current,
        decisions: {
          P1: {
            decision: "edit",
            edited: { core: ["只有一个词"] },
            decidedAt: new Date(START).toISOString(),
          },
        },
      })),
    );
    await expect(
      h.store.confirmTakeoverPlan(diagnosis.id, {
        expectedUpdatedAt: badEdit.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 400 });

    const adopted = must(
      await h.store.updateDiagnosis(diagnosis.id, (current) => ({
        ...current,
        decisions: { P1: decided("adopt") },
      })),
    );
    await h.store.pauseTakeover(account.id, {
      code: "manual",
      reason: "运营手动暂停",
    });
    await expect(
      h.store.confirmTakeoverPlan(adopted.id, {
        expectedUpdatedAt: adopted.updatedAt,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "账号暂停中：运营手动暂停",
    });
    const paused = must(await h.store.getAccount(account.id));
    await h.store.mutateTakeover(account.id, ({ account: current }) => ({
      account: {
        ...current,
        takeover: { ...takeoverOf(current), safetyPause: null },
      },
      result: null,
    }));

    // A newer audit makes this diagnosis stale.
    const newer = await h.store.createAudit(auditSeed(account));
    await h.store.mutateTakeover(account.id, ({ account: current }) => ({
      account: {
        ...current,
        takeover: { ...takeoverOf(current), latestAuditId: newer.id },
      },
      result: null,
    }));
    await expect(
      h.store.confirmTakeoverPlan(adopted.id, {
        expectedUpdatedAt: adopted.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(takeoverPlanFields(paused)).toEqual(takeoverPlanFields(account));
    expect(takeoverOf(paused).planConfirmedAt).toBeNull();
    expect(await h.store.listChangeOrders({ accountId: account.id })).toEqual(
      [],
    );
    expect((await h.store.getDiagnosis(diagnosis.id))?.status).toBe("ready");
  });

  it("drafts nothing for 「全部保留，只做维护」 and skips images on phones below Android 10", async () => {
    const h = harness();
    const kept = await diagnosedAccount(h);
    const keepAll = await h.store.confirmTakeoverPlan(kept.diagnosis.id, {
      expectedUpdatedAt: kept.diagnosis.updatedAt,
      keepAllPublic: true,
    });
    expect(takeoverOf(keepAll.account).keepAllPublic).toBe(true);
    expect(keepAll.changeOrders).toEqual([]);

    const h2 = harness();
    const old = await diagnosedAccount(h2);
    const noImages = await h2.store.confirmTakeoverPlan(old.diagnosis.id, {
      expectedUpdatedAt: old.diagnosis.updatedAt,
    });
    expect(
      noImages.changeOrders.flatMap((order) =>
        order.fields.map((field) => field.field),
      ),
    ).not.toContain("avatar");
    expect(noImages.skippedFields).toContainEqual({
      proposalId: "P7",
      field: "avatar",
      reason: XHS_TAKEOVER_IMAGE_UNSUPPORTED_MESSAGE,
    });

    // A phone that could not be asked keeps the caller's reason, not 版本过低.
    const h3 = harness();
    const offline = await diagnosedAccount(h3);
    const unreachable = await h3.store.confirmTakeoverPlan(
      offline.diagnosis.id,
      { expectedUpdatedAt: offline.diagnosis.updatedAt },
      {
        imageFieldsSupported: false,
        imageFieldsSkipReason: XHS_TAKEOVER_IMAGE_PHONE_UNREACHABLE_MESSAGE,
      },
    );
    expect(unreachable.skippedFields).toContainEqual({
      proposalId: "P7",
      field: "avatar",
      reason: XHS_TAKEOVER_IMAGE_PHONE_UNREACHABLE_MESSAGE,
    });
    expect(
      unreachable.changeOrders.flatMap((order) =>
        order.fields.map((field) => field.field),
      ),
    ).not.toContain("avatar");
  });

  it("keeps the skipped fields on the takeover until an order for the field exists, and drops them with the plan", async () => {
    const h = harness();
    const { account, diagnosis } = await diagnosedAccount(h);
    const confirmed = await h.store.confirmTakeoverPlan(diagnosis.id, {
      expectedUpdatedAt: diagnosis.updatedAt,
    });
    const skipped = [
      { proposalId: "P5", field: "occupation", reason: "手机上已是目标值" },
      {
        proposalId: "P7",
        field: "avatar",
        reason: XHS_TAKEOVER_IMAGE_UNSUPPORTED_MESSAGE,
      },
    ];
    expect(confirmed.skippedFields).toEqual(skipped);
    expect(takeoverOf(confirmed.account).skippedFields).toEqual(skipped);
    // A card mounted later — after a restart too — reads them back.
    expect(
      takeoverOf(await h.reopen().getAccount(account.id)).skippedFields,
    ).toEqual(skipped);

    // An order for a field nobody skipped leaves the list alone…
    h.advance(MINUTE);
    await h.store.createChangeOrder(
      orderSeed(confirmed.account, {
        batchIndex: 1,
        fields: [
          { field: "bio", baselineValue: "老简介", after: "另一版简介" },
        ],
      }),
    );
    expect(await h.store.getAccount(account.id)).toEqual(confirmed.account);
    // …an order for a skipped one takes its entry off.
    h.advance(MINUTE);
    await h.store.createChangeOrder(
      orderSeed(confirmed.account, {
        batchIndex: 3,
        risk: "L2",
        fields: [
          { field: "avatar", baselineValue: "", after: "清爽职场半身照方向" },
        ],
      }),
    );
    const afterOrder = must(await h.store.getAccount(account.id));
    expect(takeoverOf(afterOrder).skippedFields).toEqual([skipped[0]]);
    expect(afterOrder.updatedAt > confirmed.account.updatedAt).toBe(true);

    // The plan goes, so does what it could not draft.
    const reverted = await h.store.revertTakeoverPlan(account.id, {
      expectedUpdatedAt: afterOrder.updatedAt,
    });
    expect(takeoverOf(reverted.account).skippedFields).toEqual([]);

    // A new confirmation writes its own list; an identity change drops it.
    const again = await h.store.confirmTakeoverPlan(diagnosis.id, {
      expectedUpdatedAt: must(reverted.diagnosis).updatedAt,
    });
    expect(takeoverOf(again.account).skippedFields).toEqual(skipped);
    const relocked = await relockIdentity(h, account.id, "xhs-other-002");
    expect(takeoverOf(relocked)).toMatchObject({
      planConfirmedAt: null,
      skippedFields: [],
    });
  });

  it("reverts to the exact pre-plan snapshot, cancels unstarted orders and keeps the first snapshot on re-confirm", async () => {
    const h = harness();
    const { account, diagnosis } = await diagnosedAccount(h, {
      account: {
        label: "原定位",
        positioning: "原来的穿搭方向",
        persona: { age: "26岁", region: "杭州" },
        personaTags: { vertical: ["穿搭"], general: ["咖啡"] },
        interestPool: {
          core: ["穿搭", "通勤"],
          extended: ["探店"],
          general: [],
        },
        interaction: {
          like: { enabled: true, dailyCap: 3, ratioPercent: 6 },
          collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
          follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
          comment: { enabled: false, dailyCap: 1 },
        },
        browseDefaults: { dwellSecMin: 12, dailyTargetPosts: 30 },
      },
    });
    const before = takeoverPlanFields(account);
    const confirmed = await h.store.confirmTakeoverPlan(
      diagnosis.id,
      { expectedUpdatedAt: diagnosis.updatedAt },
      { imageFieldsSupported: true },
    );
    const [first] = [...confirmed.changeOrders].sort(
      (left, right) => left.batchIndex - right.batchIndex,
    );
    // The change-order service prechecked the first batch.
    await h.store.updateChangeOrder(must(first).id, (order) => ({
      ...order,
      status: "awaiting_confirm",
    }));
    await activate(h, account.id, must(first).id);

    await h.store.updateChangeOrder(must(first).id, (order) => ({
      ...order,
      status: "applying",
    }));
    const locked = must(await h.store.getAccount(account.id));
    await expect(
      h.store.revertTakeoverPlan(account.id, {
        expectedUpdatedAt: locked.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await h.store.updateChangeOrder(must(first).id, (order) => ({
      ...order,
      status: "awaiting_confirm",
    }));

    await expect(
      h.store.revertTakeoverPlan(account.id, { expectedUpdatedAt: "stale" }),
    ).rejects.toMatchObject({ status: 409 });
    const reverted = await h.store.revertTakeoverPlan(account.id, {
      expectedUpdatedAt: locked.updatedAt,
    });
    expect(takeoverPlanFields(reverted.account)).toEqual(before);
    expect(reverted.account.profileDraft).toEqual(account.profileDraft);
    expect(takeoverOf(reverted.account)).toMatchObject({
      planConfirmedAt: null,
      maturity: null,
      keepAllPublic: false,
      activeChangeOrderId: null,
      prePlanSnapshot: before,
    });
    expect(reverted.diagnosis).toMatchObject({
      id: diagnosis.id,
      status: "ready",
      confirmedAt: null,
    });
    expect(reverted.changeOrders.map((order) => order.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);

    // An edit after the revert, then the plan again: the snapshot stays the
    // state before the takeover.
    const renamed = must(
      await h.store.updateAccount(account.id, { label: "运营改名" }),
    );
    const again = await h.store.confirmTakeoverPlan(diagnosis.id, {
      expectedUpdatedAt: must(reverted.diagnosis).updatedAt,
    });
    expect(renamed.label).toBe("运营改名");
    expect(takeoverOf(again.account).prePlanSnapshot).toEqual(before);
    expect(again.account.label).toBe("通勤护肤日记");
  });

  it("reopens the plan's own diagnosis on revert even after a newer version became active", async () => {
    const h = harness();
    const { account, audit, diagnosis } = await diagnosedAccount(h);
    const confirmed = await h.store.confirmTakeoverPlan(diagnosis.id, {
      expectedUpdatedAt: diagnosis.updatedAt,
    });
    const newer = await h.store.createDiagnosis(
      { ...diagnosisSeed(account, audit.id), version: 2 },
      { activate: true },
    );
    const current = must(await h.store.getAccount(account.id));
    expect(current.updatedAt > confirmed.account.updatedAt).toBe(true);
    const reverted = await h.store.revertTakeoverPlan(account.id, {
      expectedUpdatedAt: current.updatedAt,
    });
    expect(reverted.diagnosis).toMatchObject({ id: newer.id, status: "ready" });
    expect(await h.store.getDiagnosis(diagnosis.id)).toMatchObject({
      status: "superseded",
      confirmedAt: null,
    });
  });

  it("drafts no order for a field an earlier plan's order already changed on the phone", async () => {
    const h = harness();
    const { account, diagnosis } = await diagnosedAccount(h);
    const first = await h.store.confirmTakeoverPlan(
      diagnosis.id,
      { expectedUpdatedAt: diagnosis.updatedAt },
      { imageFieldsSupported: true },
    );
    const bioOrder = must(
      first.changeOrders.find((order) => order.batchIndex === 1),
    );
    // The change-order service applied and verified the bio batch.
    await h.store.updateChangeOrder(bioOrder.id, (order) => ({
      ...order,
      status: "observing",
      confirmedAt: order.updatedAt,
      applyTaskId: "apply-bio",
      fields: order.fields.map((field) => ({
        ...field,
        before: field.baselineValue,
        outcome: "verified" as const,
      })),
    }));
    const reverted = await h.store.revertTakeoverPlan(account.id, {
      expectedUpdatedAt: first.account.updatedAt,
    });
    const again = await h.store.confirmTakeoverPlan(
      diagnosis.id,
      { expectedUpdatedAt: must(reverted.diagnosis).updatedAt },
      { imageFieldsSupported: true },
    );
    expect(again.skippedFields).toContainEqual({
      proposalId: "P4",
      field: "bio",
      reason: "手机上已是目标值",
    });
    const drafts = again.changeOrders.filter(
      (order) => order.status === "draft",
    );
    expect(drafts.map((order) => order.batchIndex).sort()).toEqual([2, 3]);
    expect((await h.store.getChangeOrder(bioOrder.id))?.status).toBe(
      "observing",
    );
  });

  it("re-confirming a newer diagnosis cancels the old plan drafts but keeps rollback orders", async () => {
    const h = harness();
    const { account, audit, diagnosis } = await diagnosedAccount(h);
    const first = await h.store.confirmTakeoverPlan(diagnosis.id, {
      expectedUpdatedAt: diagnosis.updatedAt,
    });
    const rollback = await h.store.createChangeOrder(
      orderSeed(account, { rollbackOfId: "old-order" }),
    );
    const second = await h.store.createDiagnosis(
      { ...diagnosisSeed(account, audit.id), version: 2 },
      { activate: true },
    );
    expect((await h.store.getDiagnosis(diagnosis.id))?.status).toBe(
      "confirmed",
    );
    const again = await h.store.confirmTakeoverPlan(second.id, {
      expectedUpdatedAt: second.updatedAt,
    });
    const statuses = new Map(
      again.changeOrders.map((order) => [order.id, order.status]),
    );
    for (const order of first.changeOrders)
      expect(statuses.get(order.id)).toBe("cancelled");
    expect(statuses.get(rollback.id)).toBe("draft");
    expect(
      again.changeOrders.filter(
        (order) => order.diagnosisId === second.id && order.status === "draft",
      ),
    ).toHaveLength(2);
    expect(takeoverOf(again.account).activeDiagnosisId).toBe(second.id);
  });
});

describe("takeover pause, resume and device hold", () => {
  it("cools risk pauses down for 48 hours and needs a reason to resume them", async () => {
    const h = harness();
    const { account } = await authorizedAccount(h);
    const paused = await h.store.pauseTakeover(account.id, {
      code: "rate_limited",
      reason: "手机提示操作频繁",
      sourceRef: "run-1",
    });
    const pause = must(takeoverOf(paused).safetyPause);
    expect(pause).toEqual({
      code: "rate_limited",
      reason: "手机提示操作频繁",
      sourceRef: "run-1",
      since: new Date(START).toISOString(),
      resumableAfter: new Date(START + 48 * HOUR).toISOString(),
    });
    // A weaker pause does not mask the cooldown.
    const unchanged = await h.store.pauseTakeover(account.id, {
      code: "manual",
      reason: "顺手暂停",
    });
    expect(takeoverOf(unchanged).safetyPause).toEqual(pause);
    expect(unchanged.updatedAt).toBe(paused.updatedAt);

    await expect(
      h.store.assertTakeoverResumable(account.id, {
        expectedUpdatedAt: paused.updatedAt,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "恢复这类暂停需要填写原因",
    });
    await expect(
      h.store.assertTakeoverResumable(account.id, {
        expectedUpdatedAt: paused.updatedAt,
        reason: "已人工确认",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("冷却期未结束"),
    });
    h.advance(48 * HOUR + MINUTE);
    const check = await h.store.assertTakeoverResumable(account.id, {
      expectedUpdatedAt: paused.updatedAt,
      reason: "已人工确认",
    });
    expect(check.gateRequired).toBe(false);
    const resumed = await h.store.resumeTakeover(account.id, {
      pauseSince: check.pause.since,
      reason: "已人工确认",
      gateReady: null,
    });
    expect(takeoverOf(resumed).safetyPause).toBeNull();
  });

  it("lifts gate-backed pauses only once the identity gate is ready", async () => {
    const h = harness();
    const { account } = await authorizedAccount(h);
    const paused = await h.store.pauseTakeover(account.id, {
      code: "login_required",
      reason: "手机未登录",
    });
    expect(takeoverOf(paused).safetyPause?.resumableAfter).toBeNull();
    const check = await h.store.assertTakeoverResumable(account.id, {
      expectedUpdatedAt: paused.updatedAt,
    });
    expect(check.gateRequired).toBe(true);
    await expect(
      h.store.resumeTakeover(account.id, {
        pauseSince: check.pause.since,
        gateReady: false,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // A stronger pause raised while the gate ran is not lifted by the old check.
    h.advance(MINUTE);
    await h.store.pauseTakeover(account.id, {
      code: "account_mismatch",
      reason: "手机上不是这个号",
    });
    await expect(
      h.store.resumeTakeover(account.id, {
        pauseSince: check.pause.since,
        gateReady: true,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "暂停状态已变化，请刷新后重试",
    });
    const current = must(await h.store.getAccount(account.id));
    const recheck = await h.store.assertTakeoverResumable(account.id, {
      expectedUpdatedAt: current.updatedAt,
    });
    const resumed = await h.store.resumeTakeover(account.id, {
      pauseSince: recheck.pause.since,
      gateReady: true,
    });
    expect(takeoverOf(resumed).safetyPause).toBeNull();

    const failed = await h.store.pauseTakeover(account.id, {
      code: "observation_failed",
      reason: "复查判定失败",
      sourceRef: "order-1",
    });
    await expect(
      h.store.assertTakeoverResumable(account.id, {
        expectedUpdatedAt: failed.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      h.store.assertTakeoverResumable(account.id, {
        expectedUpdatedAt: failed.updatedAt,
        reason: "已回滚",
      }),
    ).resolves.toMatchObject({ gateRequired: true });
  });

  it("keeps an observation failure a stronger pause masks, and raises it again once that pause is resumed (B6)", async () => {
    const h = harness();
    const { account } = await authorizedAccount(h);
    // The observation review's audit hits 操作频繁 first; the review fails after it.
    const limited = await h.store.pauseTakeover(account.id, {
      code: "rate_limited",
      reason: "手机提示操作频繁",
      sourceRef: "audit-review",
    });
    const cooldown = must(takeoverOf(limited).safetyPause);
    h.advance(MINUTE);
    const failedAt = new Date(START + MINUTE).toISOString();
    const masked = await h.store.pauseTakeover(account.id, {
      code: "observation_failed",
      reason: "复查判定失败：简介回读与目标不一致",
      sourceRef: "order-1",
    });
    expect(takeoverOf(masked).safetyPause).toEqual(cooldown);
    const pending = {
      reason: "复查判定失败：简介回读与目标不一致",
      sourceRef: "order-1",
      since: failedAt,
    };
    expect(takeoverOf(masked).pendingObservationFailure).toEqual(pending);
    expect(
      takeoverOf(await h.reopen().getAccount(account.id))
        .pendingObservationFailure,
    ).toEqual(pending);
    // A weaker pause on top changes nothing.
    const unchanged = await h.store.pauseTakeover(account.id, {
      code: "manual",
      reason: "顺手暂停",
    });
    expect(unchanged.updatedAt).toBe(masked.updatedAt);

    // Resuming the cooldown puts nothing back to work, so no gate runs for it.
    h.advance(48 * HOUR);
    const check = await h.store.assertTakeoverResumable(account.id, {
      expectedUpdatedAt: masked.updatedAt,
      reason: "冷却期已过",
    });
    expect(check.pause.code).toBe("rate_limited");
    expect(check.gateRequired).toBe(false);
    const resumed = await h.store.resumeTakeover(account.id, {
      pauseSince: check.pause.since,
      reason: "冷却期已过",
      gateReady: null,
    });
    expect(takeoverOf(resumed)).toMatchObject({
      safetyPause: {
        code: "observation_failed",
        reason: pending.reason,
        sourceRef: "order-1",
        since: failedAt,
        resumableAfter: null,
      },
      pendingObservationFailure: null,
    });
    expect(takeoverOf(resumed).resumeHistory).toEqual([
      expect.objectContaining({
        code: "rate_limited",
        sourceRef: "audit-review",
        reason: "冷却期已过",
      }),
    ]);
    expect(xhsOpsAccountNurtureIssues(resumed, null)).toContain(
      `账号暂停中：${pending.reason}`,
    );

    // The raised failure needs its own 「恢复」: a written reason and the gate.
    await expect(
      h.store.assertTakeoverResumable(account.id, {
        expectedUpdatedAt: resumed.updatedAt,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "恢复这类暂停需要填写原因",
    });
    const second = await h.store.assertTakeoverResumable(account.id, {
      expectedUpdatedAt: resumed.updatedAt,
      reason: "已回滚简介",
    });
    expect(second.gateRequired).toBe(true);
    await expect(
      h.store.resumeTakeover(account.id, {
        pauseSince: second.pause.since,
        reason: "已回滚简介",
        gateReady: false,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const lifted = await h.store.resumeTakeover(account.id, {
      pauseSince: second.pause.since,
      reason: "已回滚简介",
      gateReady: true,
      gateTaskId: "gate-1",
    });
    expect(takeoverOf(lifted)).toMatchObject({
      safetyPause: null,
      pendingObservationFailure: null,
    });
    expect(takeoverOf(lifted).resumeHistory.at(-1)).toMatchObject({
      code: "observation_failed",
      sourceRef: "order-1",
      gateTaskId: "gate-1",
    });
  });

  it("keeps the observation failure a stronger pause replaces (B6)", async () => {
    const h = harness();
    const { account } = await authorizedAccount(h);
    const failed = await h.store.pauseTakeover(account.id, {
      code: "observation_failed",
      reason: "复查判定失败",
      sourceRef: "order-2",
    });
    const failure = must(takeoverOf(failed).safetyPause);
    h.advance(MINUTE);
    const restricted = await h.store.pauseTakeover(account.id, {
      code: "account_restricted",
      reason: "账号受限",
      sourceRef: "run-9",
    });
    expect(takeoverOf(restricted)).toMatchObject({
      safetyPause: { code: "account_restricted", sourceRef: "run-9" },
      pendingObservationFailure: {
        reason: "复查判定失败",
        sourceRef: "order-2",
        since: failure.since,
      },
    });
    h.advance(48 * HOUR);
    const check = await h.store.assertTakeoverResumable(account.id, {
      expectedUpdatedAt: restricted.updatedAt,
      reason: "已申诉解除",
    });
    expect(check.gateRequired).toBe(false);
    const resumed = await h.store.resumeTakeover(account.id, {
      pauseSince: check.pause.since,
      reason: "已申诉解除",
      gateReady: null,
    });
    expect(takeoverOf(resumed)).toMatchObject({
      safetyPause: { ...failure, resumableAfter: null },
      pendingObservationFailure: null,
    });
  });

  it("keeps every lift in resumeHistory, the newest 20, across a restart", async () => {
    const h = harness();
    const { account } = await authorizedAccount(h);
    const lift = async (round: number) => {
      h.advance(MINUTE);
      const paused = await h.store.pauseTakeover(account.id, {
        code: round === 0 ? "observation_failed" : "manual",
        reason: `第 ${round} 次暂停`,
        sourceRef: `order-${round}`,
      });
      const check = await h.store.assertTakeoverResumable(account.id, {
        expectedUpdatedAt: paused.updatedAt,
        reason: `  第 ${round} 次恢复  `,
      });
      return h.store.resumeTakeover(account.id, {
        pauseSince: check.pause.since,
        reason: `  第 ${round} 次恢复  `,
        gateReady: true,
        gateTaskId: `gate-${round}`,
      });
    };
    const first = await lift(0);
    expect(takeoverOf(first).resumeHistory).toEqual([
      {
        at: new Date(START + MINUTE).toISOString(),
        code: "observation_failed",
        since: new Date(START + MINUTE).toISOString(),
        sourceRef: "order-0",
        pauseReason: "第 0 次暂停",
        reason: "第 0 次恢复",
        gateTaskId: "gate-0",
      },
    ]);
    // A refused resume writes nothing.
    h.advance(MINUTE);
    const paused = await h.store.pauseTakeover(account.id, {
      code: "manual",
      reason: "再停一次",
    });
    await expect(
      h.store.resumeTakeover(account.id, {
        pauseSince: must(takeoverOf(paused).safetyPause).since,
        gateReady: false,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      takeoverOf(await h.store.getAccount(account.id)).resumeHistory,
    ).toHaveLength(1);
    const check = await h.store.assertTakeoverResumable(account.id, {
      expectedUpdatedAt: paused.updatedAt,
    });
    const second = await h.store.resumeTakeover(account.id, {
      pauseSince: check.pause.since,
      gateReady: true,
    });
    expect(takeoverOf(second).resumeHistory.at(-1)).toMatchObject({
      code: "manual",
      sourceRef: "",
      pauseReason: "再停一次",
      reason: "",
      gateTaskId: null,
    });

    let last = first;
    for (let round = 1; round <= 20; round += 1) last = await lift(round);
    // 22 lifts in all: the first and the reasonless one fell off the front.
    const history = takeoverOf(last).resumeHistory;
    expect(history).toHaveLength(20);
    expect(history[0]?.reason).toBe("第 1 次恢复");
    expect(history.at(-1)).toMatchObject({
      code: "manual",
      reason: "第 20 次恢复",
      gateTaskId: "gate-20",
    });
    expect(
      takeoverOf(await h.reopen().getAccount(account.id)).resumeHistory,
    ).toEqual(history);
  });

  it("holds the device until a human releases it, and only then gives the kept lock back", async () => {
    const h = harness();
    const { account } = await authorizedAccount(h);
    const lease = await h.store.acquireExclusiveDeviceBinding(
      account.id,
      "phone-1",
      { purpose: "audit" },
    );
    const held = await h.store.holdTakeoverDevice(account.id, {
      taskId: "task-1",
      sourceRef: "audit-1",
    });
    const again = await h.store.holdTakeoverDevice(account.id, {
      taskId: "task-2",
      sourceRef: "audit-2",
    });
    expect(takeoverOf(again).deviceHold).toEqual({
      taskId: "task-1",
      sourceRef: "audit-1",
      since: new Date(START).toISOString(),
    });
    expect(xhsOpsTakeoverStage(again, START)).toBe("device_hold");
    await h.store.pauseTakeover(account.id, { code: "manual", reason: "暂停" });
    const paused = must(await h.store.getAccount(account.id));
    await expect(
      h.store.assertTakeoverResumable(account.id, {
        expectedUpdatedAt: paused.updatedAt,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("停止未确认"),
    });
    await expect(
      h.store.releaseTakeoverDeviceHold(account.id, {
        expectedUpdatedAt: held.updatedAt,
        stoppedOnPhone: true,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const released = await h.store.releaseTakeoverDeviceHold(account.id, {
      expectedUpdatedAt: paused.updatedAt,
      stoppedOnPhone: true,
    });
    expect(takeoverOf(released).deviceHold).toBeNull();
    // The failed step's lock went with the hold; its late release is a no-op.
    const next = await h.store.acquireExclusiveDeviceBinding(
      account.id,
      "phone-1",
    );
    lease();
    await expect(
      h.store.acquireExclusiveDeviceBinding(account.id, "phone-1"),
    ).rejects.toMatchObject({ status: 409 });
    next();
    await expect(
      h.store.releaseTakeoverDeviceHold(account.id, {
        expectedUpdatedAt: released.updatedAt,
        stoppedOnPhone: true,
      }),
    ).rejects.toMatchObject({ status: 409, message: "没有待解除的手机任务" });
  });

  it("refuses takeover state on an account that never started a takeover", async () => {
    const h = harness();
    const project = await h.store.createProject({ name: "旧行" });
    const row = await h.store.createAccount({
      projectId: project.id,
      entryMode: "existing",
      label: "未接管的旧行",
      deviceId: "phone-9",
    });
    await expect(
      h.store.pauseTakeover(row.id, { code: "login_required", reason: "x" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      h.store.holdTakeoverDevice(row.id, { taskId: "t", sourceRef: "run" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("takeover records", () => {
  it("creates, lists and updates audits, diagnoses and orders with optimistic checks", async () => {
    const h = harness();
    const { account } = await lockedAccount(h);
    const audit = await h.store.createAudit(auditSeed(account));
    await expect(
      h.store.createAudit({ ...auditSeed(account), accountId: "missing" }),
    ).rejects.toMatchObject({ status: 404 });
    h.advance(MINUTE);
    const updated = must(
      await h.store.updateAudit(
        audit.id,
        (current) => ({ ...current, reason: "人工复核" }),
        { expectedUpdatedAt: audit.updatedAt },
      ),
    );
    expect(updated.updatedAt > audit.updatedAt).toBe(true);
    await expect(
      h.store.updateAudit(audit.id, (current) => current, {
        expectedUpdatedAt: audit.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await h.store.updateAudit("missing", (current) => current),
    ).toBeNull();

    const first = await h.store.createDiagnosis(
      diagnosisSeed(account, audit.id),
      { activate: true },
    );
    h.advance(MINUTE);
    const second = await h.store.createDiagnosis(
      { ...diagnosisSeed(account, audit.id), version: 2, parentId: first.id },
      { activate: true },
    );
    expect(
      (await h.store.listDiagnoses({ accountId: account.id })).map((entry) => [
        entry.id,
        entry.status,
      ]),
    ).toEqual([
      [second.id, "ready"],
      [first.id, "superseded"],
    ]);
    expect(
      takeoverOf(await h.store.getAccount(account.id)).activeDiagnosisId,
    ).toBe(second.id);
    await expect(
      h.store.updateDiagnosis(second.id, (current) => current, {
        expectedUpdatedAt: "stale",
      }),
    ).rejects.toMatchObject({ status: 409 });

    const order = await h.store.createChangeOrder(orderSeed(account));
    await expect(
      h.store.updateChangeOrder(
        order.id,
        (current) => ({ ...current, status: "cancelled" }),
        { expectedUpdatedAt: "stale" },
      ),
    ).rejects.toMatchObject({ status: 409 });
    const cancelled = await h.store.updateChangeOrder(order.id, (current) => ({
      ...current,
      status: "cancelled",
      accountId: "forged",
    }));
    expect(cancelled).toMatchObject({
      status: "cancelled",
      accountId: account.id,
    });
  });

  it("writes a compound takeover transition atomically and only on the account's own records", async () => {
    const h = harness();
    const { account } = await lockedAccount(h);
    const order = await h.store.createChangeOrder(orderSeed(account));
    const other = await authorizedAccount(h, { deviceId: "phone-2" });
    const foreign = await h.store.createChangeOrder(orderSeed(other.account));

    const written = await h.store.mutateTakeover(
      account.id,
      ({ account: current, changeOrders, today }) => {
        const own = must(changeOrders[0]);
        return {
          account: {
            ...current,
            takeover: {
              ...takeoverOf(current),
              activeChangeOrderId: own.id,
              noNurtureDates: [today],
            },
          },
          // A record never moves to another project.
          changeOrders: [
            { ...own, status: "prechecking", projectId: "forged-project" },
          ],
          result: own.id,
        };
      },
    );
    expect(written.result).toBe(order.id);
    expect(written.changeOrders).toEqual([
      { ...order, status: "prechecking", updatedAt: expect.any(String) },
    ]);
    expect(must(written.changeOrders[0]).updatedAt > order.updatedAt).toBe(
      true,
    );
    expect(takeoverOf(written.account).activeChangeOrderId).toBe(order.id);
    expect(await h.store.getAccount(account.id)).toEqual(written.account);

    await expect(
      h.store.mutateTakeover(account.id, () => ({
        changeOrders: [{ ...foreign, status: "cancelled" }],
        result: null,
      })),
    ).rejects.toThrow("mutateTakeover");
    await expect(
      h.store.mutateTakeover(account.id, () => ({
        audits: [
          xhsOpsAccountAuditSchema.parse({
            ...auditSeed(account),
            id: "never-created",
            createdAt: written.account.updatedAt,
            updatedAt: written.account.updatedAt,
          }),
        ],
        result: null,
      })),
    ).rejects.toThrow("mutateTakeover");
    await expect(
      h.store.mutateTakeover(account.id, () => ({ result: null }), {
        expectedUpdatedAt: account.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await h.store.getChangeOrder(foreign.id))?.status).toBe("draft");
  });

  it("keeps the baseline plus the 12 newest audits of an account", async () => {
    const h = harness();
    const { account } = await lockedAccount(h);
    h.at(START - 20 * DAY);
    const ids: string[] = [];
    for (let index = 0; index < 15; index += 1) {
      ids.push((await h.store.createAudit(auditSeed(account))).id);
      // A day apart: only the newest one is "today" and protected for that.
      h.advance(DAY);
      if (index === 0)
        await h.store.mutateTakeover(account.id, ({ account: current }) => ({
          account: {
            ...current,
            takeover: {
              ...takeoverOf(current),
              baselineAuditId: must(ids[0]),
            },
          },
          result: null,
        }));
    }
    const kept = (await h.store.listAudits({ accountId: account.id })).map(
      (audit) => audit.id,
    );
    expect(kept).toHaveLength(13);
    expect(kept).toContain(ids[0]);
    expect(kept).not.toContain(ids[1]);
    expect(kept).not.toContain(ids[2]);
    expect(kept.slice(0, 12)).toEqual(ids.slice(3).reverse());
  });

  it("caps the collections without dropping protected records", () => {
    const now = new Date(START).toISOString();
    const old = (days: number) => new Date(START - days * DAY).toISOString();
    const audit = (
      index: number,
      overrides: Partial<XhsOpsAccountAudit> = {},
    ) =>
      xhsOpsAccountAuditSchema.parse({
        id: `a-${index}`,
        projectId: "p",
        accountId: `acct-${index % 40}`,
        deviceId: "d",
        platformAccountId: "",
        status: "completed",
        startedAt: old(30 - index / 100),
        createdAt: old(30 - index / 100),
        updatedAt: old(30 - index / 100),
        ...overrides,
      });
    const audits = Array.from({ length: XHS_OPS_MAX_AUDITS + 5 }, (_, index) =>
      audit(index, index < 3 ? { status: "running" } : {}),
    );
    const keptAudits = evictAudits(audits, [], now);
    expect(keptAudits).toHaveLength(XHS_OPS_MAX_AUDITS);
    expect(keptAudits.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["a-0", "a-1", "a-2"]),
    );
    expect(keptAudits.map((entry) => entry.id)).not.toContain("a-3");
    expect(() =>
      evictAudits(
        Array.from({ length: XHS_OPS_MAX_AUDITS + 1 }, (_, index) =>
          audit(index, { status: "running" }),
        ),
        [],
        now,
      ),
    ).toThrow("盘点记录已达上限");

    const diagnosis = (
      index: number,
      status: XhsOpsAccountDiagnosis["status"],
    ) =>
      xhsOpsAccountDiagnosisSchema.parse({
        id: `d-${index}`,
        projectId: "p",
        accountId: index < 10 ? "acct-x" : `acct-${index}`,
        auditId: "a",
        version: 1,
        status,
        playbookVersion: "v",
        facts: { tier: "starter" },
        cadence: { browseDefaults: {}, interaction: {}, rationale: [] },
        generator: { botId: "b", model: null },
        createdAt: old(10 - index / 100),
        updatedAt: old(10 - index / 100),
      });
    // One account: confirmed versions stay, plus the five newest others.
    const perAccount = evictDiagnoses(
      Array.from({ length: 10 }, (_, index) =>
        diagnosis(index, index < 2 ? "confirmed" : "superseded"),
      ),
      [],
    ).map((entry) => entry.id);
    expect(perAccount).toEqual([
      "d-0",
      "d-1",
      "d-5",
      "d-6",
      "d-7",
      "d-8",
      "d-9",
    ]);
    const global = evictDiagnoses(
      Array.from({ length: XHS_OPS_MAX_DIAGNOSES + 12 }, (_, index) =>
        diagnosis(index + 10, "ready"),
      ),
      [],
    );
    expect(global).toHaveLength(XHS_OPS_MAX_DIAGNOSES);
    expect(global.map((entry) => entry.id)).not.toContain("d-10");

    const order = (
      index: number,
      status: XhsOpsChangeOrder["status"],
      days: number,
    ) =>
      xhsOpsChangeOrderSchema.parse({
        id: `o-${index}`,
        projectId: "p",
        accountId: "acct",
        deviceId: "d",
        platformAccountId: "x",
        diagnosisId: null,
        proposalIds: [],
        batchIndex: 1,
        risk: "L1",
        fields: [{ field: "bio", baselineValue: "", after: "x" }],
        status,
        createdAt: old(days),
        updatedAt: old(days),
      });
    const orders = [
      order(0, "observing", 90),
      order(1, "completed", 20),
      order(2, "completed", 60),
      ...Array.from({ length: XHS_OPS_MAX_CHANGE_ORDERS }, (_, index) =>
        order(index + 3, "draft", 1),
      ),
    ];
    const keptOrders = evictChangeOrders(orders, now).map((entry) => entry.id);
    // Only the terminal order outside every budget window may go; the cap
    // stays exceeded rather than losing ledger or live orders.
    expect(keptOrders).toHaveLength(orders.length - 1);
    expect(keptOrders).not.toContain("o-2");
    expect(keptOrders).toEqual(expect.arrayContaining(["o-0", "o-1"]));
  });

  it("points takeover.activeAuditId at the running audit and lets go once it closes (§2.1)", async () => {
    const h = harness();
    const { account } = await lockedAccount(h);
    h.advance(MINUTE);
    const { audit, release } = await h.store.startAudit({
      projectId: account.projectId,
      accountId: account.id,
      deviceId: "phone-1",
      platformAccountId: XHS_ID,
    });
    release();
    const started = must(await h.store.getAccount(account.id));
    expect(takeoverOf(started).activeAuditId).toBe(audit.id);
    expect(started.updatedAt > account.updatedAt).toBe(true);
    expect(
      xhsOpsAccountNurtureIssues(
        started,
        await h.store.getProject(account.projectId),
      ),
    ).toContain("只读盘点进行中");

    // A part write keeps the pointer and leaves the account untouched.
    h.advance(MINUTE);
    await h.store.updateAudit(audit.id, (current) => ({
      ...current,
      activeTaskId: "task-1",
    }));
    expect(await h.store.getAccount(account.id)).toEqual(started);

    // Closing the audit lets go of it, whatever the closing write says.
    h.advance(MINUTE);
    const closed = await h.store.mutateTakeover(
      account.id,
      ({ account: current, audits }) => ({
        account: {
          ...current,
          takeover: {
            ...takeoverOf(current),
            latestAuditId: audit.id,
            activeAuditId: audit.id,
          },
        },
        audits: [
          {
            ...must(audits.find((entry) => entry.id === audit.id)),
            status: "completed",
          },
        ],
        result: null,
      }),
    );
    expect(takeoverOf(closed.account)).toMatchObject({
      activeAuditId: null,
      latestAuditId: audit.id,
    });
    // It only ever names a running audit of the account.
    const forged = await h.store.mutateTakeover(
      account.id,
      ({ account: current }) => ({
        account: {
          ...current,
          takeover: { ...takeoverOf(current), activeAuditId: "not-running" },
        },
        result: null,
      }),
    );
    expect(takeoverOf(forged.account).activeAuditId).toBeNull();
  });

  it("marks the previous controller's running work after a restart", async () => {
    const h = harness();
    const { account } = await lockedAccount(h);
    const running = await h.store.createAudit(
      auditSeed(account, {
        status: "running",
        activeTaskId: "audit-task",
        profile: {
          status: "read",
          code: "",
          evidence: null,
          accountMatched: true,
          values: null,
        },
        home: {
          status: "running",
          code: "",
          evidence: null,
          nickname: "",
          header: null,
          headerEnd: null,
          notesEnd: false,
          notes: [],
        },
      }),
    );
    expect(takeoverOf(await h.store.getAccount(account.id)).activeAuditId).toBe(
      running.id,
    );
    const done = await h.store.createAudit(auditSeed(account));
    const generating = await h.store.createDiagnosis({
      ...diagnosisSeed(account, done.id),
      status: "generating",
    });
    const prechecking = await h.store.createChangeOrder(
      orderSeed(account, { status: "prechecking" }),
    );
    const applying = await h.store.createChangeOrder(
      orderSeed(account, { status: "applying", applyTaskId: "apply-task" }),
    );
    const verifying = await h.store.createChangeOrder(
      orderSeed(account, {
        status: "verifying",
        applyTaskId: "apply-task-2",
        verificationTaskId: "verify-task",
      }),
    );
    await activate(h, account.id, prechecking.id);

    h.advance(MINUTE);
    const restarted = h.reopen();
    const recovery = await restarted.recoverInterruptedTakeoverWork();
    expect(recovery.audits).toEqual([
      expect.objectContaining({
        id: running.id,
        status: "interrupted",
        activeTaskId: "audit-task",
        profile: expect.objectContaining({ status: "read" }),
        home: expect.objectContaining({ status: "interrupted" }),
      }),
    ]);
    expect(recovery.diagnoses).toEqual([
      expect.objectContaining({ id: generating.id, status: "failed" }),
    ]);
    expect(
      recovery.changeOrders.map(({ order, previousStatus, taskId }) => [
        order.id,
        order.status,
        previousStatus,
        taskId,
      ]),
    ).toEqual([
      [prechecking.id, "draft", "prechecking", null],
      [applying.id, "interrupted", "applying", "apply-task"],
      [verifying.id, "interrupted", "verifying", "verify-task"],
    ]);
    expect((await restarted.getAudit(done.id))?.status).toBe("completed");
    expect(takeoverOf(await restarted.getAccount(account.id))).toMatchObject({
      activeChangeOrderId: null,
      // Nothing runs after the sweep.
      activeAuditId: null,
    });
    // A second sweep finds nothing left to mark.
    expect(await restarted.recoverInterruptedTakeoverWork()).toEqual({
      audits: [],
      diagnoses: [],
      changeOrders: [],
    });
  });
});
