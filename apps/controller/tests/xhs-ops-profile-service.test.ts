import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DeviceExecuteTaskBody,
  DevicePushMediaBody,
  TaskResult,
  XhsOpsAccount,
} from "@nexu/shared";
import { afterAll, describe, expect, it } from "vitest";
import {
  XhsOpsProfileService,
  buildProfileTextPrompt,
  diffProfileFields,
  parseProfileText,
  resolveBirthday,
} from "../src/services/xhs-ops-profile-service.js";
import { XHS_TASK_POLICY } from "../src/services/xhs-ops-run-service.js";
import {
  buildProfileApplyTask,
  parseProfileJson,
  parseProfileVerificationJson,
} from "../src/services/xhs-ops-task-builder.js";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";

const tempDir = mkdtempSync(join(tmpdir(), "xhs-ops-profile-"));
const mediaRoot = join(tempDir, "media");
mkdirSync(mediaRoot, { recursive: true });
const store = new XhsOpsStore(join(tempDir, "xhs-ops.json"));
const profile = {
  summary: "北京亲子家庭",
  base: { ageRange: "25–35", genderRatio: "女70%男30%", regions: ["北京"] },
  verticalInterests: ["亲子出游"],
  generalInterests: ["咖啡", "摄影"],
};

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

let nextDevice = 0;
async function seed(deviceId: string | null = `dev-${++nextDevice}`) {
  const project = await store.createProject({
    name: "资料测试",
    business: { industry: "亲子", product: "周末活动" },
    audience: {
      ageRange: "25–35",
      genderRatio: "女70%男30%",
      regions: ["北京"],
    },
    opsNotes: {
      forbiddenTopics: ["医美"],
      boostKeywords: [],
      avoidContentTypes: [],
    },
  });
  const account = await store.createAccount({
    projectId: project.id,
    label: "豆豆妈的周末计划",
    positioning: "零踩坑周末遛娃攻略",
    persona: {
      age: "32岁",
      gender: "女",
      region: "北京海淀",
      occupation: "互联网产品经理",
      lifeStatus: "2岁娃新手妈妈",
    },
    personaTags: { vertical: ["亲子出游"], general: ["咖啡", "摄影"] },
    platformAccountId: "xhs-target-001",
    deviceId,
    deviceName: deviceId,
    interestPool: {
      core: ["亲子酒店"],
      extended: ["周边游"],
      general: ["咖啡"],
    },
  });
  return { project, account };
}

async function preparePrerequisites(account: XhsOpsAccount) {
  const created = await store.getProject(account.projectId);
  if (!created) throw new Error("missing project fixture");
  const project = await store.confirmProfile(created.id, {
    profile,
    expectedUpdatedAt: created.updatedAt,
  });
  const latest = await store.getAccount(account.id);
  if (!latest) throw new Error("missing account fixture");
  const [reviewed] = await store.confirmPersonas(project.id, {
    accounts: [{ accountId: latest.id, expectedUpdatedAt: latest.updatedAt }],
    expectedUpdatedAt: project.updatedAt,
    distributionReviewed: true,
    reviewNote: "已核对测试人设",
  });
  if (!reviewed) throw new Error("missing reviewed account fixture");
  return reviewed;
}

async function prepareReadyAccount(
  account: XhsOpsAccount,
  patch: Partial<XhsOpsAccount["profileDraft"]> = {},
) {
  const reviewed = await preparePrerequisites(account);
  const [avatar] = fakeImages(`ready-avatar-${account.id}`);
  const [cover] = fakeImages(`ready-cover-${account.id}`);
  const drafted = await store.updateAccount(account.id, {
    profileDraft: {
      nickname: "豆豆妈的周末",
      bio: "天秤座 INFJ｜北京产品经理｜喜欢亲子出游咖啡摄影",
      gender: "女",
      birthday: "1994-01-01",
      region: "北京",
      interestTags: ["亲子出游", "咖啡"],
      avatarCandidates: [avatar ?? ""],
      coverCandidates: [cover ?? ""],
      avatarPath: avatar ?? null,
      coverPath: cover ?? null,
      ...patch,
    },
  });
  if (!drafted || !reviewed.personaReviewedAt)
    throw new Error("missing ready account fixture");
  const ready = await store.confirmProfileDraft(account.id);
  if (!ready) throw new Error("missing confirmed draft fixture");
  return ready;
}

function preparationResult(): TaskResult {
  return {
    taskId: "profile-preparation",
    success: true,
    message:
      'PREPARATION_JSON:{"v":1,"status":"ready","code":"ready","profileVerified":true}',
  };
}

function applyResult(): TaskResult {
  return {
    taskId: "profile-apply",
    success: true,
    message:
      'PROFILE_JSON:{"nickname":"done","bio":"done","avatar":"done","cover":"done","gender":"done","birthday":"done","region":"done","interestTags":"done","note":"ok"}',
  };
}

function verificationResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: "profile-verification",
    success: true,
    message:
      'PROFILE_VERIFICATION_JSON:{"v":1,"status":"verified","accountMatched":true,"fields":{"nickname":true,"bio":true,"avatar":true,"cover":true,"gender":true,"birthday":true,"region":true,"interestTags":true}}',
    finalScreenshot: "verified-screen.png",
    ...overrides,
  };
}

function resultForTask(body: DeviceExecuteTaskBody): TaskResult {
  if (body.task.includes("PROFILE_VERIFICATION_JSON:"))
    return verificationResult();
  if (body.task.includes("PROFILE_JSON:")) return applyResult();
  return preparationResult();
}

function fakeImages(prefix: string): string[] {
  return [1, 2, 3].map((i) => {
    const p = join(mediaRoot, `${prefix}-${i}.png`);
    writeFileSync(p, Buffer.from(`png-${prefix}-${i}`));
    return p;
  });
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("XhsOpsProfileService.generate", () => {
  it("keeps newer operator edits when a slow generation returns", async () => {
    const { account } = await seed();
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async (_id, body) => ({ result: resultForTask(body) }),
        pushMedia: async () => ({ results: [] }),
      },
      media: {
        generateText: async () => {
          await store.updateAccount(account.id, {
            profileDraft: { nickname: "运营新稿" },
          });
          return { text: '{"nickname":"过期生成结果","bio":"旧简介"}' };
        },
        generateImage: async () => ({ path: "", items: [] }),
      },
    });
    await expect(svc.generate(account.id, ["text"])).rejects.toMatchObject({
      status: 409,
    });
    expect((await store.getAccount(account.id))?.profileDraft.nickname).toBe(
      "运营新稿",
    );
  });
  it("fills nickname/bio from text generation and 3 candidates per image slot", async () => {
    const { account: created } = await seed();
    const account = await prepareReadyAccount(created);
    expect(account.profileDraft.reviewedAt).not.toBeNull();
    const prompts: string[] = [];
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async (_id, body) => ({ result: resultForTask(body) }),
        pushMedia: async () => ({ results: [] }),
      },
      media: {
        generateText: async ({ prompt }) => {
          prompts.push(prompt);
          return {
            text: '好的：{"nickname":"豆豆妈的周末","bio":"天秤座 INFJ｜海淀二娃妈｜周末专治不知道去哪"}',
          };
        },
        generateImage: async ({ prompt, count, aspectRatio }) => {
          prompts.push(`${aspectRatio}:${count}:${prompt.slice(0, 12)}`);
          const paths = fakeImages(aspectRatio === "1:1" ? "avatar" : "cover");
          return {
            path: paths[0] ?? "",
            items: paths.map((p) => ({ path: p })),
          };
        },
      },
      now: () => Date.parse("2026-09-04T12:00:00Z"),
    });
    const updated = await svc.generate(account.id, ["text", "avatar", "cover"]);
    expect(updated.profileDraft.nickname).toBe("豆豆妈的周末");
    expect(updated.profileDraft.bio).toContain("INFJ");
    expect(updated.profileDraft.avatarCandidates).toHaveLength(3);
    expect(updated.profileDraft.coverCandidates).toHaveLength(3);
    expect(updated.profileDraft.generatedAt).toBe("2026-09-04T12:00:00.000Z");
    expect(updated.profileDraft.reviewedAt).toBeNull();
    // 文本提示词带人设、禁忌与三段简介要求；头像 1:1、背景 16:9
    expect(prompts[0]).toContain("32岁·女·北京海淀");
    expect(prompts[0]).toContain("医美");
    expect(prompts[1]).toMatch(/^1:1:3:/);
    expect(prompts[2]).toMatch(/^16:9:3:/);
  });

  it("keeps text and avatars that already succeeded when the cover fails", async () => {
    const { account } = await seed();
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async (_id, body) => ({ result: resultForTask(body) }),
        pushMedia: async () => ({ results: [] }),
      },
      media: {
        generateText: async () => ({
          text: '{"nickname":"周末遛娃图鉴","bio":"天秤座 INFJ｜海淀二娃妈"}',
        }),
        generateImage: async ({ aspectRatio }) => {
          if (aspectRatio === "16:9")
            throw new Error("generation session failed");
          const paths = fakeImages("partial-avatar");
          return {
            path: paths[0] ?? "",
            items: paths.map((p) => ({ path: p })),
          };
        },
      },
      now: () => Date.parse("2026-09-10T12:00:00Z"),
    });

    await expect(
      svc.generate(account.id, ["text", "avatar", "cover"]),
    ).rejects.toThrow("generation session failed");

    const saved = await store.getAccount(account.id);
    expect(saved?.profileDraft.nickname).toBe("周末遛娃图鉴");
    expect(saved?.profileDraft.avatarCandidates).toHaveLength(3);
    expect(saved?.profileDraft.coverCandidates).toHaveLength(0);
  });

  it("tops up an unreviewed partial candidate set instead of regenerating it", async () => {
    const { account } = await seed();
    const requested: number[] = [];
    const makeSvc = (produce: number) =>
      new XhsOpsProfileService({
        store,
        mediaRoot,
        deviceControl: {
          getDevice: async () => null,
          executeTask: async (_id, body) => ({ result: resultForTask(body) }),
          pushMedia: async () => ({ results: [] }),
        },
        media: {
          generateText: async () => ({ text: "{}" }),
          generateImage: async ({ count }) => {
            requested.push(count ?? 0);
            const paths = fakeImages(
              `topup-${produce}-${requested.length}`,
            ).slice(0, produce);
            return {
              path: paths[0] ?? "",
              items: paths.map((p) => ({ path: p })),
            };
          },
        },
        now: () => Date.parse("2026-09-10T12:00:00Z"),
      });

    // First run only manages 1 of the 3 candidates.
    await makeSvc(1).generate(account.id, ["avatar"]);
    expect(
      (await store.getAccount(account.id))?.profileDraft.avatarCandidates,
    ).toHaveLength(1);

    // Second run asks for the 2 that are missing and keeps the first.
    const after = await makeSvc(2).generate(account.id, ["avatar"]);
    expect(requested).toEqual([3, 2]);
    expect(after.profileDraft.avatarCandidates).toHaveLength(3);
  });

  it("regenerates a fresh set once the operator has selected a candidate", async () => {
    const { account: created } = await seed();
    // prepareReadyAccount leaves a single, selected, reviewed candidate.
    const account = await prepareReadyAccount(created);
    const requested: number[] = [];
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async (_id, body) => ({ result: resultForTask(body) }),
        pushMedia: async () => ({ results: [] }),
      },
      media: {
        generateText: async () => ({ text: "{}" }),
        generateImage: async ({ count }) => {
          requested.push(count ?? 0);
          const paths = fakeImages("fresh-avatar");
          return {
            path: paths[0] ?? "",
            items: paths.map((p) => ({ path: p })),
          };
        },
      },
      now: () => Date.parse("2026-09-10T12:00:00Z"),
    });

    const after = await svc.generate(account.id, ["avatar"]);
    expect(requested).toEqual([3]);
    expect(after.profileDraft.avatarCandidates).toHaveLength(3);
    // The old selection is not in the new set, so it is cleared.
    expect(after.profileDraft.avatarPath).toBeNull();
  });

  it("readIdentity returns the 编辑主页 screenshot without echoing the account id", async () => {
    const { account } = await seed();
    const tasks: string[] = [];
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async (_id, body) => {
          tasks.push(body.task);
          return {
            result: {
              taskId: "identity-1",
              success: true,
              finalScreenshot: "/var/shots/edit-profile.png",
              message:
                'IDENTITY_JSON:{"v":1,"status":"visible","accountId":"49268961587"}',
            },
          };
        },
        pushMedia: async () => ({ results: [] }),
      },
      media: {
        generateText: async () => ({ text: "{}" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
    });

    const identity = await svc.readIdentity(account.id);
    expect(identity.status).toBe("visible");
    expect(identity.screenshotUrl).toBe(
      "/api/v1/media/screenshots/edit-profile.png",
    );
    expect(identity.accountId).toBe("49268961587");
    // Read-only, and the id is confined to the structured last line.
    expect(tasks[0]).toContain("不修改、不保存、不登录");
    expect(tasks[0]).toContain(
      "小红书号只能出现在最后一行 JSON 的 accountId 字段里",
    );
    // The completion screenshot is the deliverable, so it must not go HOME first.
    expect(tasks[0]).toContain("必须停留在编辑主页上直接 COMPLETE");
  });

  it("readIdentity rejects an id that is not an id, rather than prefilling prose", async () => {
    const { account } = await seed();
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async () => ({
          result: {
            taskId: "identity-3",
            success: true,
            finalScreenshot: "/var/shots/edit.png",
            message:
              'IDENTITY_JSON:{"v":1,"status":"visible","accountId":"页面上没看清"}',
          },
        }),
        pushMedia: async () => ({ results: [] }),
      },
      media: {
        generateText: async () => ({ text: "{}" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
    });

    const identity = await svc.readIdentity(account.id);
    expect(identity.status).toBe("visible");
    expect(identity.accountId).toBe("");
    expect(identity.reason).toContain("没读出小红书号");
  });

  it("readIdentity reports unavailable instead of failing when no screenshot came back", async () => {
    const { account } = await seed();
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async () => ({
          result: { taskId: "identity-2", success: true },
        }),
        pushMedia: async () => ({ results: [] }),
      },
      media: {
        generateText: async () => ({ text: "{}" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
    });

    const identity = await svc.readIdentity(account.id);
    expect(identity.status).toBe("unavailable");
    expect(identity.screenshotUrl).toBeNull();
    expect(identity.reason).toContain("没有取到编辑主页截图");
  });

  it("readIdentity refuses an account with no bound device", async () => {
    const { account } = await seed(null);
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async () => {
          throw new Error("must not dispatch without a device");
        },
        pushMedia: async () => ({ results: [] }),
      },
      media: {
        generateText: async () => ({ text: "{}" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
    });

    await expect(svc.readIdentity(account.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("diffs the phone's current profile against the draft", () => {
    const rows = diffProfileFields(
      {
        nickname: "新昵称",
        bio: "新简介",
        gender: "男",
        birthday: "1998-03-02",
        region: "上海",
        interestTags: ["羽毛球", "约球"],
        avatarPath: "/media/outbound/a/tabby-image/pick.png",
        coverPath: null,
      } as never,
      {
        nickname: "旧昵称",
        bio: "",
        gender: "男",
        birthday: "",
        region: "上海",
        // Same set, different order — not a change.
        interestTags: ["约球", "羽毛球"],
      },
    );
    const byField = Object.fromEntries(rows.map((r) => [r.field, r]));
    // Phone has a different value -> a real overwrite.
    expect(byField.nickname).toMatchObject({ phone: "旧昵称", differs: true });
    // Phone empty -> filling a blank, still a change.
    expect(byField.bio).toMatchObject({ phone: "", differs: true });
    // Identical -> nothing to do.
    expect(byField.gender?.differs).toBe(false);
    expect(byField.region?.differs).toBe(false);
    expect(byField.interestTags?.differs).toBe(false);
    // Images cannot be compared; a selected one still counts as a write.
    expect(byField.avatar).toMatchObject({ comparable: false, differs: true });
    expect(byField.cover).toMatchObject({ comparable: false, differs: false });
  });

  it("readbackProfile surfaces the phone's values without asking for 小红书号", async () => {
    const { account } = await seed();
    const tasks: string[] = [];
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async (_id, body) => {
          tasks.push(body.task);
          return {
            result: {
              taskId: "readback-1",
              success: true,
              finalScreenshot: "/var/shots/edit.png",
              message:
                'PROFILE_READBACK_JSON:{"v":1,"status":"read","nickname":"云朵漫游簿","bio":"","gender":"","birthday":"","region":"","interestTags":[]}',
            },
          };
        },
        pushMedia: async () => ({ results: [] }),
      },
      media: {
        generateText: async () => ({ text: "{}" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
    });

    const readback = await svc.readbackProfile(account.id);
    expect(readback.status).toBe("read");
    expect(readback.screenshotUrl).toBe("/api/v1/media/screenshots/edit.png");
    expect(readback.fields.find((f) => f.field === "nickname")?.phone).toBe(
      "云朵漫游簿",
    );
    expect(tasks[0]).toContain("不得读取或回传小红书号");
    expect(tasks[0]).toContain("必须停留在编辑资料页上直接 COMPLETE");
  });

  it("readbackProfile reports unavailable when the receipt is unusable", async () => {
    const { account } = await seed();
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async () => ({
          result: { taskId: "readback-2", success: true, message: "读不到" },
        }),
        pushMedia: async () => ({ results: [] }),
      },
      media: {
        generateText: async () => ({ text: "{}" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
    });

    const readback = await svc.readbackProfile(account.id);
    expect(readback.status).toBe("unavailable");
    expect(readback.fields).toEqual([]);
  });

  it("parseProfileText tolerates prose around the JSON and falls back to lines", () => {
    expect(
      parseProfileText(
        '这是结果：{"nickname":"桃子爸爸","bio":"射手 ENFP"} 以上',
      ),
    ).toEqual({
      nickname: "桃子爸爸",
      bio: "射手 ENFP",
      gender: "",
      region: "",
      interestTags: [],
      birthday: "",
    });
    expect(parseProfileText("桃子爸爸\n射手 ENFP｜金融奶爸")).toEqual({
      nickname: "桃子爸爸",
      bio: "射手 ENFP｜金融奶爸",
      gender: "",
      region: "",
      interestTags: [],
      birthday: "",
    });
  });

  it("parseProfileText reads gender, region and interest tags", () => {
    expect(
      parseProfileText(
        '{"nickname":"老许","bio":"处女座 ISTJ","gender":"男","region":"上海 ","interestTags":["羽毛球","羽毛球","装备避坑","  "]}',
      ),
    ).toEqual({
      nickname: "老许",
      bio: "处女座 ISTJ",
      gender: "男",
      // Deduped, trimmed, blanks dropped.
      region: "上海",
      interestTags: ["羽毛球", "装备避坑"],
      birthday: "",
    });
    // An unusable gender is dropped rather than written into the draft enum.
    expect(
      parseProfileText('{"nickname":"n","bio":"b","gender":"男性"}').gender,
    ).toBe("");
    // A comma string is accepted as well as an array.
    expect(
      parseProfileText('{"nickname":"n","bio":"b","interestTags":"跑步，健身"}')
        .interestTags,
    ).toEqual(["跑步", "健身"]);
  });

  it("fills gender, region, tags and a persona-consistent birthday", async () => {
    const { account } = await seed();
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async (_id, body) => ({ result: resultForTask(body) }),
        pushMedia: async () => ({ results: [] }),
      },
      media: {
        generateText: async () => ({
          text: '{"nickname":"老许","bio":"处女座 ISTJ｜浦东产品","gender":"男","region":"上海","interestTags":["羽毛球","下班约球"],"birthday":"1998-03-02"}',
        }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      now: () => Date.parse("2026-09-10T12:00:00Z"),
    });

    const updated = await svc.generate(account.id, ["text"]);
    expect(updated.profileDraft.gender).toBe("男");
    expect(updated.profileDraft.region).toBe("上海");
    expect(updated.profileDraft.interestTags).toEqual(["羽毛球", "下班约球"]);
    // Persona age is 32岁 and "now" is 2026-09-10; 03-02 has already passed
    // this year, so the birth year is 2026-32. The model's own year is ignored.
    expect(updated.profileDraft.birthday).toBe("1994-03-02");
  });

  it("resolveBirthday keeps the star-sign month/day and re-derives the year", () => {
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    // Already had its birthday this year.
    expect(resolveBirthday("2000-03-02", "27岁", now)).toBe("1999-03-02");
    // Birthday still ahead this year, so the birth year shifts back one.
    expect(resolveBirthday("2000-12-25", "27岁", now)).toBe("1998-12-25");
    // An age range takes the first bound.
    expect(resolveBirthday("2000-01-05", "28-32岁", now)).toBe("1998-01-05");
    // No usable age: the model's own year stands, as long as it is a real past date.
    expect(resolveBirthday("1994-07-01", "", now)).toBe("1994-07-01");
    // Nothing usable -> left for the operator rather than invented.
    expect(resolveBirthday("", "27岁", now)).toBe("");
    expect(resolveBirthday("九月二日", "27岁", now)).toBe("");
    // Not a real calendar date.
    expect(resolveBirthday("2000-02-30", "27岁", now)).toBe("");
    // Never returns a future date.
    expect(resolveBirthday("2030-01-01", "", now)).toBe("");
  });

  it("does not overwrite fields the operator already filled in", async () => {
    const { account } = await seed();
    const seeded = await store.updateAccount(account.id, {
      profileDraft: {
        gender: "不展示",
        region: "北京",
        interestTags: ["咖啡"],
        birthday: "1990-05-06",
      },
    });
    if (!seeded) throw new Error("missing fixture");
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async (_id, body) => ({ result: resultForTask(body) }),
        pushMedia: async () => ({ results: [] }),
      },
      media: {
        generateText: async () => ({
          text: '{"nickname":"老许","bio":"处女座 ISTJ","gender":"男","region":"上海","interestTags":["羽毛球"],"birthday":"1999-03-02"}',
        }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      now: () => Date.parse("2026-09-10T12:00:00Z"),
    });

    const updated = await svc.generate(seeded.id, ["text"]);
    expect(updated.profileDraft.gender).toBe("不展示");
    expect(updated.profileDraft.region).toBe("北京");
    expect(updated.profileDraft.interestTags).toEqual(["咖啡"]);
    expect(updated.profileDraft.birthday).toBe("1990-05-06");
    expect(updated.profileDraft.nickname).toBe("老许");
  });

  it("passes the operator's prompt hint through to image generation", async () => {
    const { account } = await seed();
    const prompts: string[] = [];
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      deviceControl: {
        getDevice: async () => null,
        executeTask: async (_id, body) => ({ result: resultForTask(body) }),
        pushMedia: async () => ({ results: [] }),
      },
      media: {
        generateText: async () => ({ text: "{}" }),
        generateImage: async ({ prompt }) => {
          prompts.push(prompt);
          const paths = fakeImages("hinted");
          return {
            path: paths[0] ?? "",
            items: paths.map((p) => ({ path: p })),
          };
        },
      },
      now: () => Date.parse("2026-09-10T12:00:00Z"),
    });

    await svc.generate(account.id, ["avatar"], { avatarPrompt: "  戴眼镜  " });
    expect(prompts[0]).toContain("真实感人像半身照");
    expect(prompts[0]).toContain("补充要求（优先满足）：戴眼镜");
  });

  it("buildProfileTextPrompt bars star-sign symbols so the bio matches the birthday", async () => {
    const { project, account } = await seed();
    const prompt = buildProfileTextPrompt(project, account, "2026-09-10");
    expect(prompt).toContain("星座只写中文名");
    expect(prompt).toContain("不要 ♈♉♊ 这类星座符号或 emoji");
    // The birthday rule needs today's date to place the birth year.
    expect(prompt).toContain("今天是 2026-09-10");
  });

  it("buildProfileTextPrompt forbids marketing and includes the interest pool", async () => {
    const { project, account } = await seed();
    const prompt = buildProfileTextPrompt(project, account);
    expect(prompt).toContain("亲子酒店");
    expect(prompt).toContain("禁止营销话术");
  });

  it("confirms only complete drafts within the nickname and bio limits", async () => {
    const { account: created } = await seed();
    const account = await preparePrerequisites(created);
    const [avatar] = fakeImages("invalid-avatar");
    const [cover] = fakeImages("invalid-cover");
    await store.updateAccount(account.id, {
      profileDraft: {
        ...account.profileDraft,
        nickname: "超过二十个字符的账号昵称超过二十个字符的账号昵称",
        bio: "完整简介",
        gender: "女",
        birthday: "1994-01-01",
        region: "北京",
        interestTags: ["亲子"],
        avatarCandidates: [avatar ?? ""],
        coverCandidates: [cover ?? ""],
        avatarPath: avatar ?? null,
        coverPath: cover ?? null,
      },
    });
    await expect(store.confirmProfileDraft(account.id)).rejects.toMatchObject({
      status: 400,
      message: "请先完成账号资料与素材并校验确认",
    });

    await store.updateAccount(account.id, {
      profileDraft: {
        ...account.profileDraft,
        nickname: "合规昵称",
        bio: "简介".repeat(51),
        gender: "女",
        birthday: "1994-01-01",
        region: "北京",
        interestTags: ["亲子"],
        avatarCandidates: [avatar ?? ""],
        coverCandidates: [cover ?? ""],
        avatarPath: avatar ?? null,
        coverPath: cover ?? null,
      },
    });
    await expect(store.confirmProfileDraft(account.id)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("XhsOpsProfileService.apply", () => {
  it("stops before editing the phone when upstream inputs change during preparation", async () => {
    const { account: created } = await seed();
    const account = await prepareReadyAccount(created);
    const executed: DeviceExecuteTaskBody[] = [];
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () =>
          ({ status: "idle", lastSeen: Date.now() }) as never,
        pushMedia: async () => ({ results: [] }),
        executeTask: async (_id, body) => {
          executed.push(body);
          await store.updateProject(account.projectId, {
            business: { industry: "运动", product: "网球" },
          });
          return { result: resultForTask(body) };
        },
      },
    });
    await expect(svc.apply(account.id)).rejects.toMatchObject({ status: 409 });
    expect(executed).toHaveLength(1);
    expect(executed[0]?.task).not.toContain("PROFILE_JSON:");
    expect(
      (await store.getAccount(account.id))?.profileDraft.verifiedAt,
    ).toBeNull();
  });
  it("pushes the selected images to the phone, dispatches the profile task and records the outcome", async () => {
    const { account: created } = await seed();
    const [avatar] = fakeImages("sel-avatar");
    const account = await prepareReadyAccount(created, {
      avatarCandidates: [avatar ?? ""],
      avatarPath: avatar ?? null,
    });
    let pushed: DevicePushMediaBody | null = null;
    const executed: DeviceExecuteTaskBody[] = [];
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () => ({ deviceId: "dev-1", status: "idle" }) as never,
        pushMedia: async (_id, body) => {
          pushed = body;
          return {
            results: body.images.map((i) => ({
              mediaId: i.filename,
              success: true,
            })),
          };
        },
        executeTask: async (_id, body) => {
          executed.push(body);
          return { result: resultForTask(body) };
        },
      },
      now: () => Date.parse("2026-09-04T13:00:00Z"),
    });
    const updated = await svc.apply(account.id);
    expect(pushed).not.toBeNull();
    const img = (pushed as unknown as DevicePushMediaBody).images[0];
    expect(img?.filename).toMatch(/^tabby-avatar-[0-9a-f]{8}\.png$/);
    expect(img?.mimeType).toBe("image/png");
    expect(Buffer.from(img?.dataBase64 ?? "", "base64").toString()).toBe(
      "png-sel-avatar-1",
    );
    expect(executed).toHaveLength(3);
    const task = executed[1]?.task ?? "";
    expect(task).toContain("豆豆妈的周末");
    // The filename still drives the push (the phone needs a name to write), but
    // it is deliberately absent from the task text: the picker shows no
    // filenames, so naming one there only invited a guess.
    expect(img?.filename).toBeTruthy();
    expect(task).not.toContain(img?.filename ?? "__never__");
    expect(task).toContain("背景图：只点");
    expect(task).toContain(account.platformAccountId);
    expect(executed[2]?.task).toContain("资料只读验收");
    expect(task).toContain("PROFILE_JSON:");
    expect(executed[1]?.taskPolicy?.confirmationPolicy?.publish).toBe(
      "forbidden",
    );
    expect(updated.profileDraft.applyStatus).toBe("applied");
    expect(updated.profileDraft.appliedAt).toBe("2026-09-04T13:00:00.000Z");
    expect(updated.profileDraft.applyResult).toBe(
      "八项资料与目标账号已完成只读核验",
    );
    expect(updated.profileDraft.verifiedAccountId).toBe(
      account.platformAccountId,
    );
    expect(updated.profileDraft.verificationTaskId).toBe(
      "profile-verification",
    );

    const relabeled = await store.updateAccount(account.id, {
      label: "豆豆妈的周末计划（已更新）",
    });
    expect(relabeled?.profileDraft).toMatchObject({
      appliedAt: null,
      applyStatus: null,
      applyResult: null,
      verifiedAt: null,
    });
  });

  it("does not overwrite a newer draft when a slow apply finishes", async () => {
    const { account: created } = await seed();
    const account = await prepareReadyAccount(created, {
      nickname: "旧昵称",
    });
    const started = deferred();
    const finish = deferred();
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () => ({ status: "idle" }) as never,
        pushMedia: async () => ({ results: [] }),
        executeTask: async (_id, body) => {
          if (!body.task.includes("PROFILE_JSON:")) {
            return { result: resultForTask(body) };
          }
          started.resolve();
          await finish.promise;
          return { result: applyResult() };
        },
      },
    });

    const applying = svc.apply(account.id);
    await started.promise;
    const latest = await store.getAccount(account.id);
    await expect(
      store.updateAccount(account.id, {
        profileDraft: {
          ...latest?.profileDraft,
          nickname: "新昵称",
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    finish.resolve();

    await expect(applying).resolves.toMatchObject({
      profileDraft: {
        nickname: "旧昵称",
        applyStatus: "applied",
        applyOperation: { status: "completed" },
      },
    });
  });

  it("does not mark the profile verified without screenshot or successful navigation evidence", async () => {
    const { account: created } = await seed();
    const account = await prepareReadyAccount(created);
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () => ({ status: "idle" }) as never,
        pushMedia: async () => ({ results: [] }),
        executeTask: async (_id, body) => ({
          result: body.task.includes("PROFILE_VERIFICATION_JSON:")
            ? verificationResult({ finalScreenshot: undefined, steps: [] })
            : resultForTask(body),
        }),
      },
    });

    await expect(svc.apply(account.id)).resolves.toMatchObject({
      profileDraft: {
        applyStatus: "partial",
        verifiedAt: null,
        verifiedAccountId: null,
        verificationTaskId: null,
      },
    });
  });

  it("does not reconcile a live in-process apply, then settles it after the binding is released", async () => {
    const { account: created } = await seed();
    const ready = await prepareReadyAccount(created);
    if (!ready.deviceId) throw new Error("missing device fixture");
    const claimed = await store.beginProfileApply(
      ready.id,
      ready.updatedAt,
      ready.deviceId,
    );
    const release = await store.acquireDeviceBinding(ready.id, ready.deviceId);
    await expect(
      store.updateAccount(ready.id, { label: "不应覆盖" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(store.deleteAccount(ready.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      store.updateProject(ready.projectId, { name: "不应覆盖" }),
    ).rejects.toMatchObject({ status: 409 });
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () =>
          ({
            status: "idle",
            currentTaskId: null,
            lastSeen: Date.now(),
          }) as never,
        executeTask: async (_id, body) => ({ result: resultForTask(body) }),
        pushMedia: async () => ({ results: [] }),
      },
    });

    const stillRunning = await svc.reconcile(claimed.id);
    expect(stillRunning?.profileDraft.applyOperation?.status).toBe("running");
    release();

    const settled = await svc.reconcile(claimed.id);
    expect(settled?.profileDraft.applyStatus).toBe("failed");
    expect(settled?.profileDraft.applyOperation?.status).toBe("completed");
    expect(settled?.profileDraft.applyResult).toContain("未收到手机任务结果");
  });

  it("rejects draft confirmation while a profile operation is running", async () => {
    const { account: created } = await seed();
    const ready = await prepareReadyAccount(created);
    if (!ready.deviceId) throw new Error("missing device fixture");
    const claimed = await store.beginProfileApply(
      ready.id,
      ready.updatedAt,
      ready.deviceId,
    );

    await expect(store.confirmProfileDraft(ready.id)).rejects.toMatchObject({
      status: 409,
    });
    const operationId = claimed.profileDraft.applyOperation?.operationId;
    if (!operationId) throw new Error("missing operation fixture");
    await store.completeProfileApply(ready.id, operationId, {
      applyStatus: "failed",
      applyResult: "test cleanup",
      appliedAt: null,
    });
  });

  it("stops before media push when preparation cannot prove the target account", async () => {
    const { account: created } = await seed();
    const account = await prepareReadyAccount(created);
    let pushed = false;
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () => ({ status: "idle" }) as never,
        pushMedia: async () => {
          pushed = true;
          return { results: [] };
        },
        executeTask: async () => ({
          result: {
            taskId: "wrong-account",
            success: false,
            message:
              'PREPARATION_JSON:{"v":1,"status":"failed","code":"account_mismatch","profileVerified":false}',
          },
        }),
      },
    });

    await expect(svc.apply(account.id)).rejects.toMatchObject({ status: 409 });
    expect(pushed).toBe(false);
  });

  it("refuses when unbound, incomplete, or the device is busy", async () => {
    const { account: unbound } = await seed(null);
    const svcBase = {
      store,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
    };
    const svc = new XhsOpsProfileService({
      ...svcBase,
      deviceControl: {
        getDevice: async () => ({ status: "busy" }) as never,
        pushMedia: async () => ({ results: [] }),
        executeTask: async (_id, body) => ({ result: resultForTask(body) }),
      },
    });
    await expect(svc.apply(unbound.id)).rejects.toMatchObject({ status: 400 });

    const { account: incomplete } = await seed();
    await expect(svc.apply(incomplete.id)).rejects.toMatchObject({
      status: 409,
    });
    const account = await prepareReadyAccount(incomplete);
    await expect(svc.apply(account.id)).rejects.toMatchObject({ status: 409 }); // 设备忙
  });

  it("lets a selection of only gender/birthday/region/interestTags pass the empty-selection guard", async () => {
    const { account: created } = await seed();
    const account = await prepareReadyAccount(created);
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () => ({ status: "busy" }) as never,
        pushMedia: async () => ({ results: [] }),
        executeTask: async (_id, body) => ({ result: resultForTask(body) }),
      },
    });
    // 只勾后四个字段：守卫必须放行，随后撞到"设备忙"的 409，而不是 400
    await expect(
      svc.apply(account.id, ["region", "interestTags"]),
    ).rejects.toMatchObject({ status: 409 });
    await expect(svc.apply(account.id, ["gender"])).rejects.toMatchObject({
      status: 409,
    });
    await expect(svc.apply(account.id, ["birthday"])).rejects.toMatchObject({
      status: 409,
    });
    // 「勾了但草稿为空」这条 400 分支在 ready 账号上不可达：store 本身就不允许
    // region/interestTags 为空的账号进入 ready（见 xhsOpsProfileDraftMissingFields）。
  });

  it("rejects images outside the media root", async () => {
    const { account: created } = await seed();
    const outside = join(tempDir, "outside.png");
    writeFileSync(outside, "x");
    const account = await prepareReadyAccount(created, {
      avatarPath: outside,
      avatarCandidates: [outside],
    });
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () => ({ status: "idle" }) as never,
        pushMedia: async () => ({ results: [] }),
        executeTask: async (_id, body) => ({ result: resultForTask(body) }),
      },
    });
    await expect(svc.apply(account.id)).rejects.toMatchObject({ status: 400 });
  });

  it("blocks device transfer while apply is executing and releases after success", async () => {
    const { account: created } = await seed();
    const account = await prepareReadyAccount(created);
    const targetProject = await store.createProject({ name: "转移目标" });
    const target = await store.createAccount({
      projectId: targetProject.id,
      label: "目标账号",
    });
    const started = deferred();
    const finish = deferred();
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () => ({ status: "idle" }) as never,
        pushMedia: async () => ({ results: [] }),
        executeTask: async (_id, body) => {
          if (!body.task.includes("PROFILE_JSON:")) {
            return { result: resultForTask(body) };
          }
          started.resolve();
          await finish.promise;
          return { result: applyResult() };
        },
      },
    });

    const applying = svc.apply(account.id);
    await started.promise;
    await expect(
      store.transferDevice(targetProject.id, {
        fromAccountId: account.id,
        toAccountId: target.id,
        account: {
          label: target.label,
          deviceId: account.deviceId ?? "",
        },
      }),
    ).rejects.toMatchObject({ status: 409 });

    finish.resolve();
    await expect(applying).resolves.toMatchObject({
      profileDraft: { applyStatus: "applied" },
    });
    await expect(
      store.transferDevice(targetProject.id, {
        fromAccountId: account.id,
        toAccountId: target.id,
        account: {
          label: target.label,
          deviceId: account.deviceId ?? "",
        },
      }),
    ).resolves.toMatchObject({ id: target.id, deviceId: account.deviceId });
  });

  it("keeps mutations blocked after an uncertain phone error until reconciliation", async () => {
    const { account: created } = await seed();
    const account = await prepareReadyAccount(created);
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () =>
          ({ status: "idle", lastSeen: Date.now() }) as never,
        pushMedia: async () => ({ results: [] }),
        executeTask: async (_id, body) => {
          if (!body.task.includes("PROFILE_JSON:")) {
            return { result: resultForTask(body) };
          }
          throw new Error("phone task failed");
        },
      },
    });

    await expect(svc.apply(account.id)).rejects.toThrow("phone task failed");
    await expect(
      store.updateAccount(account.id, { deviceId: null }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(svc.reconcile(account.id)).resolves.toMatchObject({
      profileDraft: {
        applyStatus: "failed",
        applyOperation: { status: "completed" },
      },
    });
    await expect(
      store.updateAccount(account.id, { deviceId: null }),
    ).resolves.toMatchObject({ deviceId: null });
  });

  it("reconciles an uncertain operation after a controller restart", async () => {
    const { account: created } = await seed();
    const account = await prepareReadyAccount(created);
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () => ({ status: "idle" }) as never,
        pushMedia: async () => ({ results: [] }),
        executeTask: async (_id, body) => {
          if (!body.task.includes("PROFILE_JSON:")) {
            return { result: resultForTask(body) };
          }
          throw new Error("phone task failed");
        },
      },
    });

    await expect(svc.apply(account.id)).rejects.toThrow("phone task failed");

    const restartedStore = new XhsOpsStore(join(tempDir, "xhs-ops.json"));
    const restartedSvc = new XhsOpsProfileService({
      store: restartedStore,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () =>
          ({
            status: "idle",
            currentTaskId: null,
            lastSeen: Date.now(),
          }) as never,
        executeTask: async (_id, body) => ({ result: resultForTask(body) }),
        pushMedia: async () => ({ results: [] }),
      },
    });
    await expect(restartedSvc.reconcile(account.id)).resolves.toMatchObject({
      profileDraft: {
        applyStatus: "failed",
        applyOperation: { status: "completed" },
      },
    });
    await expect(
      restartedStore.updateAccount(account.id, { deviceId: null }),
    ).resolves.toMatchObject({ deviceId: null });
  });

  it("does not reconcile an idle device with a stale lastSeen heartbeat", async () => {
    const { account: created } = await seed();
    const account = await prepareReadyAccount(created);
    const claimed = await store.beginProfileApply(
      account.id,
      account.updatedAt,
      account.deviceId ?? "",
    );
    let lastSeen: number | undefined = Date.now() - 90_001;
    const svc = new XhsOpsProfileService({
      store,
      mediaRoot,
      media: {
        generateText: async () => ({ text: "" }),
        generateImage: async () => ({ path: "", items: [] }),
      },
      deviceControl: {
        getDevice: async () =>
          ({
            status: "idle",
            currentTaskId: null,
            lastSeen,
          }) as never,
        executeTask: async (_id, body) => ({ result: resultForTask(body) }),
        pushMedia: async () => ({ results: [] }),
      },
    });

    await expect(svc.reconcile(claimed.id)).resolves.toMatchObject({
      profileDraft: { applyOperation: { status: "running" } },
    });
    lastSeen = undefined;
    await expect(svc.reconcile(claimed.id)).resolves.toMatchObject({
      profileDraft: { applyOperation: { status: "running" } },
    });
  });
});

describe("profile task builder", () => {
  it("only lists requested fields and ends with the PROFILE_JSON contract", () => {
    const t = buildProfileApplyTask({
      label: "A",
      platformAccountId: "target-xhs-id",
      bio: "简介文案",
      coverFilename: "tabby-cover-1.jpg",
    });
    expect(t).toContain("简介：点「简介」");
    expect(t).toContain("背景图：只点「背景图」");
    expect(t).not.toContain("名字：");
    expect(t).not.toContain("头像：点编辑主页");
    expect(t).toContain("PROFILE_JSON:");
  });
  it("picks images by album+recency+content, never by a filename the picker hides", () => {
    const t = buildProfileApplyTask({
      label: "A",
      platformAccountId: "target-xhs-id",
      avatarFilename: "tabby-avatar-1.jpg",
      coverFilename: "tabby-cover-1.jpg",
    });
    // The picker's grid cells carry no text and no content-desc, so naming the
    // file was an instruction the model could not possibly follow.
    expect(t).not.toContain("tabby-avatar-1.jpg");
    expect(t).not.toContain("tabby-cover-1.jpg");
    expect(t).not.toContain("文件名");
    // What it can actually use.
    expect(t).toContain("选「Tabby」相册");
    expect(t).toContain("人物半身照");
    expect(t).toContain("横构图风景照");
    // The avatar sits behind a preview screen with a tempting wrong option.
    expect(t).toContain("上传新头像");
    expect(t).toContain("制作 AI 头像");
  });

  it("asks for full photo access and refuses to guess when the album is empty", () => {
    const t = buildProfileApplyTask({
      label: "A",
      platformAccountId: "target-xhs-id",
      avatarFilename: "tabby-avatar-1.jpg",
    });
    expect(t).toContain("允许访问所有照片");
    // "仅选择部分照片" leaves the in-app album empty; guessing there is worse
    // than failing loudly.
    expect(t).toContain("未找到图片文件");
    expect(t).toContain("相册权限受限");
  });

  it("describes the birthday wheel as a drag, since it exposes no clickable rows", () => {
    const t = buildProfileApplyTask({
      label: "A",
      platformAccountId: "target-xhs-id",
      birthday: "1999-03-02",
    });
    expect(t).toContain("1999-03-02");
    expect(t).toContain("不是可点击控件");
    // SLIDE is already the inertia-free drag; asking for a slow one on top of
    // that named a duration the action vocabulary cannot express.
    expect(t).toContain("无惯性精确拖拽");
    // Flinging overshoots a wheel; stepping without checking compounds it.
    expect(t).toContain("一次最多拖 3 格");
    expect(t).toContain("禁止快速甩动");
    expect(t).toContain("禁止使用「FLING」");
  });

  it("sends the region list a fling, which is the only gesture that can reach its end", () => {
    const t = buildProfileApplyTask({
      label: "A",
      platformAccountId: "target-xhs-id",
      region: "上海",
    });
    expect(t).toContain("FLING point1:");
    // A full-screen SLIDE moves exactly one screen, so the 200+ entry list
    // needs twenty-odd of them and the run dies mid-list.
    expect(t).toContain("必须用「FLING」而不是「SLIDE」");
    expect(t).toContain("12 个动作");
  });

  it("never names an action the task policy would reject", () => {
    // The prompt and the policy allowlist are edited separately, and they
    // drifted: the birthday step told the model LONGPRESSANDDRAG was "not in
    // this task's allowlist" for a day after it had been added, while the run
    // that motivated adding it had been killed for using it.
    const t = buildProfileApplyTask({
      label: "A",
      platformAccountId: "target-xhs-id",
      nickname: "n",
      bio: "b",
      avatarFilename: "a.jpg",
      coverFilename: "c.jpg",
      gender: "女",
      birthday: "1999-03-02",
      region: "上海",
    });
    const vocabulary = [
      "AWAKE",
      "CLICK",
      "TYPE",
      "ENTER",
      "WAIT",
      "BACK",
      "HOME",
      "SLIDE",
      "SCROLL",
      "FLING",
      "LONGPRESS",
      "LONGPRESSANDDRAG",
      "DOUBLE_CLICK",
      "ZOOM",
      "TAP_SEQUENCE",
      "CALL_USER",
      "COMPLETE",
      "ABORT",
    ];
    const allowed = new Set<string>(XHS_TASK_POLICY.allowedActions);
    for (const action of vocabulary) {
      // LONGPRESS is a prefix of LONGPRESSANDDRAG; match on a word boundary.
      if (!new RegExp(`${action}(?![A-Z_])`).test(t)) continue;
      expect(
        allowed.has(action),
        `${action} is named in the task but not allowed by XHS_TASK_POLICY`,
      ).toBe(true);
    }
    // And it must not claim an allowed action is blocked.
    expect(t).not.toContain("白名单不含");
    expect(t).not.toContain("POLICY_ACTION_NOT_ALLOWED");
  });

  it("parseProfileJson is lenient about literal newlines and unknown values", () => {
    const parsed = parseProfileJson(
      'done\\nPROFILE_JSON:{"nickname":"done","bio":"weird","avatar":"FAILED","note":"x"}\\n[回执] a=1',
    );
    expect(parsed).toEqual({
      nickname: "done",
      bio: "skipped",
      avatar: "failed",
      cover: "skipped",
      gender: "skipped",
      birthday: "skipped",
      region: "skipped",
      interestTags: "skipped",
      note: "x",
    });
    expect(parseProfileJson("no marker")).toBeNull();
  });

  it("requires a strict, internally consistent profile verification receipt", () => {
    expect(
      parseProfileVerificationJson(verificationResult().message),
    ).toMatchObject({
      status: "verified",
      accountMatched: true,
    });
    expect(
      parseProfileVerificationJson(
        `${verificationResult().message}\n[回执] 各应用生效点击: com.xingin.xhs=3`,
      ),
    ).toMatchObject({
      status: "verified",
      accountMatched: true,
    });
    expect(
      parseProfileVerificationJson(
        'PROFILE_VERIFICATION_JSON:{"v":1,"status":"verified","accountMatched":false,"fields":{"nickname":true,"bio":true,"avatar":true,"cover":true,"gender":true,"birthday":true,"region":true,"interestTags":true}}',
      ),
    ).toBeNull();
    expect(
      parseProfileVerificationJson(
        'PROFILE_VERIFICATION_JSON:{"v":1,"status":"verified","accountMatched":true,"fields":{"nickname":true,"bio":true,"avatar":true,"cover":true,"gender":true,"birthday":true,"region":true,"interestTags":true},"extra":"rejected"}',
      ),
    ).toBeNull();
    expect(
      parseProfileVerificationJson(
        `资料已核对\n${verificationResult().message}`,
      ),
    ).toBeNull();
    expect(
      parseProfileVerificationJson(
        `${verificationResult().message}\n[回执] 资料已核对`,
      ),
    ).toBeNull();
  });
});
