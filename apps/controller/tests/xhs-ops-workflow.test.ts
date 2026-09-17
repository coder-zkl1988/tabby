import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  xhsOpsAccountNurtureIssues,
  xhsOpsRunSchema,
  xhsOpsStoreDataSchema,
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
      interaction: { likeRatio: 0.2, favoriteRatio: 0.1, commentRatio: 0.05 },
    });

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
