import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  generateXhsOpsPersonas,
  generateXhsOpsProfile,
} from "../src/services/xhs-ops-persona-service.js";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";

const dir = mkdtempSync(join(tmpdir(), "koc-personas-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const profile = {
  summary: "城市球友",
  base: { ageRange: "25–40", genderRatio: "男女各半", regions: ["北京"] },
  verticalInterests: ["羽毛球"],
  generalInterests: ["咖啡", "摄影"],
};
const candidate = (i: number) => ({
  label: `球友${i}`,
  positioning: `第${i}种球友生活`,
  persona: {
    age: `${25 + i}岁`,
    gender: i % 2 ? "女" : "男",
    region: "北京",
    occupation: `职业${i}`,
    lifeStatus: `状态${i}`,
  },
  personaTags: { vertical: ["羽毛球"], general: ["咖啡", "摄影"] },
  interestPool: {
    core: ["羽毛球"],
    extended: ["运动恢复"],
    general: ["咖啡", "摄影"],
  },
});
async function seed() {
  const store = new XhsOpsStore(join(dir, `${Math.random()}.json`));
  const draft = await store.createProject({
    name: "人设生成",
    business: { industry: "运动", product: "课程" },
    audience: { ageRange: "25–40", genderRatio: "男女各半", regions: ["北京"] },
  });
  const project = await store.confirmProfile(draft.id, {
    profile,
    expectedUpdatedAt: draft.updatedAt,
  });
  return { store, project };
}

describe("KOC persona generation", () => {
  it("returns exactly ten validated distinct candidates without auto-confirming or saving accounts", async () => {
    const { store, project } = await seed();
    const result = await generateXhsOpsPersonas(
      store,
      {
        generateText: async () => ({
          text: JSON.stringify({
            suggestions: Array.from({ length: 10 }, (_, i) => candidate(i)),
          }),
        }),
      },
      project.id,
      10,
      project.updatedAt,
    );
    expect(result.suggestions).toHaveLength(10);
    expect(result.distribution).toContain("男 5人");
    expect(result.distribution).toContain("女 5人");
    expect(await store.listAccountsByProject(project.id)).toEqual([]);
    expect(result.project.profile?.confirmedAt).toBe(
      project.profile?.confirmedAt,
    );
  });
  it("rejects a partial batch and duplicate personas instead of presenting them as N complete candidates", async () => {
    const { store, project } = await seed();
    for (const suggestions of [[candidate(1)], [candidate(1), candidate(1)]]) {
      await expect(
        generateXhsOpsPersonas(
          store,
          {
            generateText: async () => ({
              text: JSON.stringify({ suggestions }),
            }),
          },
          project.id,
          2,
          project.updatedAt,
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect((await store.getProject(project.id))?.updatedAt).toBe(
      project.updatedAt,
    );
  });
  it("does not overwrite a project changed while the model was generating", async () => {
    const { store, project } = await seed();
    await expect(
      generateXhsOpsPersonas(
        store,
        {
          generateText: async () => {
            await store.updateProject(project.id, {
              business: { ...project.business, product: "新业务" },
            });
            return { text: JSON.stringify({ suggestions: [candidate(1)] }) };
          },
        },
        project.id,
        1,
        project.updatedAt,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await store.getProject(project.id))?.business.product).toBe(
      "新业务",
    );
  });
  it("generates a visible profile requiring a new human confirmation", async () => {
    const { store, project } = await seed();
    const result = await generateXhsOpsProfile(
      store,
      { generateText: async () => ({ text: JSON.stringify(profile) }) },
      project.id,
      project.updatedAt,
    );
    expect(result.profile?.summary).toBe(profile.summary);
    expect(result.profile?.confirmedAt).toBeNull();
    await expect(
      generateXhsOpsPersonas(
        store,
        {
          generateText: async () => {
            throw new Error("must not call provider");
          },
        },
        project.id,
        10,
        result.updatedAt,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
