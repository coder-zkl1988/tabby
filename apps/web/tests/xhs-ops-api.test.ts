import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  deleteApiV1XhsOpsAccountsByAccountId: vi.fn(),
  deleteApiV1XhsOpsProjectsByProjectId: vi.fn(),
  getApiV1XhsOpsAccountsByAccountId: vi.fn(),
  getApiV1XhsOpsDeviceBindings: vi.fn(),
  getApiV1XhsOpsProjects: vi.fn(),
  getApiV1XhsOpsProjectsByProjectId: vi.fn(),
  getApiV1XhsOpsProjectsByProjectIdAccounts: vi.fn(),
  getApiV1XhsOpsProjectsByProjectIdComments: vi.fn(),
  getApiV1XhsOpsProjectsByProjectIdPlanSuggest: vi.fn(),
  getApiV1XhsOpsRuns: vi.fn(),
  getApiV1XhsOpsRunsByRunId: vi.fn(),
  patchApiV1XhsOpsAccountsByAccountId: vi.fn(),
  patchApiV1XhsOpsProjectsByProjectId: vi.fn(),
  patchApiV1XhsOpsRunsByRunId: vi.fn(),
  postApiV1XhsOpsAccountsByAccountIdProfileDraftApply: vi.fn(),
  postApiV1XhsOpsAccountsByAccountIdProfileDraftConfirm: vi.fn(),
  postApiV1XhsOpsAccountsByAccountIdProfileDraftGenerate: vi.fn(),
  postApiV1XhsOpsCommentsByCommentIdReview: vi.fn(),
  postApiV1XhsOpsProjects: vi.fn(),
  postApiV1XhsOpsProjectsByProjectIdAccounts: vi.fn(),
  postApiV1XhsOpsProjectsByProjectIdAccountsTransferDevice: vi.fn(),
  postApiV1XhsOpsProjectsByProjectIdCommentRuns: vi.fn(),
  postApiV1XhsOpsRuns: vi.fn(),
  postApiV1XhsOpsRunsByRunIdCancel: vi.fn(),
  postApiV1XhsOpsRunsByRunIdCommentsGenerate: vi.fn(),
  postApiV1XhsOpsRunsByRunIdStart: vi.fn(),
}));

vi.mock("../lib/api/sdk.gen", () => apiMocks);

import {
  XhsOpsApiError,
  xhsOpsApi,
} from "../src/lib/a2ui/custom-components/xhs-ops/xhs-ops-api";

const project = {
  id: "project-1",
  name: "亲子生活",
  business: {
    industry: "母婴",
    product: "亲子活动",
    regions: ["上海"],
    sellingPoints: ["周末可用"],
    priceBand: "中档",
    scene: "周末遛娃",
  },
  audience: {
    ageRange: "25-40",
    genderRatio: "女性为主",
    regions: ["上海"],
    occupations: ["职场父母"],
    spendingPower: "中等",
    knownInterests: ["亲子游"],
    painPoints: ["缺少周末去处"],
  },
  opsNotes: {
    forbiddenTopics: [],
    boostKeywords: ["遛娃"],
    avoidContentTypes: [],
  },
  profile: null,
  schedule: {
    enabled: false,
    time: "10:00",
    lastTriggeredDate: null,
    lastResult: null,
  },
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};

describe("xhs-ops generated SDK adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps wrapper arguments to generated path and query options", async () => {
    apiMocks.getApiV1XhsOpsProjectsByProjectIdComments.mockResolvedValue({
      data: { drafts: [], quotas: [] },
      response: new Response(null, { status: 200 }),
    });

    await expect(
      xhsOpsApi.listComments("project/with space", {
        status: "approved",
        accountId: "account-1",
      }),
    ).resolves.toEqual({ drafts: [], quotas: [] });
    expect(
      apiMocks.getApiV1XhsOpsProjectsByProjectIdComments,
    ).toHaveBeenCalledWith({
      path: { projectId: "project/with space" },
      query: { status: "approved", accountId: "account-1" },
    });
  });

  it("preserves generated SDK HTTP errors and status codes", async () => {
    apiMocks.getApiV1XhsOpsProjects.mockResolvedValue({
      error: { error: { code: "store_failed", message: "项目存储不可用" } },
      response: new Response(null, { status: 503 }),
    });

    const error = await xhsOpsApi.listProjects().catch((caught) => caught);
    expect(error).toBeInstanceOf(XhsOpsApiError);
    expect(error).toMatchObject({
      message: "项目存储不可用",
      status: 503,
    });
  });

  it("surfaces declared account binding conflicts", async () => {
    apiMocks.patchApiV1XhsOpsAccountsByAccountId.mockResolvedValue({
      error: { message: "该设备已绑定其他账号" },
      response: new Response(null, { status: 409 }),
    });

    await expect(
      xhsOpsApi.updateAccount("account-1", { deviceId: "device-2" }),
    ).rejects.toMatchObject({
      message: "该设备已绑定其他账号",
      status: 409,
    });
    expect(apiMocks.patchApiV1XhsOpsAccountsByAccountId).toHaveBeenCalledWith({
      path: { accountId: "account-1" },
      body: { deviceId: "device-2" },
    });
  });

  it("reports rejected requests as desktop connection failures", async () => {
    apiMocks.getApiV1XhsOpsProjects.mockRejectedValue(new Error("offline"));

    await expect(xhsOpsApi.listProjects()).rejects.toMatchObject({
      message: "无法连接桌面端服务：offline",
      status: null,
    });
  });

  it("validates successful SDK data against the shared response schema", async () => {
    apiMocks.getApiV1XhsOpsProjects.mockResolvedValue({
      data: { projects: [{ ...project, name: 42 }] },
      response: new Response(null, { status: 200 }),
    });

    await expect(xhsOpsApi.listProjects()).rejects.toMatchObject({
      message: "桌面端返回了不兼容的数据格式：项目列表加载失败",
      status: 200,
    });
  });

  it("returns shared-schema output after successful validation", async () => {
    apiMocks.getApiV1XhsOpsProjects.mockResolvedValue({
      data: { projects: [project] },
      response: new Response(null, { status: 200 }),
    });

    await expect(xhsOpsApi.listProjects()).resolves.toEqual([
      { ...project, personaCount: 10 },
    ]);
  });

  it("loads device owners and sends the expected source owner with an atomic transfer", async () => {
    const binding = {
      deviceId: "phone-1",
      accountId: "old-account",
      accountLabel: "旧账号",
      projectId: "old-project",
      projectName: "旧项目",
      canTransfer: true,
      blockingReason: null,
    };
    apiMocks.getApiV1XhsOpsDeviceBindings.mockResolvedValue({
      data: { bindings: [binding] },
    });
    await expect(xhsOpsApi.listDeviceBindings()).resolves.toEqual([binding]);
    const input = {
      fromAccountId: "old-account",
      account: { label: "新账号", deviceId: "phone-1" },
    };
    apiMocks.postApiV1XhsOpsProjectsByProjectIdAccountsTransferDevice.mockResolvedValue(
      {
        data: {
          account: {
            ...input.account,
            id: "new-account",
            projectId: "new-project",
            createdAt: "2026-09-08",
            updatedAt: "2026-09-08",
          },
        },
      },
    );
    await expect(
      xhsOpsApi.transferDevice("new-project", input),
    ).resolves.toMatchObject({ id: "new-account", deviceId: "phone-1" });
    expect(
      apiMocks.postApiV1XhsOpsProjectsByProjectIdAccountsTransferDevice,
    ).toHaveBeenCalledWith({ path: { projectId: "new-project" }, body: input });
  });

  it("confirms a complete profile draft through the generated endpoint", async () => {
    apiMocks.postApiV1XhsOpsAccountsByAccountIdProfileDraftConfirm.mockResolvedValue(
      {
        data: {
          account: {
            id: "account-1",
            projectId: "project-1",
            label: "羽毛球生活号",
            positioning: "城市运动生活",
            deviceId: "phone-1",
            deviceName: "Phone 1",
            profileDraft: {
              nickname: "球场边的小林",
              bio: "双子座 ENFP｜杭州互联网从业者｜喜欢羽毛球和咖啡",
              avatarCandidates: ["/avatar.png"],
              coverCandidates: ["/cover.png"],
              avatarPath: "/avatar.png",
              coverPath: "/cover.png",
              reviewedAt: "2026-09-09T02:05:00.000Z",
            },
            createdAt: "2026-09-09T02:00:00.000Z",
            updatedAt: "2026-09-09T02:05:00.000Z",
          },
        },
      },
    );

    await expect(
      xhsOpsApi.confirmProfileDraft("account-1", "2026-09-09T02:00:00.000Z"),
    ).resolves.toMatchObject({
      id: "account-1",
      profileDraft: { reviewedAt: "2026-09-09T02:05:00.000Z" },
    });
    expect(
      apiMocks.postApiV1XhsOpsAccountsByAccountIdProfileDraftConfirm,
    ).toHaveBeenCalledWith({
      path: { accountId: "account-1" },
      query: { expectedUpdatedAt: "2026-09-09T02:00:00.000Z" },
    });
  });
});
