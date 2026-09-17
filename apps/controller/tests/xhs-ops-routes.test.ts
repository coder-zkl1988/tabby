import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, describe, expect, it } from "vitest";
import type { ControllerContainer } from "../src/app/container.js";
import { registerXhsOpsRoutes } from "../src/routes/xhs-ops-routes.js";
import { ImageGenerationFailedError } from "../src/services/media-generation-service.js";
import { XhsOpsCommentService } from "../src/services/xhs-ops-comment-service.js";
import { XhsOpsProfileService } from "../src/services/xhs-ops-profile-service.js";
import { XhsOpsRunService } from "../src/services/xhs-ops-run-service.js";
import { XhsOpsScheduler } from "../src/services/xhs-ops-scheduler.js";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";
import type { ControllerBindings } from "../src/types.js";

const tempDir = mkdtempSync(join(tmpdir(), "xhs-ops-routes-"));
const store = new XhsOpsStore(join(tempDir, "xhs-ops.json"));
const fixtureImage = join(tempDir, "profile.png");
writeFileSync(fixtureImage, "fixture");
const profile = {
  summary: "亲子家庭",
  base: { ageRange: "25–40", genderRatio: "不限", regions: ["北京"] },
  verticalInterests: ["亲子酒店"],
  generalInterests: ["咖啡", "摄影"],
};
async function prepareAccount(accountId: string, verify = false) {
  const account = await store.getAccount(accountId);
  if (!account) throw new Error("missing fixture");
  const initial = await store.getProject(account.projectId);
  if (!initial) throw new Error("missing project");
  const project = await store.updateProject(initial.id, {
    business: { industry: "旅行", product: "亲子酒店" },
    audience: { ageRange: "25–40", genderRatio: "不限", regions: ["北京"] },
  });
  if (!project) throw new Error("missing project");
  const confirmed = await store.confirmProfile(project.id, {
    profile,
    expectedUpdatedAt: project.updatedAt,
  });
  const patched = await store.updateAccount(account.id, {
    positioning: "周末亲子生活",
    persona: {
      age: "32",
      gender: "女",
      region: "北京",
      occupation: "设计师",
      lifeStatus: "亲子家庭",
    },
    personaTags: { vertical: ["亲子酒店"], general: ["咖啡", "摄影"] },
    platformAccountId: `test-${accountId}`,
    interestPool: {
      core: account.interestPool.core.length
        ? account.interestPool.core
        : ["亲子酒店"],
      extended: ["周边游"],
      general: ["咖啡", "摄影"],
    },
    profileDraft: {
      ...account.profileDraft,
      gender: "女",
      birthday: "1994-01-01",
      region: "北京",
      interestTags: ["亲子", "咖啡"],
    },
  });
  if (!patched) throw new Error("missing account");
  await store.confirmPersonas(project.id, {
    expectedUpdatedAt: confirmed.updatedAt,
    accounts: [{ accountId, expectedUpdatedAt: patched.updatedAt }],
    distributionReviewed: true,
    reviewNote: "已核对测试人设分布",
  });
  if (verify) {
    const ready = await store.updateAccount(accountId, {
      profileDraft: {
        ...patched.profileDraft,
        nickname: account.label,
        bio: "亲子生活",
        avatarPath: fixtureImage,
        coverPath: fixtureImage,
        avatarCandidates: [fixtureImage],
        coverCandidates: [fixtureImage],
      },
    });
    if (!ready) throw new Error("missing fixture");
    const reviewed = await store.confirmProfileDraft(accountId);
    if (!reviewed) throw new Error("missing fixture");
    await store.updateAccount(
      accountId,
      {},
      {
        profileApplyResult: {
          expectedProfileDraft: reviewed.profileDraft,
          expectedPlatformAccountId: reviewed.platformAccountId,
          appliedAt: new Date().toISOString(),
          applyStatus: "applied",
          applyResult: "fixture verified",
          verifiedAt: new Date().toISOString(),
          verifiedAccountId: reviewed.platformAccountId,
          verificationTaskId: "fixture-verification",
        },
      },
    );
  }
}
const runService = new XhsOpsRunService({
  store,
  // 路由冒烟不执行 run；三个方法按接口签名给桩即可。
  deviceControl: {
    getDevice: async () => null,
    executeTask: async () => {
      throw new Error("not used in route smoke test");
    },
    cancelTask: async () => {},
  },
});

const profileService = new XhsOpsProfileService({
  store,
  mediaRoot: tempDir,
  media: {
    generateText: async () => ({
      text: '{"nickname":"路由昵称","bio":"路由简介"}',
    }),
    generateImage: async () => ({ path: "", items: [] }),
  },
  deviceControl: {
    getDevice: async () => null,
    executeTask: async () => {
      throw new Error("not used in route smoke test");
    },
    pushMedia: async () => ({ results: [] }),
  },
});

const scheduler = new XhsOpsScheduler({ store, runService });
const commentService = new XhsOpsCommentService({
  store,
  media: {
    generateText: async () => ({
      text: '{"candidates":["这家亲子房太省心了","带娃住这儿真不错","海洋球池娃能玩一天"]}',
    }),
  },
});

function buildApp(overrides: Partial<ControllerContainer> = {}) {
  const app = new OpenAPIHono<ControllerBindings>();
  registerXhsOpsRoutes(app, {
    xhsOpsStore: store,
    xhsOpsRunService: runService,
    xhsOpsProfileService: profileService,
    xhsOpsScheduler: scheduler,
    xhsOpsCommentService: commentService,
    ...overrides,
  } as ControllerContainer);
  return app;
}

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("xhs-ops routes wiring", () => {
  it("returns a revision conflict without overwriting newer project inputs", async () => {
    const app = buildApp();
    const project = await store.createProject({ name: "项目并发测试" });
    await store.updateProject(project.id, { name: "较新内容" });
    const response = await app.request(
      `/api/v1/xhs-ops/projects/${project.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "旧卡内容",
          expectedUpdatedAt: project.updatedAt,
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining("更新"),
    });
    expect((await store.getProject(project.id))?.name).toBe("较新内容");
    await store.deleteProject(project.id);
  });
  it("rejects arbitrary comment tasks and reports duplicate device bindings as 409", async () => {
    const app = buildApp();
    const project = await store.createProject({ name: "安全路由回归" });
    const account = await store.createAccount({
      projectId: project.id,
      label: "A",
      deviceId: "dev-safety",
    });
    const other = await store.createAccount({
      projectId: project.id,
      label: "B",
    });
    const generic = await app.request("/api/v1/xhs-ops/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        accountId: account.id,
        plan: {
          kind: "comment",
          keywords: [],
          homeFeedCount: 0,
          dwellSecMin: 11,
          dwellSecMax: 20,
          interaction: account.interaction,
          comments: [
            {
              draftId: "unreviewed",
              text: "这个很贴心",
              postTitle: "任意内容",
              postAuthor: "",
            },
          ],
        },
      }),
    });
    expect(generic.status).toBe(400);
    const duplicate = await app.request(
      `/api/v1/xhs-ops/projects/${project.id}/accounts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "C", deviceId: "dev-safety" }),
      },
    );
    expect(duplicate.status).toBe(409);
    const rebind = await app.request(`/api/v1/xhs-ops/accounts/${other.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "dev-safety" }),
    });
    expect(rebind.status).toBe(409);
    await store.deleteProject(project.id);
  });
  it("GET /api/v1/xhs-ops/projects starts empty", async () => {
    const app = buildApp();
    const res = await app.request("/api/v1/xhs-ops/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[] };
    expect(body.projects).toEqual([]);
  });

  it("project create → list → get round-trips", async () => {
    const app = buildApp();
    const create = await app.request("/api/v1/xhs-ops/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "亲子度假测试项目",
        business: { industry: "亲子旅游", product: "亲子酒店套餐" },
        audience: { ageRange: "28-38" },
      }),
    });
    expect(create.status).toBe(200);
    const created = (
      (await create.json()) as { project: { id: string; name: string } }
    ).project;
    expect(created.name).toBe("亲子度假测试项目");

    const list = await app.request("/api/v1/xhs-ops/projects");
    const listed = (await list.json()) as { projects: { id: string }[] };
    expect(listed.projects.map((p) => p.id)).toContain(created.id);

    const got = await app.request(`/api/v1/xhs-ops/projects/${created.id}`);
    expect(got.status).toBe(200);
    const one = (
      (await got.json()) as {
        project: { business: { industry: string } | null };
      }
    ).project;
    expect(one.business?.industry).toBe("亲子旅游");

    const missing = await app.request("/api/v1/xhs-ops/projects/nope");
    expect(missing.status).toBe(404);
  });

  it("account create under project path wins over body projectId", async () => {
    const app = buildApp();
    const projResp = (await (
      await app.request("/api/v1/xhs-ops/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "账号测试" }),
      })
    ).json()) as { project: { id: string } };
    const proj = projResp.project;

    const res = await app.request(
      `/api/v1/xhs-ops/projects/${proj.id}/accounts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "北京职场妈妈",
          positioning: "周末遛娃+亲子酒店",
          persona: {
            age: "32岁",
            gender: "女",
            region: "北京海淀",
            occupation: "互联网产品经理",
            lifeStatus: "2岁娃新手妈妈",
          },
          interestPool: {
            core: ["亲子酒店"],
            extended: ["周末遛娃"],
            general: ["咖啡"],
          },
        }),
      },
    );
    expect(res.status).toBe(200);
    const account = (
      (await res.json()) as {
        account: {
          id: string;
          projectId: string;
          interestPool: { core: string[] };
          persona: { age: string; lifeStatus: string };
        };
      }
    ).account;
    expect(account.projectId).toBe(proj.id);
    expect(account.interestPool.core).toEqual(["亲子酒店"]);
    expect(account.persona).toMatchObject({
      age: "32岁",
      lifeStatus: "2岁娃新手妈妈",
    });

    // 旧数据/未填 persona 时按空字符串补齐，兼容既有账号
    const legacy = await app.request(
      `/api/v1/xhs-ops/projects/${proj.id}/accounts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "无人设账号" }),
      },
    );
    const legacyAccount = (
      (await legacy.json()) as { account: { persona: Record<string, string> } }
    ).account;
    expect(legacyAccount.persona).toEqual({
      age: "",
      gender: "",
      region: "",
      occupation: "",
      lifeStatus: "",
    });
  });

  it("GET plan-suggest generates a plan per bound account and 404s for unknown projects", async () => {
    const app = buildApp();
    const proj = (
      (await (
        await app.request("/api/v1/xhs-ops/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "计划建议测试" }),
        })
      ).json()) as { project: { id: string } }
    ).project;
    const mk = (label: string, deviceId: string | null) =>
      app.request(`/api/v1/xhs-ops/projects/${proj.id}/accounts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label,
          deviceId,
          browseDefaults: { dailyTargetPosts: 0, dailySegments: 1 },
          interestPool: {
            core: ["亲子酒店", "周末遛娃", "带娃攻略"],
            extended: ["亲子旅行"],
            general: ["咖啡"],
          },
        }),
      });
    await mk("已绑定", "dev-1");
    await mk("未绑定", null);

    const res = await app.request(
      `/api/v1/xhs-ops/projects/${proj.id}/plan-suggest`,
    );
    expect(res.status).toBe(200);
    const { plans } = (await res.json()) as {
      plans: Array<{
        accountLabel: string;
        keywords: Array<{ keyword: string; count: number }>;
        homeFeedCount: number;
        rationale: string[];
      }>;
    };
    expect(plans.map((p) => p.accountLabel)).toEqual(["已绑定"]);
    expect(plans[0]?.keywords.map((k) => k.keyword)).toEqual([
      "亲子酒店",
      "周末遛娃",
      "带娃攻略",
      "亲子旅行",
      "咖啡",
    ]);
    expect(plans[0]?.homeFeedCount).toBe(6);
    expect(plans[0]?.rationale.join(" ")).toContain("搜索占比 80%");

    const missing = await app.request(
      "/api/v1/xhs-ops/projects/nope/plan-suggest",
    );
    expect(missing.status).toBe(404);
  });

  it("surfaces why media generation failed instead of the generic retry message", async () => {
    const failing = new XhsOpsProfileService({
      store,
      mediaRoot: tempDir,
      media: {
        generateText: async () => {
          throw new ImageGenerationFailedError("generation session failed");
        },
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () => null,
        executeTask: async () => {
          throw new Error("not used in route smoke test");
        },
        pushMedia: async () => ({ results: [] }),
      },
    });
    const app = buildApp({ xhsOpsProfileService: failing });
    const proj = (
      (await (
        await app.request("/api/v1/xhs-ops/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "生成失败" }),
        })
      ).json()) as { project: { id: string } }
    ).project;
    const account = (
      (await (
        await app.request(`/api/v1/xhs-ops/projects/${proj.id}/accounts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "失败账号", deviceId: "dev-fail" }),
        })
      ).json()) as { account: { id: string } }
    ).account;
    await prepareAccount(account.id);

    const res = await app.request(
      `/api/v1/xhs-ops/accounts/${account.id}/profile-draft/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: ["text"] }),
      },
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { message: string }).message).toContain(
      "模型服务不可用",
    );
  });

  it("profile-draft generation invalidates review and confirmation requires all eight fields", async () => {
    const app = buildApp();
    const proj = (
      (await (
        await app.request("/api/v1/xhs-ops/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "资料路由" }),
        })
      ).json()) as { project: { id: string } }
    ).project;
    const account = (
      (await (
        await app.request(`/api/v1/xhs-ops/projects/${proj.id}/accounts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "资料账号", deviceId: "dev-profile" }),
        })
      ).json()) as { account: { id: string } }
    ).account;

    await prepareAccount(account.id);
    const gen = await app.request(
      `/api/v1/xhs-ops/accounts/${account.id}/profile-draft/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: ["text"] }),
      },
    );
    expect(gen.status).toBe(200);
    const genned = (
      (await gen.json()) as {
        account: { profileDraft: { nickname: string; bio: string } };
      }
    ).account;
    expect(genned.profileDraft).toMatchObject({
      nickname: "路由昵称",
      bio: "路由简介",
    });

    const incompleteConfirm = await app.request(
      `/api/v1/xhs-ops/accounts/${account.id}/profile-draft/confirm`,
      { method: "POST" },
    );
    expect(incompleteConfirm.status).toBe(400);

    const completed = await app.request(
      `/api/v1/xhs-ops/accounts/${account.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileDraft: {
            ...genned.profileDraft,
            avatarPath: fixtureImage,
            coverPath: fixtureImage,
            avatarCandidates: [fixtureImage],
            coverCandidates: [fixtureImage],
            reviewedAt: "2000-01-01T00:00:00.000Z",
          },
        }),
      },
    );
    expect(
      (
        (await completed.json()) as {
          account: { profileDraft: { reviewedAt: string | null } };
        }
      ).account.profileDraft.reviewedAt,
    ).toBeNull();
    const confirmed = await app.request(
      `/api/v1/xhs-ops/accounts/${account.id}/profile-draft/confirm`,
      { method: "POST" },
    );
    expect(confirmed.status).toBe(200);
    expect(
      (
        (await confirmed.json()) as {
          account: { profileDraft: { reviewedAt: string | null } };
        }
      ).account.profileDraft.reviewedAt,
    ).not.toBeNull();

    const edited = await app.request(`/api/v1/xhs-ops/accounts/${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileDraft: {
          ...genned.profileDraft,
          bio: "编辑后简介",
          avatarPath: "/fixtures/avatar.png",
          coverPath: "/fixtures/cover.png",
        },
      }),
    });
    expect(
      (
        (await edited.json()) as {
          account: { profileDraft: { reviewedAt: string | null } };
        }
      ).account.profileDraft.reviewedAt,
    ).toBeNull();

    await app.request(`/api/v1/xhs-ops/accounts/${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileDraft: { nickname: "", bio: "" } }),
    });
    const apply = await app.request(
      `/api/v1/xhs-ops/accounts/${account.id}/profile-draft/apply`,
      { method: "POST" },
    );
    expect(apply.status).toBe(409);

    const missing = await app.request(
      "/api/v1/xhs-ops/accounts/nope/profile-draft/apply",
      {
        method: "POST",
      },
    );
    expect(missing.status).toBe(404);
  });

  it("strips forged profile apply metadata and keeps the run gate locked", async () => {
    const app = buildApp();
    const project = await store.createProject({ name: "资料门禁防伪" });
    const create = await app.request(
      `/api/v1/xhs-ops/projects/${project.id}/accounts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "防伪账号",
          deviceId: "dev-forged-profile",
          profileDraft: {
            nickname: "完整昵称",
            bio: "完整简介",
            avatarPath: "/fixtures/avatar.png",
            coverPath: "/fixtures/cover.png",
            appliedAt: "2026-09-01T00:00:00.000Z",
            applyStatus: "applied",
            applyResult: "伪造成功",
          },
        }),
      },
    );
    expect(create.status).toBe(200);
    const account = (
      (await create.json()) as {
        account: {
          id: string;
          profileDraft: {
            appliedAt: string | null;
            applyStatus: string | null;
            applyResult: string | null;
          };
        };
      }
    ).account;
    expect(account.profileDraft).toMatchObject({
      appliedAt: null,
      applyStatus: null,
      applyResult: null,
    });

    const forgedPatch = await app.request(
      `/api/v1/xhs-ops/accounts/${account.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileDraft: {
            nickname: "完整昵称",
            bio: "完整简介",
            avatarPath: "/fixtures/avatar.png",
            coverPath: "/fixtures/cover.png",
            appliedAt: "2026-09-01T00:00:00.000Z",
            applyStatus: "applied",
            applyResult: "伪造成功",
          },
        }),
      },
    );
    expect(forgedPatch.status).toBe(200);
    expect(
      (
        (await forgedPatch.json()) as {
          account: {
            profileDraft: {
              appliedAt: string | null;
              applyStatus: string | null;
              applyResult: string | null;
            };
          };
        }
      ).account.profileDraft,
    ).toMatchObject({ appliedAt: null, applyStatus: null, applyResult: null });

    const run = await app.request("/api/v1/xhs-ops/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        accountId: account.id,
        plan: {
          keywords: [{ keyword: "亲子酒店", count: 1 }],
          homeFeedCount: 0,
          dwellSecMin: 11,
          dwellSecMax: 20,
          interaction: {
            like: { enabled: false, dailyCap: 0, ratioPercent: 0 },
            collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
            follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
            comment: { enabled: false },
          },
        },
      }),
    });
    expect(run.status).toBe(409);
  });

  it("runs persist their segment and plan-suggest splits accounts with dailySegments>1 (P2-3)", async () => {
    const app = buildApp();
    const proj = (
      (await (
        await app.request("/api/v1/xhs-ops/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "分段测试" }),
        })
      ).json()) as { project: { id: string } }
    ).project;
    const account = (
      (await (
        await app.request(`/api/v1/xhs-ops/projects/${proj.id}/accounts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            label: "分段账号",
            deviceId: "dev-segments",
            profileDraft: {
              nickname: "分段账号",
              bio: "天秤座 INFJ｜分段测试",
              avatarPath: "/fixtures/avatar.png",
              coverPath: "/fixtures/cover.png",
              appliedAt: "2026-09-01T00:00:00.000Z",
              applyStatus: "applied",
            },
            interestPool: {
              core: ["亲子酒店", "周末遛娃", "带娃攻略", "周边游"],
              extended: [],
              general: [],
            },
            browseDefaults: { dailyTargetPosts: 40, dailySegments: 2 },
          }),
        })
      ).json()) as {
        account: {
          id: string;
          browseDefaults: { dailySegments: number; dailyTargetPosts: number };
        };
      }
    ).account;
    expect(account.browseDefaults).toMatchObject({
      dailyTargetPosts: 40,
      dailySegments: 2,
    });
    await prepareAccount(account.id, true);
    const confirmed = await app.request(
      `/api/v1/xhs-ops/accounts/${account.id}/profile-draft/confirm`,
      { method: "POST" },
    );
    expect(confirmed.status).toBe(200);

    const suggest = (await (
      await app.request(`/api/v1/xhs-ops/projects/${proj.id}/plan-suggest`)
    ).json()) as {
      plans: Array<{ segment: { index: number; count: number } | null }>;
    };
    expect(suggest.plans.map((p) => p.segment)).toEqual([
      { index: 1, count: 2 },
      { index: 2, count: 2 },
    ]);

    const created = (await (
      await app.request("/api/v1/xhs-ops/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: proj.id,
          accountId: account.id,
          segment: { index: 1, count: 2 },
          plan: {
            keywords: [{ keyword: "亲子酒店", count: 4 }],
            homeFeedCount: 0,
            dwellSecMin: 11,
            dwellSecMax: 20,
            interaction: {
              like: { enabled: false, dailyCap: 0, ratioPercent: 0 },
              collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
              follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
              comment: { enabled: false },
            },
          },
        }),
      })
    ).json()) as { run: { id: string; segment: unknown } };
    expect(created.run.segment).toEqual({ index: 1, count: 2 });
    const got = (await (
      await app.request(`/api/v1/xhs-ops/runs/${created.run.id}`)
    ).json()) as {
      run: { segment: unknown };
    };
    expect(got.run.segment).toEqual({ index: 1, count: 2 });

    // 第 1 段已有 planned run → 今日建议只剩第 2 段
    const again = (await (
      await app.request(`/api/v1/xhs-ops/projects/${proj.id}/plan-suggest`)
    ).json()) as { plans: Array<{ segment: { index: number } | null }> };
    expect(again.plans.map((p) => p.segment?.index)).toEqual([2]);
  });

  it("project schedule round-trips via PATCH and run-now dispatches nothing for a project without bound accounts (P2-4)", async () => {
    const app = buildApp();
    const proj = (
      (await (
        await app.request("/api/v1/xhs-ops/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "定时项目" }),
        })
      ).json()) as {
        project: { id: string; schedule: { enabled: boolean; time: string } };
      }
    ).project;
    expect(proj.schedule).toEqual({
      enabled: false,
      time: "10:00",
      lastTriggeredDate: null,
      lastResult: null,
    });

    const patched = (
      (await (
        await app.request(`/api/v1/xhs-ops/projects/${proj.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schedule: {
              enabled: true,
              time: "09:30",
              lastTriggeredDate: null,
              lastResult: null,
            },
          }),
        })
      ).json()) as { project: { schedule: { enabled: boolean; time: string } } }
    ).project;
    expect(patched.schedule).toMatchObject({ enabled: true, time: "09:30" });

    const bad = await app.request(`/api/v1/xhs-ops/projects/${proj.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schedule: { enabled: true, time: "9:30" } }),
    });
    expect(bad.status).toBe(400);

    const now = await app.request(
      `/api/v1/xhs-ops/projects/${proj.id}/schedule/run-now`,
      { method: "POST" },
    );
    expect(now.status).toBe(200);
    const body = (await now.json()) as {
      result: { planned: number; created: number; summary: string };
      project: {
        schedule: {
          lastTriggeredDate: string | null;
          lastResult: string | null;
        };
      };
    };
    expect(body.result).toMatchObject({ planned: 0, created: 0 });
    expect(body.project.schedule.lastTriggeredDate).not.toBeNull();
    expect(body.project.schedule.lastResult).toContain("手动");

    const missing = await app.request(
      "/api/v1/xhs-ops/projects/nope/schedule/run-now",
      { method: "POST" },
    );
    expect(missing.status).toBe(404);
  });

  it("comment queue: generate from a run's posts, quota gates approval, review is single-shot (P3-1 D1)", async () => {
    const app = buildApp();
    const proj = (
      (await (
        await app.request("/api/v1/xhs-ops/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "评论队列" }),
        })
      ).json()) as { project: { id: string } }
    ).project;
    const account = (
      (await (
        await app.request(`/api/v1/xhs-ops/projects/${proj.id}/accounts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            label: "评论账号",
            deviceId: "dev-comments",
            interaction: {
              like: { enabled: false, dailyCap: 0, ratioPercent: 0 },
              collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
              follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
              comment: { enabled: true, dailyCap: 2 },
            },
          }),
        })
      ).json()) as {
        account: {
          id: string;
          interaction: { comment: { enabled: boolean; dailyCap: number } };
        };
      }
    ).account;
    expect(account.interaction.comment).toEqual({ enabled: true, dailyCap: 2 });

    // 一个已完成 8 篇的浏览 run（直接落库，带 commentWorthy 标注）
    const run = await store.createRun({
      projectId: proj.id,
      accountId: account.id,
      deviceId: "dev-comments",
      accountLabel: "评论账号",
      date: new Date().toLocaleDateString("sv-SE"),
      status: "completed",
      plan: {
        keywords: [{ keyword: "亲子酒店", count: 8 }],
        homeFeedCount: 0,
        dwellSecMin: 11,
        dwellSecMax: 20,
        interaction: account.interaction as never,
      },
      segment: null,
      queuedBehindRunId: null,
      chunks: [
        {
          index: 0,
          mode: "search",
          keyword: "亲子酒店",
          plannedCount: 8,
          status: "completed",
          taskId: null,
          startedAt: null,
          completedAt: null,
          browsed: 8,
          skipped: 1,
          interactions: { like: 0, collect: 0, follow: 0 },
          anomalies: [],
          observation: null,
          message: null,
          totalSteps: 40,
          finalScreenshot: null,
          error: null,
          posts: [
            {
              title: "亲子房天花板！带娃住这太省事",
              author: "满哥铛弟",
              action: "none",
              commentsRead: 4,
              commentWorthy: true,
              summary: "两大一小套房，儿童洗漱用品齐全",
            },
            {
              title: "暑假避暑酒店TOP10",
              author: "乐妈",
              action: "skip",
              commentsRead: 0,
              commentWorthy: true,
              summary: "",
            },
            {
              title: "带娃住过最夯的亲子酒店",
              author: "吐司椰椰",
              action: "none",
              commentsRead: 448,
              commentWorthy: false,
              summary: "",
            },
            {
              title: "亲子酒店泳池体验",
              author: "旅行者",
              action: "none",
              commentsRead: 12,
              commentWorthy: true,
              summary: "",
            },
          ],
        },
      ],
      summary: {
        plannedTotal: 8,
        browsedTotal: 8,
        searchBrowsed: 8,
        homeBrowsed: 0,
        interactions: { like: 0, collect: 0, follow: 0 },
        anomalyCount: 0,
        durationMs: 1000,
      },
      notes: "",
      error: null,
      startedAt: null,
      completedAt: null,
    });

    const gen = await app.request(
      `/api/v1/xhs-ops/runs/${run.id}/comments/generate`,
      { method: "POST" },
    );
    expect(gen.status).toBe(200);
    const generated = (await gen.json()) as {
      drafts: Array<{
        id: string;
        candidates: string[];
        post: { title: string };
      }>;
      skipped: string[];
    };
    expect(generated.drafts).toHaveLength(2); // commentWorthy 且非 skip
    expect(generated.drafts[0]?.candidates).toHaveLength(3);
    expect(generated.skipped[0]).toContain("没看完");

    const list = (await (
      await app.request(`/api/v1/xhs-ops/projects/${proj.id}/comments`)
    ).json()) as {
      drafts: Array<{ status: string }>;
      quotas: Array<{ cap: number; remaining: number; byBrowse: number }>;
    };
    expect(list.drafts.map((d) => d.status)).toEqual(["pending", "pending"]);
    // 8 篇浏览 → byBrowse 1 → cap = min(2, 5, 1) = 1
    expect(list.quotas[0]).toMatchObject({ byBrowse: 1, cap: 1, remaining: 1 });

    const draftId = generated.drafts[0]?.id ?? "";
    const bad = await app.request(
      `/api/v1/xhs-ops/comments/${draftId}/review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          text: "加微信聊聊这家酒店",
        }),
      },
    );
    expect(bad.status).toBe(400);
    const ok = await app.request(`/api/v1/xhs-ops/comments/${draftId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "approved",
        text: "儿童用品齐全太省心",
      }),
    });
    expect(ok.status).toBe(200);
    const approved = (await ok.json()) as {
      draft: { status: string; text: string };
    };
    expect(approved.draft).toMatchObject({
      status: "approved",
      text: "儿童用品齐全太省心",
    });
    const again = await app.request(
      `/api/v1/xhs-ops/comments/${draftId}/review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      },
    );
    expect(again.status).toBe(409);

    const quota = (await (
      await app.request(`/api/v1/xhs-ops/accounts/${account.id}/comment-quota`)
    ).json()) as { quota: { remaining: number; approvedPending: number } };
    expect(quota.quota).toMatchObject({ approvedPending: 1, remaining: 0 });

    // 显式指定不适合评论的帖子时不生成草稿
    const skippedGen = (await (
      await app.request(`/api/v1/xhs-ops/runs/${run.id}/comments/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ posts: [{ chunkIndex: 0, postIndex: 2 }] }),
      })
    ).json()) as { drafts: Array<{ id: string }>; skipped: string[] };
    expect(skippedGen.drafts).toHaveLength(0);
    expect(skippedGen.skipped[0]).toContain("不适合评论");

    // 第二个草稿批准时配额已满 → 409
    const gen2 = generated.drafts[1];
    const full = await app.request(
      `/api/v1/xhs-ops/comments/${gen2?.id}/review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      },
    );
    expect(full.status).toBe(409);
  });
});
