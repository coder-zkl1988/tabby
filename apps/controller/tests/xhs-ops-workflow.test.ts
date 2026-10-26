import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  XHS_ACCOUNT_IDENTITY_LOCKED_MESSAGE,
  XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE,
  type XhsOpsAccount,
  type XhsOpsProject,
  xhsOpsAccountNurtureIssues,
  xhsOpsRunSchema,
  xhsOpsStoreDataSchema,
  xhsOpsToneGuideSchema,
} from "@nexu/shared";
import { afterAll, describe, expect, it } from "vitest";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";

const dir = mkdtempSync(join(tmpdir(), "koc-workflow-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const image = join(dir, "image.png");
writeFileSync(image, "fixture");
const profile = {
  summary: "北京年轻球友",
  base: { ageRange: "25–35", genderRatio: "男50%女50%", regions: ["北京"] },
  verticalInterests: ["羽毛球"],
  generalInterests: ["咖啡", "摄影"],
};
async function seed() {
  const store = new XhsOpsStore(join(dir, `${Math.random()}.json`));
  const created = await store.createProject({
    name: "建号闭环",
    business: { industry: "运动", product: "羽毛球课程" },
    audience: {
      ageRange: "25–35",
      genderRatio: "男50%女50%",
      regions: ["北京"],
    },
  });
  const project = await store.confirmProfile(created.id, {
    profile,
    expectedUpdatedAt: created.updatedAt,
  });
  const account = await store.createAccount({
    projectId: project.id,
    label: "下班练球",
    positioning: "记录下班打球",
    persona: {
      age: "29岁",
      gender: "男",
      region: "北京",
      occupation: "设计师",
      lifeStatus: "下班练球",
    },
    personaTags: { vertical: ["羽毛球"], general: ["咖啡", "摄影"] },
    interestPool: {
      core: ["羽毛球"],
      extended: ["运动恢复"],
      general: ["咖啡", "摄影"],
    },
    platformAccountId: "test-xhs",
    deviceId: "test-phone",
  });
  const [reviewed] = await store.confirmPersonas(project.id, {
    accounts: [{ accountId: account.id, expectedUpdatedAt: account.updatedAt }],
    expectedUpdatedAt: project.updatedAt,
    distributionReviewed: true,
    reviewNote: "已对照目标分布核对本批人设",
  });
  const drafted = await store.updateAccount(account.id, {
    profileDraft: {
      nickname: "下班练球",
      bio: "天秤 INFP｜北京设计师｜喜欢羽毛球咖啡摄影",
      gender: "男",
      birthday: "1997-01-01",
      region: "北京",
      interestTags: ["羽毛球", "咖啡"],
      avatarCandidates: [image],
      coverCandidates: [image],
      avatarPath: image,
      coverPath: image,
    },
  });
  expect(reviewed?.personaReviewedAt).toBeTruthy();
  expect(drafted).toBeTruthy();
  const ready = await store.confirmProfileDraft(account.id);
  if (!ready) throw new Error("missing fixture");
  return { store, project, account: ready };
}

describe("KOC stage dependencies", () => {
  it("lets an existing phone account skip new-persona review and enter optimization", async () => {
    const { store, project } = await seed();
    const account = await store.createAccount({
      projectId: project.id,
      entryMode: "existing",
      label: "已有球友号",
      positioning: "优化已有账号的下班打球内容",
      platformAccountId: "existing-xhs",
      deviceId: "existing-phone",
    });
    const drafted = await store.updateAccount(account.id, {
      profileDraft: {
        ...account.profileDraft,
        nickname: "已有球友号",
        bio: "北京下班打球记录",
        gender: "男",
        birthday: "1997-01-01",
        region: "北京",
        interestTags: ["羽毛球"],
        avatarCandidates: [image],
        coverCandidates: [image],
        avatarPath: image,
        coverPath: image,
      },
    });
    const confirmed = await store.confirmProfileDraft(account.id);
    if (!confirmed) throw new Error("missing existing account fixture");
    expect(confirmed?.entryMode).toBe("existing");
    expect(confirmed?.personaReviewedAt).toBeNull();
    expect(drafted?.profileDraft.reviewedAt).toBeNull();
    // An existing row that never passed the old phone verification now starts
    // a takeover instead of the new-account material flow (takeover §6.1).
    expect(xhsOpsAccountNurtureIssues(confirmed, project)).toEqual(
      expect.arrayContaining(["请先开始接管：授权、锁定身份并完成只读盘点"]),
    );
    expect(xhsOpsAccountNurtureIssues(confirmed, project)).not.toContain(
      "人设或目标画像已变化，请重新核对并确认人设",
    );
  });

  it("rejects stale account saves and material confirmations without changing newer content", async () => {
    const { store, account } = await seed();
    const edited = await store.updateAccount(account.id, {
      expectedUpdatedAt: account.updatedAt,
      profileDraft: { ...account.profileDraft, nickname: "更新后的昵称" },
    });
    await expect(
      store.updateAccount(account.id, {
        expectedUpdatedAt: account.updatedAt,
        profileDraft: account.profileDraft,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store.confirmProfileDraft(account.id, account.updatedAt),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.getAccount(account.id)).toMatchObject({
      updatedAt: edited?.updatedAt,
      profileDraft: { nickname: "更新后的昵称", reviewedAt: null },
    });
    await expect(
      store.confirmProfileDraft(account.id, edited?.updatedAt),
    ).resolves.toMatchObject({
      profileDraft: {
        nickname: "更新后的昵称",
        reviewedAt: expect.any(String),
      },
    });
  });
  it("preserves old accounts without a day target while giving new accounts the requested default", async () => {
    const { account, project } = await seed();
    expect(account.browseDefaults.dailyTargetPosts).toBe(90);
    const {
      dailyTargetPosts: _target,
      dailySegments: _segments,
      ...legacyBrowse
    } = account.browseDefaults;
    const restored = xhsOpsStoreDataSchema.parse({
      schemaVersion: 1,
      projects: [project],
      accounts: [{ ...account, browseDefaults: legacyBrowse }],
      runs: [],
      comments: [],
    });
    expect(restored.accounts[0]?.browseDefaults).toMatchObject({
      dailyTargetPosts: 0,
      dailySegments: 1,
    });
  });
  it("keeps an account with planned work until that work is cancelled", async () => {
    const { store, project, account } = await seed();
    const run = xhsOpsRunSchema.parse({
      id: "fixture",
      projectId: project.id,
      accountId: account.id,
      deviceId: account.deviceId,
      accountLabel: account.label,
      date: "2026-09-09",
      status: "planned",
      plan: {
        keywords: [{ keyword: "羽毛球", count: 1 }],
        homeFeedCount: 0,
        dwellSecMin: 11,
        dwellSecMax: 25,
        interaction: account.interaction,
      },
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    });
    await store.createRun(run);
    await expect(store.deleteAccount(account.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(await store.getAccount(account.id)).not.toBeNull();
  });
  it("does not unlock phone execution from draft confirmation or forged applied fields", async () => {
    const { store, project, account } = await seed();
    const patched = await store.updateAccount(account.id, {
      profileDraft: {
        ...account.profileDraft,
        applyStatus: "applied",
        verifiedAt: new Date().toISOString(),
      },
    } as Parameters<typeof store.updateAccount>[1]);
    expect(patched?.profileDraft.applyStatus).toBeNull();
    expect(xhsOpsAccountNurtureIssues(account, project)).toContain(
      "请先完成手机账号配置及资料生效核验",
    );
  });
  it("preserves verified profile state when editing non-profile account settings", async () => {
    const { store, project, account } = await seed();
    const appliedAt = new Date().toISOString();
    const applied = await store.updateAccount(
      account.id,
      {},
      {
        profileApplyResult: {
          expectedProfileDraft: account.profileDraft,
          expectedPlatformAccountId: account.platformAccountId,
          appliedAt,
          applyStatus: "applied",
          applyResult: "verified",
          verifiedAt: appliedAt,
          verifiedAccountId: account.platformAccountId,
          verificationTaskId: "verify-settings-edit",
        },
      },
    );
    if (!applied) throw new Error("missing applied account fixture");

    const edited = await store.updateAccount(applied.id, {
      interaction: {
        ...applied.interaction,
        like: { ...applied.interaction.like, ratioPercent: 20 },
      },
    });

    expect(edited?.interaction.like.ratioPercent).toBe(20);
    expect(edited?.profileDraft).toMatchObject({
      appliedAt,
      applyStatus: "applied",
      applyResult: "verified",
      verifiedAt: appliedAt,
      verifiedAccountId: account.platformAccountId,
      verificationTaskId: "verify-settings-edit",
    });
    expect(
      xhsOpsAccountNurtureIssues(edited ?? applied, project),
    ).not.toContain("请先完成手机账号配置及资料生效核验");
  });
  it("invalidates descendants when customer inputs change and rejects an old confirmation", async () => {
    const { store, project, account } = await seed();
    const updated = await store.updateProject(project.id, {
      business: { ...project.business, product: "网球课程" },
      expectedUpdatedAt: project.updatedAt,
    });
    expect(updated?.profile?.confirmedAt).toBeNull();
    const next = await store.getAccount(account.id);
    expect(next?.personaReviewedAt).toBeNull();
    expect(next?.profileDraft.reviewedAt).toBeNull();
    await expect(
      store.confirmProfile(project.id, {
        profile,
        expectedUpdatedAt: project.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("invalidates the review after persona/interest edits but keeps the draft to review", async () => {
    const { store, account } = await seed();
    const next = await store.updateAccount(account.id, {
      persona: { ...account.persona, occupation: "工程师" },
    });
    expect(next?.personaReviewedAt).toBeNull();
    expect(next?.profileDraft.reviewedAt).toBeNull();
    expect(next?.profileDraft.nickname).toBe(account.profileDraft.nickname);
  });
  it("does not let an old phone receipt re-confirm a changed target account", async () => {
    const { store, account } = await seed();
    await store.updateAccount(account.id, {
      platformAccountId: "another-target",
    });
    await expect(
      store.updateAccount(
        account.id,
        {},
        {
          profileApplyResult: {
            expectedProfileDraft: account.profileDraft,
            expectedPlatformAccountId: account.platformAccountId,
            appliedAt: new Date().toISOString(),
            applyStatus: "applied",
            applyResult: "verified",
            verifiedAt: new Date().toISOString(),
            verifiedAccountId: account.platformAccountId,
            verificationTaskId: "verify-1",
          },
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("rejects an expired image candidate at material confirmation", async () => {
    const { store, account } = await seed();
    await store.updateAccount(account.id, {
      profileDraft: {
        ...account.profileDraft,
        avatarPath: join(dir, "missing.png"),
        avatarCandidates: [join(dir, "missing.png")],
      },
    });
    await expect(store.confirmProfileDraft(account.id)).rejects.toMatchObject({
      status: 400,
    });
  });
});

function verifiedApply(account: XhsOpsAccount, verifiedAt: string) {
  return {
    profileApplyResult: {
      expectedProfileDraft: account.profileDraft,
      expectedPlatformAccountId: account.platformAccountId,
      appliedAt: verifiedAt,
      applyStatus: "applied" as const,
      applyResult: "verified",
      verifiedAt,
      verifiedAccountId: account.platformAccountId,
      verificationTaskId: "verify-takeover",
    },
  };
}

describe("takeover rules on the account store", () => {
  let device = 0;
  async function existingAccount(
    store: XhsOpsStore,
    project: XhsOpsProject,
    overrides: Partial<Parameters<XhsOpsStore["createAccount"]>[0]> = {},
  ): Promise<XhsOpsAccount> {
    return store.createAccount({
      projectId: project.id,
      entryMode: "existing",
      label: "接管·测试机",
      deviceId: `takeover-phone-${++device}`,
      ...overrides,
    });
  }
  async function authorized(store: XhsOpsStore, account: XhsOpsAccount) {
    return store.authorizeTakeover(account.id, {
      expectedUpdatedAt: account.updatedAt,
      ownershipConfirmed: true,
    });
  }

  it("loads a store file written before the takeover collections existed", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "koc-legacy-store-"));
    try {
      const file = join(legacyDir, "xhs-ops.json");
      writeFileSync(
        file,
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            {
              id: "proj-legacy",
              name: "老数据",
              createdAt: "2026-09-01T00:00:00.000Z",
              updatedAt: "2026-09-01T00:00:00.000Z",
            },
          ],
          accounts: [
            {
              id: "acct-legacy",
              projectId: "proj-legacy",
              entryMode: "existing",
              label: "老 existing 行",
              platformAccountId: "legacy-xhs",
              deviceId: "legacy-phone",
              createdAt: "2026-09-01T00:00:00.000Z",
              updatedAt: "2026-09-01T00:00:00.000Z",
            },
          ],
          runs: [],
          comments: [],
        }),
      );
      const store = new XhsOpsStore(file);
      expect(await store.listAudits()).toEqual([]);
      expect(await store.listDiagnoses()).toEqual([]);
      expect(await store.listChangeOrders()).toEqual([]);
      expect(await store.getAccount("acct-legacy")).toMatchObject({
        takeover: null,
        toneGuide: xhsOpsToneGuideSchema.parse({}),
        platformAccountId: "legacy-xhs",
      });
      // Loaded as-is: nothing was quarantined or reset to defaults.
      expect(
        readdirSync(legacyDir).filter((name) => name.includes(".corrupt-")),
      ).toEqual([]);
      expect(await store.getProject("proj-legacy")).not.toBeNull();
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("locks entryMode once a takeover started or an existing row has a 小红书号", async () => {
    const { store, project } = await seed();
    const takeover = await authorized(
      store,
      await existingAccount(store, project),
    );
    await expect(
      store.updateAccount(takeover.id, { entryMode: "new" }),
    ).rejects.toMatchObject({
      status: 409,
      message: XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE,
    });
    expect((await store.getAccount(takeover.id))?.entryMode).toBe("existing");
    // Re-sending the current mode is not a switch.
    await expect(
      store.updateAccount(takeover.id, {
        entryMode: "existing",
        label: "改名",
      }),
    ).resolves.toMatchObject({ entryMode: "existing", label: "改名" });

    const legacyRow = await existingAccount(store, project, {
      platformAccountId: "legacy-xhs",
    });
    await expect(
      store.updateAccount(legacyRow.id, { entryMode: "new" }),
    ).rejects.toMatchObject({ status: 409 });
    const unlocked = await existingAccount(store, project);
    await expect(
      store.updateAccount(unlocked.id, { entryMode: "new" }),
    ).resolves.toMatchObject({ entryMode: "new" });
  });

  it("keeps a locked 小红书号, so clearing it first cannot unlock entryMode (A5)", async () => {
    const { store, project } = await seed();
    const identityLocked = {
      status: 409,
      message: XHS_ACCOUNT_IDENTITY_LOCKED_MESSAGE,
    };
    const entryLocked = {
      status: 409,
      message: XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE,
    };
    // The two-PATCH bypass on a legacy existing row (takeover null).
    const legacyRow = await existingAccount(store, project, {
      platformAccountId: "legacy-xhs",
    });
    await expect(
      store.updateAccount(legacyRow.id, { platformAccountId: "" }),
    ).rejects.toMatchObject(identityLocked);
    await expect(
      store.updateAccount(legacyRow.id, { platformAccountId: "other-xhs" }),
    ).rejects.toMatchObject(identityLocked);
    await expect(
      store.updateAccount(legacyRow.id, { entryMode: "new" }),
    ).rejects.toMatchObject(entryLocked);
    expect(await store.getAccount(legacyRow.id)).toMatchObject({
      entryMode: "existing",
      platformAccountId: "legacy-xhs",
    });
    // Re-sending the id on record is no change.
    await expect(
      store.updateAccount(legacyRow.id, {
        platformAccountId: "legacy-xhs",
        label: "改名",
      }),
    ).resolves.toMatchObject({
      platformAccountId: "legacy-xhs",
      label: "改名",
    });

    // An existing row without an id may record one, and is locked from then on.
    const fresh = await existingAccount(store, project);
    await expect(
      store.updateAccount(fresh.id, { platformAccountId: "fresh-xhs" }),
    ).resolves.toMatchObject({ platformAccountId: "fresh-xhs" });
    await expect(
      store.updateAccount(fresh.id, { platformAccountId: "" }),
    ).rejects.toMatchObject(identityLocked);
    // Recording an id and leaving the existing flow in one PATCH: the lock
    // is evaluated on the patched row too.
    const other = await existingAccount(store, project);
    await expect(
      store.updateAccount(other.id, {
        platformAccountId: "other-xhs",
        entryMode: "new",
      }),
    ).rejects.toMatchObject(entryLocked);
    expect(await store.getAccount(other.id)).toMatchObject({
      entryMode: "existing",
      platformAccountId: "",
    });

    // A phone verification on record locks the id field as well.
    const verified = await existingAccount(store, project);
    const withVerification = await store.updateAccount(
      verified.id,
      {},
      {
        profileApplyResult: {
          expectedProfileDraft: verified.profileDraft,
          appliedAt: verified.updatedAt,
          applyStatus: "applied",
          applyResult: "ok",
          verifiedAt: verified.updatedAt,
          verifiedAccountId: "verified-xhs",
          verificationTaskId: "task-1",
        },
      },
    );
    expect(withVerification?.profileDraft.verifiedAccountId).toBe(
      "verified-xhs",
    );
    await expect(
      store.updateAccount(verified.id, { platformAccountId: "else-xhs" }),
    ).rejects.toMatchObject(identityLocked);

    // A takeover changes its id only through the identity flow; its other
    // fields, the device binding included, still PATCH.
    const takeover = await authorized(
      store,
      await existingAccount(store, project),
    );
    await expect(
      store.updateAccount(takeover.id, { platformAccountId: "typed-xhs" }),
    ).rejects.toMatchObject(identityLocked);
    await expect(
      store.updateAccount(takeover.id, { deviceId: null }),
    ).resolves.toMatchObject({ deviceId: null });

    // New accounts are untouched.
    const created = await store.createAccount({
      projectId: project.id,
      label: "新号",
      platformAccountId: "new-xhs",
    });
    await expect(
      store.updateAccount(created.id, { platformAccountId: "" }),
    ).resolves.toMatchObject({ platformAccountId: "" });
  });

  it("keeps a locked target's 小红书号 on a device transfer (A5)", async () => {
    const { store, project } = await seed();
    const source = await store.createAccount({
      projectId: project.id,
      label: "来源",
      deviceId: "transfer-phone",
    });
    const target = await existingAccount(store, project, {
      platformAccountId: "legacy-xhs",
      deviceId: null,
    });
    // The planner sends no platformAccountId; the schema default is "".
    await expect(
      store.transferDevice(project.id, {
        fromAccountId: source.id,
        toAccountId: target.id,
        account: {
          label: "接管·测试机",
          entryMode: "existing",
          deviceId: "transfer-phone",
          platformAccountId: "other-xhs",
        },
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: XHS_ACCOUNT_IDENTITY_LOCKED_MESSAGE,
    });
    const moved = await store.transferDevice(project.id, {
      fromAccountId: source.id,
      toAccountId: target.id,
      account: {
        label: "接管·测试机",
        entryMode: "existing",
        deviceId: "transfer-phone",
      },
    });
    expect(moved).toMatchObject({
      deviceId: "transfer-phone",
      entryMode: "existing",
      platformAccountId: "legacy-xhs",
    });
    await expect(
      store.updateAccount(target.id, { entryMode: "new" }),
    ).rejects.toMatchObject({
      status: 409,
      message: XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE,
    });
  });

  it("re-checks a takeover's parameters on PATCH and records an approved override", async () => {
    const { store, project } = await seed();
    const account = await authorized(
      store,
      await existingAccount(store, project, {
        interestPool: {
          core: ["护肤", "通勤"],
          extended: ["穿搭"],
          general: ["咖啡", "旅行"],
        },
      }),
    );
    const follow = {
      ...account.interaction,
      follow: { enabled: true, dailyCap: 2, ratioPercent: 2 },
    };
    // The wording stays as it was; code and issues say the same for the card.
    await expect(
      store.updateAccount(account.id, { interaction: follow }),
    ).rejects.toMatchObject({
      status: 409,
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
    expect(
      (await store.getAccount(account.id))?.interaction.follow.enabled,
    ).toBe(false);

    const overridden = await store.updateAccount(account.id, {
      interaction: follow,
      overrideReason: "客户要求回关老粉",
    });
    if (!overridden) throw new Error("missing overridden account");
    expect(overridden.interaction.follow.enabled).toBe(true);
    expect(overridden).not.toHaveProperty("overrideReason");
    expect(overridden.takeover?.paramOverrides).toEqual([
      {
        at: overridden.updatedAt,
        reason: "客户要求回关老粉",
        fields: ["interaction.follow.enabled"],
      },
    ]);

    // An override accepted before does not need a reason again.
    const later = await store.updateAccount(account.id, {
      browseDefaults: { ...overridden.browseDefaults, dwellSecMax: 30 },
    });
    expect(later?.takeover?.paramOverrides).toHaveLength(1);
    // A hard limit stays a 409 whatever the reason; its issues name every
    // parameter the change put past a limit, the overridable ones included.
    await expect(
      store.updateAccount(account.id, {
        browseDefaults: { ...overridden.browseDefaults, dwellSecMin: 8 },
        overrideReason: "想快一点",
      }),
    ).rejects.toMatchObject({
      status: 409,
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
    await expect(
      store.updateAccount(account.id, {
        browseDefaults: {
          ...overridden.browseDefaults,
          dwellSecMin: 8,
          dailyTargetPosts: 100,
        },
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "单篇最短停留必须至少 11 秒",
      code: "takeover_param_hard_limit",
      issues: [
        { field: "browseDefaults.dwellSecMin", overridable: false },
        { field: "browseDefaults.dailyTargetPosts", overridable: true },
      ],
    });
    // Lowering an accepted over-tier cap is no new adjustment; dropping the
    // daily target altogether is.
    const raised = await store.updateAccount(account.id, {
      browseDefaults: { ...overridden.browseDefaults, dailyTargetPosts: 100 },
      overrideReason: "客户要求加量",
    });
    if (!raised) throw new Error("missing raised account");
    const eased = await store.updateAccount(account.id, {
      browseDefaults: { ...raised.browseDefaults, dailyTargetPosts: 96 },
    });
    expect(eased?.browseDefaults.dailyTargetPosts).toBe(96);
    expect(eased?.takeover?.paramOverrides).toHaveLength(2);
    await expect(
      store.updateAccount(account.id, {
        browseDefaults: { ...raised.browseDefaults, dailyTargetPosts: 0 },
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("需要填写理由"),
    });
    // A plan-budget gap the pool already had does not block a milder target.
    const emptyPool = await authorized(
      store,
      await existingAccount(store, project),
    );
    await expect(
      store.updateAccount(emptyPool.id, {
        browseDefaults: { ...emptyPool.browseDefaults, dailyTargetPosts: 60 },
      }),
    ).resolves.toMatchObject({ browseDefaults: { dailyTargetPosts: 60 } });
    // A new account is never re-checked.
    const { store: freshStore, account: fresh } = await seed();
    await expect(
      freshStore.updateAccount(fresh.id, { interaction: follow }),
    ).resolves.toMatchObject({ interaction: { follow: { enabled: true } } });
  });

  it("keeps a takeover's verification when its persona or pool is tuned, but not a new account's (N1)", async () => {
    const { store, project, account: fresh } = await seed();
    const verifiedAt = new Date().toISOString();
    const row = await existingAccount(store, project, {
      platformAccountId: "verified-xhs",
    });
    const verified = await store.updateAccount(
      row.id,
      {},
      verifiedApply(row, verifiedAt),
    );
    if (!verified) throw new Error("missing verified fixture");
    const takeover = await authorized(store, verified);
    const tuned = await store.updateAccount(takeover.id, {
      persona: { ...takeover.persona, occupation: "设计师" },
      interestPool: { core: ["护肤"], extended: ["通勤"], general: ["咖啡"] },
    });
    expect(tuned?.profileDraft).toMatchObject({
      applyStatus: "applied",
      verifiedAt,
      verifiedAccountId: "verified-xhs",
    });
    expect(tuned?.takeover?.legacyVerified).toBe(true);

    const freshVerified = await store.updateAccount(
      fresh.id,
      {},
      verifiedApply(fresh, verifiedAt),
    );
    if (!freshVerified) throw new Error("missing verified new account");
    const freshTuned = await store.updateAccount(fresh.id, {
      persona: { ...freshVerified.persona, occupation: "工程师" },
    });
    expect(freshTuned?.profileDraft).toMatchObject({
      applyStatus: null,
      verifiedAt: null,
      verifiedAccountId: null,
    });
  });

  it("does not treat two blank takeover rows as duplicate personas (§5.3 #10)", async () => {
    const { store, project } = await seed();
    const first = await existingAccount(store, project, {
      label: "接管·一号机",
    });
    const second = await existingAccount(store, project, {
      label: "接管·二号机",
    });
    const current = await store.getProject(project.id);
    if (!current) throw new Error("missing project");
    const confirmed = await store.confirmPersonas(project.id, {
      accounts: [first, second].map((account) => ({
        accountId: account.id,
        expectedUpdatedAt: account.updatedAt,
      })),
      expectedUpdatedAt: current.updatedAt,
      distributionReviewed: true,
      reviewNote: "混选提交时接管行一起复核",
    });
    expect(confirmed.map((account) => account.id)).toEqual([
      first.id,
      second.id,
    ]);
    // The label still has to differ.
    const sameLabel = await existingAccount(store, project, {
      label: "接管·一号机",
    });
    await expect(
      store.confirmPersonas(project.id, {
        accounts: [
          { accountId: sameLabel.id, expectedUpdatedAt: sameLabel.updatedAt },
        ],
        expectedUpdatedAt: current.updatedAt,
        distributionReviewed: true,
        reviewNote: "同名",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
