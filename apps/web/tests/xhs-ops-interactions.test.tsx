// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SurfaceManager } from "../src/lib/a2ui/a2ui-surface";
import type { SurfaceState } from "../src/lib/a2ui/a2ui-types";
import type { CustomComponentProps } from "../src/lib/a2ui/custom-components/registry";
import { XhsOpsAccountPlanner } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsAccountPlanner";
import { XhsOpsProfileCard } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsProfileCard";
import { XhsOpsProfileMaterial } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsProfileMaterial";
import { XhsOpsProjectForm } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsProjectForm";
import { XhsOpsRunPlanner } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsRunPlanner";
import {
  type XhsOpsAccount,
  type XhsOpsProfileDraft,
  type XhsOpsRun,
  defaultBrowseDefaults,
  defaultInteractionConfig,
  emptyInterestPool,
  emptyPersona,
  emptyProfileDraft,
} from "../src/lib/a2ui/custom-components/xhs-ops/xhs-ops-types";

const apiMocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listAccounts: vi.fn(),
  listDeviceBindings: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  confirmProfile: vi.fn(),
  generateProfile: vi.fn(),
  getProject: vi.fn(),
  suggestPlans: vi.fn(),
  listRuns: vi.fn(),
  createRun: vi.fn(),
  startRun: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  updateRunNotes: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
  transferDevice: vi.fn(),
  generatePersonas: vi.fn(),
  confirmPersonas: vi.fn(),
  generateProfileDraft: vi.fn(),
  confirmProfileDraft: vi.fn(),
  applyProfileDraft: vi.fn(),
}));

const sdkMocks = vi.hoisted(() => ({ getDevices: vi.fn() }));

vi.mock("../src/lib/a2ui/custom-components/xhs-ops/xhs-ops-api", () => ({
  xhsOpsApi: apiMocks,
  describeXhsOpsError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1Devices: sdkMocks.getDevices,
}));

const resolveLiteral = <T,>(value: T): unknown => value;

function props(
  comp: Record<string, unknown>,
  onAction: CustomComponentProps["onAction"] = () => {},
): CustomComponentProps {
  return {
    comp,
    resolve: resolveLiteral,
    surface: {} as SurfaceState,
    manager: {} as SurfaceManager,
    onAction,
  };
}

function renderWithQuery(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{element}</QueryClientProvider>,
  );
}

function account(
  id: string,
  overrides: Partial<XhsOpsAccount> = {},
): XhsOpsAccount {
  const readyDraft: XhsOpsProfileDraft = {
    ...emptyProfileDraft(),
    nickname: "城市生活记录者",
    bio: "天秤座 INFJ｜住在杭州的产品经理｜喜欢羽毛球、咖啡和城市漫游",
    gender: "女",
    birthday: "1995-01-01",
    region: "杭州",
    interestTags: ["羽毛球", "咖啡", "城市漫游"],
    avatarCandidates: ["/avatar-ready.png"],
    coverCandidates: ["/cover-ready.png"],
    avatarPath: "/avatar-ready.png",
    coverPath: "/cover-ready.png",
    reviewedAt: "2026-09-07T00:00:00.000Z",
  };
  return {
    id,
    projectId: "project-1",
    label: `账号 ${id}`,
    positioning: "周末城市生活",
    persona: emptyPersona(),
    personaTags: { vertical: [], general: [] },
    personaReviewedAt: null,
    personaReviewNote: null,
    platformAccountId: "",
    profileDraft: readyDraft,
    deviceId: `device-${id}`,
    deviceName: `Phone ${id}`,
    interestPool: emptyInterestPool(),
    interaction: defaultInteractionConfig(),
    browseDefaults: defaultBrowseDefaults(),
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

function nurtureReadyAccount(
  id: string,
  overrides: Partial<XhsOpsAccount> = {},
): XhsOpsAccount {
  const base = account(id);
  const platformAccountId = `platform-${id}`;
  return {
    ...base,
    persona: {
      age: "28",
      gender: "女",
      region: "杭州",
      occupation: "产品经理",
      lifeStatus: "周末运动爱好者",
    },
    personaTags: {
      vertical: ["羽毛球"],
      general: ["咖啡", "城市生活"],
    },
    personaReviewedAt: "2026-09-09T01:00:00.000Z",
    platformAccountId,
    profileDraft: {
      ...base.profileDraft,
      appliedAt: "2026-09-09T01:01:00.000Z",
      applyStatus: "applied",
      applyResult: "资料已应用并核验",
      verifiedAt: "2026-09-09T01:02:00.000Z",
      verifiedAccountId: platformAccountId,
      verificationTaskId: `verification-${id}`,
    },
    interestPool: {
      core: ["羽毛球"],
      extended: ["运动装备"],
      general: ["咖啡"],
    },
    ...overrides,
  };
}

function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function run(
  id: string,
  status: XhsOpsRun["status"],
  segmentIndex: number,
  queuedBehindRunId: string | null = null,
): XhsOpsRun {
  return {
    id,
    projectId: "project-1",
    accountId: "account-1",
    deviceId: "device-1",
    accountLabel: "账号 account-1",
    date: localDate(),
    status,
    plan: {
      keywords: [{ keyword: "亲子酒店", count: 1 }],
      homeFeedCount: 1,
      dwellSecMin: 10,
      dwellSecMax: 20,
      interaction: defaultInteractionConfig(),
    },
    segment: { index: segmentIndex, count: 2 },
    queuedBehindRunId,
    chunks: [],
    summary: {
      plannedTotal: 2,
      browsedTotal: status === "completed" ? 2 : 0,
      searchBrowsed: status === "completed" ? 1 : 0,
      homeBrowsed: status === "completed" ? 1 : 0,
      interactions: { like: 0, collect: 0, follow: 0 },
      anomalyCount: 0,
      durationMs: null,
    },
    notes: "",
    error: status === "failed" ? "failed" : null,
    createdAt: "2026-09-07T00:00:00.000Z",
    startedAt: status === "planned" ? null : "2026-09-07T00:00:01.000Z",
    completedAt:
      status === "planned" || status === "running"
        ? null
        : "2026-09-07T00:01:00.000Z",
    updatedAt: "2026-09-07T00:01:00.000Z",
  };
}

function plannerPlans(indices = [1, 2]) {
  return indices.map((index) => ({
    accountId: "account-1",
    keywords: [{ keyword: `关键词${index}`, count: 1 }],
    homeFeedCount: 1,
    segment: { index, count: 2 },
  }));
}

function singlePlan(accountId: string) {
  return {
    accountId,
    keywords: [{ keyword: "羽毛球", count: 1 }],
    homeFeedCount: 1,
  };
}

function unsegmentedRun(
  id: string,
  status: XhsOpsRun["status"],
  accountId: string,
  queuedBehindRunId: string | null = null,
): XhsOpsRun {
  return {
    ...run(id, status, 1, queuedBehindRunId),
    accountId,
    deviceId: `device-${accountId}`,
    accountLabel: `账号 ${accountId}`,
    segment: null,
  };
}

async function enabledStartButton(): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const button = screen.getByRole("button", {
      name: "开始执行",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    return button;
  });
}

describe("xhs-ops component interactions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sessionStorage.clear();
    apiMocks.listProjects.mockResolvedValue([]);
    apiMocks.listAccounts.mockResolvedValue([nurtureReadyAccount("account-1")]);
    apiMocks.listDeviceBindings.mockResolvedValue([]);
    apiMocks.getProject.mockResolvedValue({
      id: "project-1",
      schedule: null,
      updatedAt: "2026-09-09T00:00:00.000Z",
      profile: {
        summary: "杭州城市运动人群",
        base: {
          ageRange: "25-35",
          genderRatio: "女6男4",
          regions: ["杭州"],
        },
        verticalInterests: ["羽毛球"],
        generalInterests: ["咖啡", "城市生活"],
        confirmedAt: "2026-09-09T00:00:00.000Z",
      },
    });
    apiMocks.listRuns.mockResolvedValue([]);
    sdkMocks.getDevices.mockResolvedValue({
      data: {
        devices: [
          {
            deviceId: "device-1",
            name: "Phone 1",
            status: "idle",
            lastSeen: Date.now(),
          },
          {
            deviceId: "device-2",
            name: "Phone 2",
            status: "idle",
            lastSeen: Date.now(),
          },
        ],
      },
    });
  });

  it("blocks project save until the minimum profile inputs are complete", () => {
    render(
      <XhsOpsProjectForm
        {...props({
          type: "XhsOpsProjectForm",
          prefill: { name: "本地生活项目" },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存并生成画像" }));

    expect(screen.getByText(/请补全生成画像所需信息/).textContent).toContain(
      "行业、产品 / 服务、目标年龄段、性别比例、目标地区",
    );
    expect(apiMocks.createProject).not.toHaveBeenCalled();
  });

  it("generates the profile on the desktop after saving complete project input", async () => {
    const saved = {
      id: "project-1",
      name: "本地生活项目",
      business: {
        industry: "体育",
        product: "羽毛球馆",
        regions: [],
        sellingPoints: [],
        priceBand: "",
        scene: "",
      },
      audience: {
        ageRange: "25-35",
        genderRatio: "女6男4",
        regions: ["杭州"],
        occupations: [],
        spendingPower: "",
        knownInterests: [],
        painPoints: [],
      },
      opsNotes: {
        forbiddenTopics: [],
        boostKeywords: [],
        avoidContentTypes: [],
      },
      updatedAt: "revision-1",
    };
    apiMocks.createProject.mockResolvedValue(saved);
    apiMocks.generateProfile.mockResolvedValue({
      ...saved,
      updatedAt: "revision-2",
      profile: { summary: "杭州羽毛球爱好者" },
    });
    const onAction = vi.fn();
    render(
      <XhsOpsProjectForm
        {...props(
          {
            type: "XhsOpsProjectForm",
            prefill: saved,
          },
          onAction,
        )}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存并生成画像" }));

    await waitFor(() =>
      expect(apiMocks.generateProfile).toHaveBeenCalledWith("project-1", {
        expectedUpdatedAt: "revision-1",
      }),
    );
    expect(onAction).toHaveBeenCalledWith(
      "xhs_ops_project_saved",
      expect.objectContaining({
        projectId: "project-1",
        profile: { summary: "杭州羽毛球爱好者" },
      }),
    );
  });

  it("does not continue when an existing project revision is stale", async () => {
    const project = {
      id: "project-1",
      name: "旧项目名",
      business: {
        industry: "体育",
        product: "羽毛球馆",
        regions: [],
        sellingPoints: [],
        priceBand: "",
        scene: "",
      },
      audience: {
        ageRange: "25-35",
        genderRatio: "女6男4",
        regions: ["杭州"],
        occupations: [],
        spendingPower: "",
        knownInterests: [],
        painPoints: [],
      },
      opsNotes: {
        forbiddenTopics: [],
        boostKeywords: [],
        avoidContentTypes: [],
      },
      updatedAt: "stale-revision",
    };
    apiMocks.getProject.mockResolvedValue(project);
    apiMocks.updateProject.mockRejectedValue(new Error("项目已被其他表单更新"));

    render(
      <XhsOpsProjectForm
        {...props({
          type: "XhsOpsProjectForm",
          projectId: "project-1",
        })}
      />,
    );

    fireEvent.change(await screen.findByDisplayValue("旧项目名"), {
      target: { value: "尝试覆盖的项目名" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并生成画像" }));

    await waitFor(() =>
      expect(apiMocks.updateProject).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({ expectedUpdatedAt: "stale-revision" }),
      ),
    );
    expect(await screen.findByText("项目已被其他表单更新")).toBeTruthy();
    expect(apiMocks.generateProfile).not.toHaveBeenCalled();
  });

  it("uses the latest generated project revision on the next save", async () => {
    const project = {
      id: "project-1",
      name: "初始项目",
      business: {
        industry: "体育",
        product: "羽毛球馆",
        regions: [],
        sellingPoints: [],
        priceBand: "",
        scene: "",
      },
      audience: {
        ageRange: "25-35",
        genderRatio: "女6男4",
        regions: ["杭州"],
        occupations: [],
        spendingPower: "",
        knownInterests: [],
        painPoints: [],
      },
      opsNotes: {
        forbiddenTopics: [],
        boostKeywords: [],
        avoidContentTypes: [],
      },
      updatedAt: "revision-1",
    };
    apiMocks.getProject.mockResolvedValue(project);
    apiMocks.updateProject
      .mockResolvedValueOnce({
        ...project,
        name: "第一次修改",
        updatedAt: "revision-2",
      })
      .mockResolvedValueOnce({
        ...project,
        name: "第二次修改",
        updatedAt: "revision-4",
      });
    apiMocks.generateProfile
      .mockResolvedValueOnce({
        ...project,
        name: "第一次修改",
        updatedAt: "revision-3",
      })
      .mockResolvedValueOnce({
        ...project,
        name: "第二次修改",
        updatedAt: "revision-5",
      });

    render(
      <XhsOpsProjectForm
        {...props({
          type: "XhsOpsProjectForm",
          projectId: "project-1",
        })}
      />,
    );

    fireEvent.change(await screen.findByDisplayValue("初始项目"), {
      target: { value: "第一次修改" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并生成画像" }));
    await waitFor(() =>
      expect(apiMocks.generateProfile).toHaveBeenCalledTimes(1),
    );

    fireEvent.change(screen.getByDisplayValue("第一次修改"), {
      target: { value: "第二次修改" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并生成画像" }));

    await waitFor(() =>
      expect(apiMocks.updateProject).toHaveBeenCalledTimes(2),
    );
    expect(apiMocks.updateProject.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ expectedUpdatedAt: "revision-1" }),
    );
    expect(apiMocks.updateProject.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ expectedUpdatedAt: "revision-3" }),
    );
  });

  afterEach(() => cleanup());

  it("keeps unrelated unsaved profile fields when generating one material part", async () => {
    const initialDraft: XhsOpsProfileDraft = {
      ...emptyProfileDraft(),
      nickname: "服务端旧昵称",
      avatarCandidates: ["/avatar-1.png", "/avatar-2.png"],
      avatarPath: "/avatar-1.png",
      coverCandidates: ["/cover-old.png"],
      coverPath: "/cover-old.png",
    };
    const initial = account("account-1", { profileDraft: initialDraft });
    apiMocks.listAccounts.mockResolvedValue([initial]);
    apiMocks.generateProfileDraft.mockResolvedValue(
      account("account-1", {
        profileDraft: {
          ...initialDraft,
          nickname: "服务端旧昵称",
          avatarPath: "/avatar-1.png",
          coverCandidates: ["/cover-new.png"],
          coverPath: "/cover-new.png",
          generatedAt: "2026-09-07T01:00:00.000Z",
        },
      }),
    );

    renderWithQuery(
      <XhsOpsProfileMaterial
        {...props({ type: "XhsOpsProfileMaterial", projectId: "project-1" })}
      />,
    );

    const nickname = await screen.findByLabelText("昵称");
    fireEvent.change(nickname, { target: { value: "本地未保存昵称" } });
    const candidateButtons = document.querySelectorAll<HTMLButtonElement>(
      'button[aria-pressed="false"]',
    );
    fireEvent.click(candidateButtons[0]);
    fireEvent.click(
      screen.getAllByRole("button", { name: "重新生成 3 张备选" })[1],
    );

    await waitFor(() =>
      expect(apiMocks.generateProfileDraft).toHaveBeenCalledWith(
        "account-1",
        ["cover"],
        {},
      ),
    );
    expect(screen.getByDisplayValue("本地未保存昵称")).toBeTruthy();
    const selected = document.querySelector<HTMLButtonElement>(
      'button[aria-pressed="true"] img[src*="avatar-2.png"]',
    );
    expect(selected).not.toBeNull();
    expect(document.querySelector('img[src*="cover-new.png"]')).not.toBeNull();
  });

  it("opens a full-size preview from the magnifier badge on a candidate", async () => {
    apiMocks.listAccounts.mockResolvedValue([
      account("account-1", {
        profileDraft: {
          ...emptyProfileDraft(),
          avatarCandidates: ["/avatar-a.png", "/avatar-b.png"],
          generatedAt: "2026-09-11T01:00:00.000Z",
        },
      }),
    ]);

    renderWithQuery(
      <XhsOpsProfileMaterial
        {...props({ type: "XhsOpsProfileMaterial", projectId: "project-1" })}
      />,
    );

    expect(await screen.findByText("账号 account-1")).toBeTruthy();
    expect(screen.queryByTestId("image-lightbox")).toBeNull();

    // The badge is a separate control from the "pick this one" button.
    const zoom = screen.getAllByRole("button", { name: "放大查看：备选图" });
    expect(zoom).toHaveLength(2);
    fireEvent.click(zoom[0] as HTMLElement);
    expect(screen.getByTestId("image-lightbox")).toBeTruthy();

    // Selecting is unaffected: the thumbnails still carry aria-pressed.
    expect(document.querySelectorAll("button[aria-pressed]")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(screen.queryByTestId("image-lightbox")).toBeNull();
  });

  it("shows one account at a time behind tabs and keeps unsaved edits across switches", async () => {
    apiMocks.listAccounts.mockResolvedValue([
      account("account-1", { label: "下班羽毛球场打卡中" }),
      account("account-2", { label: "装备避坑的羽毛球小姐妹" }),
    ]);

    renderWithQuery(
      <XhsOpsProfileMaterial
        {...props({ type: "XhsOpsProfileMaterial", projectId: "project-1" })}
      />,
    );

    const tabs = await screen.findAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");

    // Type into the first account, then leave and come back.
    const firstNickname = screen.getAllByPlaceholderText(
      "点右侧「生成」由 AI 起名",
    )[0] as HTMLInputElement;
    fireEvent.change(firstNickname, { target: { value: "本地未保存昵称" } });

    fireEvent.click(tabs[1] as HTMLElement);
    expect(screen.getAllByRole("tab")[1]?.getAttribute("aria-selected")).toBe(
      "true",
    );

    fireEvent.click(screen.getAllByRole("tab")[0] as HTMLElement);
    // Panels stay mounted, so the edit survives the round trip.
    expect(screen.getByDisplayValue("本地未保存昵称")).toBeTruthy();
  });

  it("renders a single account without tab chrome", async () => {
    apiMocks.listAccounts.mockResolvedValue([account("account-1")]);

    renderWithQuery(
      <XhsOpsProfileMaterial
        {...props({ type: "XhsOpsProfileMaterial", projectId: "project-1" })}
      />,
    );

    expect(await screen.findByText("账号 account-1")).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("keeps the nickname field narrow and lets the bio span the row", async () => {
    apiMocks.listAccounts.mockResolvedValue([account("account-1")]);

    renderWithQuery(
      <XhsOpsProfileMaterial
        {...props({ type: "XhsOpsProfileMaterial", projectId: "project-1" })}
      />,
    );

    expect(await screen.findByText("账号 account-1")).toBeTruthy();
    const nickname = screen.getByPlaceholderText("点右侧「生成」由 AI 起名");
    // A 20-char field should not stretch across the column.
    expect(nickname.className).toContain("sm:max-w-[15rem]");

    const bio = document.querySelector("textarea");
    if (!bio) throw new Error("missing bio textarea");
    expect(bio.className).toContain("w-full");
    // The label wrapper spans both columns so the textarea fills the row.
    expect(bio.closest("label")?.className).toContain("sm:col-span-2");
  });

  it("sends the operator's prompt hint and flags a partial candidate set", async () => {
    const partial = account("account-1", {
      profileDraft: {
        ...emptyProfileDraft(),
        coverCandidates: ["/cover-a.png"],
        generatedAt: "2026-09-10T01:00:00.000Z",
      },
    });
    apiMocks.listAccounts.mockResolvedValue([partial]);
    apiMocks.generateProfileDraft.mockResolvedValue(partial);

    renderWithQuery(
      <XhsOpsProfileMaterial
        {...props({ type: "XhsOpsProfileMaterial", projectId: "project-1" })}
      />,
    );

    expect(await screen.findByText("账号 account-1")).toBeTruthy();
    // 1 of 3 landed, nothing picked yet -> the card says so and offers a top-up.
    expect(screen.getByTestId("candidate-partial").textContent).toContain(
      "只成功生成 1/3 张",
    );
    const topUp = screen.getByRole("button", { name: "补齐剩余 2 张" });

    const coverHint = screen.getByPlaceholderText(
      "补充要求，例如：外滩天际线、清晨、冷色调（留空用默认提示词）",
    );
    fireEvent.change(coverHint, { target: { value: "外滩天际线" } });
    fireEvent.click(topUp);

    await waitFor(() =>
      expect(apiMocks.generateProfileDraft).toHaveBeenCalledWith(
        "account-1",
        ["cover"],
        { coverPrompt: "外滩天际线" },
      ),
    );
  });

  it("allows an unbound account to generate, select, and save material", async () => {
    const unbound = account("account-unbound", {
      deviceId: null,
      deviceName: null,
      profileDraft: emptyProfileDraft(),
    });
    const generated = account("account-unbound", {
      deviceId: null,
      deviceName: null,
      profileDraft: {
        ...emptyProfileDraft(),
        avatarCandidates: ["/avatar-a.png", "/avatar-b.png"],
        avatarPath: "/avatar-a.png",
        generatedAt: "2026-09-07T01:00:00.000Z",
      },
    });
    apiMocks.listAccounts.mockResolvedValue([unbound]);
    apiMocks.generateProfileDraft.mockResolvedValue(generated);
    apiMocks.updateAccount.mockImplementation(
      async (_id: string, input: { profileDraft: XhsOpsProfileDraft }) =>
        account("account-unbound", {
          deviceId: null,
          deviceName: null,
          profileDraft: input.profileDraft,
        }),
    );

    renderWithQuery(
      <XhsOpsProfileMaterial
        {...props({ type: "XhsOpsProfileMaterial", projectId: "project-1" })}
      />,
    );

    expect(await screen.findByText("账号 account-unbound")).toBeTruthy();
    expect(screen.getByText("未绑定设备")).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", { name: "生成 3 张备选" })[0],
    );
    await waitFor(() =>
      expect(apiMocks.generateProfileDraft).toHaveBeenCalledWith(
        "account-unbound",
        ["avatar"],
        {},
      ),
    );

    const avatarChoices = document.querySelectorAll<HTMLButtonElement>(
      "button[aria-pressed]",
    );
    expect(avatarChoices).toHaveLength(2);
    fireEvent.click(avatarChoices[1]);
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));

    await waitFor(() =>
      expect(apiMocks.updateAccount).toHaveBeenCalledTimes(1),
    );
    expect(apiMocks.updateAccount).toHaveBeenCalledWith("account-unbound", {
      expectedUpdatedAt: "2026-09-07T00:00:00.000Z",
      platformAccountId: "",
      profileDraft: expect.objectContaining({ avatarPath: "/avatar-b.png" }),
    });
    const applyButton = screen.getByRole("button", {
      name: "安装登录、应用并核验",
    });
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);
    expect(applyButton.getAttribute("title")).toContain("未绑定设备");
    expect(
      screen.getByText(/可以先生成、选择并保存素材.*绑定设备后才能应用到手机/),
    ).toBeTruthy();
    fireEvent.click(applyButton);
    expect(apiMocks.applyProfileDraft).not.toHaveBeenCalled();
  });

  it("confirms applying to the phone with Tabby's own dialog, not window.confirm", async () => {
    const ready = account("account-apply", {
      platformAccountId: "target-xhs-id",
    });
    const applied = {
      ...ready,
      profileDraft: {
        ...ready.profileDraft,
        appliedAt: "2026-09-09T03:00:00.000Z",
        applyStatus: "applied" as const,
        applyResult: "资料已应用并核验",
      },
    };
    apiMocks.listAccounts.mockResolvedValue([ready]);
    apiMocks.updateAccount.mockResolvedValue(ready);
    apiMocks.applyProfileDraft.mockResolvedValue(applied);

    renderWithQuery(
      <XhsOpsProfileMaterial
        {...props({ type: "XhsOpsProfileMaterial", projectId: "project-1" })}
      />,
    );

    const applyButton = await screen.findByRole("button", {
      name: "安装登录、应用并核验",
    });
    fireEvent.click(applyButton);

    // A real dialog, not the browser's own — and nothing has run yet.
    const dialog = screen.getByRole("dialog", { name: "确认应用到手机？" });
    expect(dialog.textContent).toContain("账号 account-apply");
    expect(apiMocks.updateAccount).not.toHaveBeenCalled();
    expect(apiMocks.applyProfileDraft).not.toHaveBeenCalled();

    // Cancelling closes it without running anything.
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(apiMocks.applyProfileDraft).not.toHaveBeenCalled();

    // Confirming runs the same save-then-apply flow window.confirm used to gate.
    fireEvent.click(applyButton);
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await waitFor(() =>
      expect(apiMocks.updateAccount).toHaveBeenCalledTimes(1),
    );
    expect(apiMocks.updateAccount).toHaveBeenCalledWith("account-apply", {
      expectedUpdatedAt: ready.updatedAt,
      platformAccountId: "target-xhs-id",
      profileDraft: expect.objectContaining({ nickname: "城市生活记录者" }),
    });
    await waitFor(() =>
      expect(apiMocks.applyProfileDraft).toHaveBeenCalledWith(
        "account-apply",
        undefined,
      ),
    );
  });

  it("confirms the exact account revision returned by the preceding save", async () => {
    const base = account("account-versioned", {
      platformAccountId: "target-account",
    });
    const initial = {
      ...base,
      profileDraft: { ...base.profileDraft, reviewedAt: null },
      updatedAt: "revision-before-save",
    };
    const saved = {
      ...initial,
      updatedAt: "revision-after-save",
    };
    const confirmed = {
      ...saved,
      profileDraft: {
        ...saved.profileDraft,
        reviewedAt: "2026-09-09T02:05:00.000Z",
      },
    };
    apiMocks.listAccounts.mockResolvedValue([initial]);
    apiMocks.updateAccount.mockResolvedValue(saved);
    apiMocks.confirmProfileDraft.mockResolvedValue(confirmed);

    renderWithQuery(
      <XhsOpsProfileMaterial
        {...props({ type: "XhsOpsProfileMaterial", projectId: "project-1" })}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "校验确认资料" }),
    );

    await waitFor(() =>
      expect(apiMocks.updateAccount).toHaveBeenCalledWith(
        "account-versioned",
        expect.objectContaining({ expectedUpdatedAt: "revision-before-save" }),
      ),
    );
    await waitFor(() =>
      expect(apiMocks.confirmProfileDraft).toHaveBeenCalledWith(
        "account-versioned",
        "revision-after-save",
      ),
    );
  });

  it("keeps planning locked after material confirmation until phone verification", async () => {
    const empty = nurtureReadyAccount("account-1", {
      profileDraft: emptyProfileDraft(),
    });
    const generatedDraft: XhsOpsProfileDraft = {
      ...emptyProfileDraft(),
      nickname: "球场边的小林",
      bio: "双子座 ENFP｜杭州互联网从业者｜喜欢羽毛球、咖啡和周末散步",
      gender: "女",
      birthday: "1996-06-08",
      region: "杭州",
      interestTags: ["羽毛球", "咖啡", "散步"],
      avatarCandidates: ["/avatar-1.png", "/avatar-2.png", "/avatar-3.png"],
      coverCandidates: ["/cover-1.png", "/cover-2.png", "/cover-3.png"],
      generatedAt: "2026-09-09T02:00:00.000Z",
    };
    const generated = nurtureReadyAccount("account-1", {
      profileDraft: generatedDraft,
    });
    const selectedDraft = {
      ...generatedDraft,
      avatarPath: "/avatar-2.png",
      coverPath: "/cover-3.png",
    };
    const saved = nurtureReadyAccount("account-1", {
      profileDraft: selectedDraft,
      updatedAt: "2026-09-09T02:04:00.000Z",
    });
    const confirmed = nurtureReadyAccount("account-1", {
      platformAccountId: "account-one",
      profileDraft: {
        ...selectedDraft,
        reviewedAt: "2026-09-09T02:05:00.000Z",
      },
    });
    const onAction = vi.fn();
    apiMocks.listAccounts
      .mockResolvedValueOnce([empty])
      .mockResolvedValue([confirmed]);
    apiMocks.generateProfileDraft.mockResolvedValue(generated);
    apiMocks.updateAccount.mockResolvedValue(saved);
    apiMocks.confirmProfileDraft.mockResolvedValue(confirmed);

    renderWithQuery(
      <XhsOpsRunPlanner
        {...props(
          {
            type: "XhsOpsRunPlanner",
            projectId: "project-1",
            plans: [singlePlan("account-1")],
          },
          onAction,
        )}
      />,
    );

    expect(await screen.findAllByText(/养号条件尚未完成/)).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: "开始执行" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "每日自动执行" })).toBeNull();

    fireEvent.click(
      await screen.findByRole("button", { name: "一键生成完整资料" }),
    );
    await waitFor(() =>
      expect(apiMocks.generateProfileDraft).toHaveBeenCalledWith(
        "account-1",
        ["text", "avatar", "cover"],
        {},
      ),
    );
    const choices = document.querySelectorAll<HTMLButtonElement>(
      "button[aria-pressed]",
    );
    expect(choices).toHaveLength(6);
    fireEvent.click(choices[1]);
    fireEvent.click(choices[5]);
    fireEvent.change(screen.getByLabelText("目标小红书号"), {
      target: { value: "account-one" },
    });

    const confirmButton = screen.getByRole("button", {
      name: "校验确认资料",
    }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(apiMocks.updateAccount).toHaveBeenCalledTimes(1),
    );
    expect(apiMocks.updateAccount).toHaveBeenCalledWith("account-1", {
      expectedUpdatedAt: "2026-09-07T00:00:00.000Z",
      platformAccountId: "account-one",
      profileDraft: expect.objectContaining({
        avatarPath: "/avatar-2.png",
        coverPath: "/cover-3.png",
      }),
    });
    expect(
      apiMocks.updateAccount.mock.calls[0]?.[1].profileDraft,
    ).not.toHaveProperty("reviewedAt");
    await waitFor(() =>
      expect(apiMocks.confirmProfileDraft).toHaveBeenCalledWith(
        "account-1",
        "2026-09-09T02:04:00.000Z",
      ),
    );
    expect(
      await screen.findAllByText(/请先完成手机账号配置及资料生效核验/),
    ).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: "开始执行" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "安装登录、应用并核验" }),
    ).toBeTruthy();
    expect(onAction).toHaveBeenCalledWith(
      "xhs_ops_profile_material_confirmed",
      expect.objectContaining({ accountId: "account-1" }),
    );
    expect(apiMocks.createRun).not.toHaveBeenCalled();
  });

  it("keeps planning locked when profile material is only saved", async () => {
    const completeDraft: XhsOpsProfileDraft = {
      ...emptyProfileDraft(),
      nickname: "周末小周",
      bio: "水瓶座 INFP｜住在成都的设计师｜喜欢羽毛球和城市公园",
      gender: "女",
      birthday: "1994-02-10",
      region: "成都",
      interestTags: ["羽毛球", "城市公园"],
      avatarCandidates: ["/avatar.png"],
      coverCandidates: ["/cover.png"],
      avatarPath: "/avatar.png",
      coverPath: "/cover.png",
    };
    const unreviewed = account("account-1", { profileDraft: completeDraft });
    apiMocks.listAccounts.mockResolvedValue([unreviewed]);
    apiMocks.updateAccount.mockResolvedValue(unreviewed);

    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: [singlePlan("account-1")],
        })}
      />,
    );

    await screen.findByText(/保存草稿不会解锁养号/);
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() =>
      expect(apiMocks.updateAccount).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByRole("button", { name: "开始执行" })).toBeNull();
    expect(apiMocks.confirmProfileDraft).not.toHaveBeenCalled();
    expect(apiMocks.createRun).not.toHaveBeenCalled();
  });

  it("invalidates material confirmation after a profile edit", async () => {
    const base = account("account-1");
    const reviewed = account("account-1", {
      profileDraft: {
        ...base.profileDraft,
        reviewedAt: "2026-09-07T00:05:00.000Z",
        appliedAt: "2026-09-07T00:00:00.000Z",
        applyStatus: "applied",
      },
    });
    apiMocks.listAccounts.mockResolvedValue([reviewed]);

    renderWithQuery(
      <XhsOpsProfileMaterial
        {...props({ type: "XhsOpsProfileMaterial", projectId: "project-1" })}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "已校验确认" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("昵称"), {
      target: { value: "编辑后的昵称" },
    });
    expect(screen.getByRole("button", { name: "校验确认资料" })).toBeTruthy();
    expect(screen.getByText(/保存草稿不会解锁养号/)).toBeTruthy();
  });

  it("clears the profile confirmation after the operator edits it", async () => {
    apiMocks.getProject.mockResolvedValue({
      id: "project-1",
      updatedAt: "2026-09-07T01:00:00.000Z",
      profile: {
        summary: "已确认画像",
        base: { ageRange: "25-35", genderRatio: "女7男3", regions: [] },
        verticalInterests: [],
        generalInterests: [],
        confirmedAt: "2026-09-07T01:00:00.000Z",
      },
    });
    render(
      <XhsOpsProfileCard
        {...props({
          type: "XhsOpsProfileCard",
          projectId: "project-1",
          profile: {
            summary: "已确认画像",
            base: { ageRange: "25-35", genderRatio: "女7男3", regions: [] },
            verticalInterests: [],
            generalInterests: [],
            confirmedAt: "2026-09-07T01:00:00.000Z",
          },
        })}
      />,
    );

    await screen.findByRole("button", { name: "重新确认画像" });
    fireEvent.change(screen.getByLabelText("画像概述"), {
      target: { value: "编辑后的画像" },
    });
    expect(screen.getByRole("button", { name: "确认画像" })).toBeTruthy();
    expect(screen.queryByText(/已确认 \d{2}:\d{2}/)).toBeNull();
  });

  it("hydrates the profile card from the latest project instead of stale props", async () => {
    apiMocks.getProject.mockResolvedValue({
      id: "project-1",
      updatedAt: "2026-09-09T02:00:00.000Z",
      profile: {
        summary: "服务端最新画像",
        base: {
          ageRange: "30-40",
          genderRatio: "女6男4",
          regions: ["杭州"],
        },
        verticalInterests: ["羽毛球"],
        generalInterests: ["咖啡"],
        confirmedAt: null,
      },
    });

    render(
      <XhsOpsProfileCard
        {...props({
          type: "XhsOpsProfileCard",
          projectId: "project-1",
          profile: {
            summary: "会话中的旧画像",
            base: { ageRange: "20-25", genderRatio: "女9男1", regions: [] },
            verticalInterests: [],
            generalInterests: [],
            confirmedAt: "2026-09-07T01:00:00.000Z",
          },
        })}
      />,
    );

    expect(await screen.findByDisplayValue("服务端最新画像")).toBeTruthy();
    expect(screen.queryByDisplayValue("会话中的旧画像")).toBeNull();
    expect(apiMocks.getProject).toHaveBeenCalledWith("project-1");
  });

  it("confirms the latest profile with the project revision", async () => {
    const profile = {
      summary: "羽毛球城市爱好者",
      base: {
        ageRange: "25-35",
        genderRatio: "女6男4",
        regions: ["杭州"],
      },
      verticalInterests: ["羽毛球"],
      generalInterests: ["咖啡", "城市漫游"],
      confirmedAt: null,
    };
    apiMocks.getProject.mockResolvedValue({
      id: "project-1",
      updatedAt: "revision-1",
      profile,
    });
    apiMocks.confirmProfile.mockResolvedValue({
      id: "project-1",
      updatedAt: "revision-2",
      profile: {
        ...profile,
        confirmedAt: "2026-09-09T02:00:00.000Z",
        updatedAt: "2026-09-09T02:00:00.000Z",
      },
    });

    render(
      <XhsOpsProfileCard
        {...props({
          type: "XhsOpsProfileCard",
          projectId: "project-1",
          profile,
        })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "确认画像" }));

    await waitFor(() =>
      expect(apiMocks.confirmProfile).toHaveBeenCalledWith("project-1", {
        profile: {
          summary: profile.summary,
          base: profile.base,
          verticalInterests: profile.verticalInterests,
          generalInterests: profile.generalInterests,
        },
        expectedUpdatedAt: "revision-1",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "重新确认画像" }),
    ).toBeTruthy();
  });

  it("regenerates the profile in the desktop without a chat round trip", async () => {
    const initial = {
      summary: "旧画像",
      base: {
        ageRange: "25-35",
        genderRatio: "女6男4",
        regions: ["杭州"],
      },
      verticalInterests: ["羽毛球"],
      generalInterests: ["咖啡"],
      confirmedAt: "2026-09-09T01:00:00.000Z",
    };
    apiMocks.getProject.mockResolvedValue({
      id: "project-1",
      updatedAt: "revision-1",
      profile: initial,
    });
    apiMocks.generateProfile.mockResolvedValue({
      id: "project-1",
      updatedAt: "revision-2",
      profile: { ...initial, summary: "桌面重新生成的画像", confirmedAt: null },
    });
    render(
      <XhsOpsProfileCard
        {...props({
          type: "XhsOpsProfileCard",
          projectId: "project-1",
          profile: initial,
        })}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "重新生成画像" }),
    );

    expect(await screen.findByDisplayValue("桌面重新生成的画像")).toBeTruthy();
    expect(apiMocks.generateProfile).toHaveBeenCalledWith("project-1", {
      expectedUpdatedAt: "revision-1",
    });
  });

  it("clears account saved state after editing and disables devices used by another row", async () => {
    const first = account("account-1", { deviceId: "device-1" });
    const second = account("account-2", {
      deviceId: null,
      deviceName: null,
    });
    apiMocks.listAccounts.mockResolvedValue([first, second]);
    apiMocks.updateAccount.mockImplementation(async (id: string) =>
      id === first.id ? first : second,
    );
    const onAction = vi.fn();

    renderWithQuery(
      <XhsOpsAccountPlanner
        {...props(
          { type: "XhsOpsAccountPlanner", projectId: "project-1" },
          onAction,
        )}
      />,
    );

    await screen.findByDisplayValue(first.label);
    const selects = screen.getAllByRole("combobox");
    const usedOption = Array.from(
      (selects[1] as HTMLSelectElement).options,
    ).find((option) => option.value === "device-1");
    expect(usedOption?.disabled).toBe(true);
    expect(usedOption?.textContent).toContain("已绑定其他账号");

    fireEvent.click(screen.getByRole("button", { name: "保存账号配置" }));
    await screen.findByText(/草稿已保存/);
    expect(onAction).toHaveBeenCalledWith(
      "xhs_ops_accounts_saved",
      expect.objectContaining({
        agentInstruction: expect.stringContaining("确认人设"),
      }),
    );
    fireEvent.change(screen.getByDisplayValue(first.label), {
      target: { value: "修改后的账号名" },
    });
    expect(screen.queryByText(/草稿已保存/)).toBeNull();
  });

  it("shows a normal validation error for duplicate device bindings", async () => {
    apiMocks.listAccounts.mockResolvedValue([
      account("account-1", { deviceId: "device-1" }),
      account("account-2", { deviceId: "device-1" }),
    ]);

    renderWithQuery(
      <XhsOpsAccountPlanner
        {...props({ type: "XhsOpsAccountPlanner", projectId: "project-1" })}
      />,
    );

    await screen.findByDisplayValue("账号 account-1");
    fireEvent.click(screen.getByRole("button", { name: "保存账号配置" }));
    expect(await screen.findByText(/同一台设备只能绑定一个账号/)).toBeTruthy();
    expect(apiMocks.updateAccount).not.toHaveBeenCalled();
  });

  it("requires target account types when follow is enabled", async () => {
    apiMocks.listAccounts.mockResolvedValue([account("account-1")]);

    renderWithQuery(
      <XhsOpsAccountPlanner
        {...props({ type: "XhsOpsAccountPlanner", projectId: "project-1" })}
      />,
    );

    await screen.findByDisplayValue("账号 account-1");
    fireEvent.click(screen.getByRole("button", { name: "展开详细配置" }));
    fireEvent.click(screen.getByRole("switch", { name: "关注开关" }));
    expect(screen.getByLabelText("关注目标账号类型")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存账号配置" }));

    expect(
      await screen.findByText("开启关注时，请填写允许关注的目标账号类型"),
    ).toBeTruthy();
    expect(apiMocks.updateAccount).not.toHaveBeenCalled();
  });

  it("generates N candidates, batch-adds them, and confirms the reviewed selection", async () => {
    const profile = {
      summary: "杭州城市羽毛球人群",
      base: {
        ageRange: "25-35",
        genderRatio: "女6男4",
        regions: ["杭州"],
      },
      verticalInterests: ["羽毛球"],
      generalInterests: ["咖啡", "城市漫游"],
      confirmedAt: "2026-09-09T01:00:00.000Z",
      updatedAt: "2026-09-09T01:00:00.000Z",
    };
    const project = {
      id: "project-1",
      personaCount: 10,
      updatedAt: "project-revision-1",
      profile,
    };
    const suggestions = [
      {
        label: "球馆下班局",
        positioning: "下班后的羽毛球日常",
        persona: {
          age: "29岁",
          gender: "女",
          region: "杭州拱墅",
          occupation: "产品经理",
          lifeStatus: "独居养猫",
        },
        personaTags: {
          vertical: ["羽毛球装备"],
          general: ["咖啡", "城市漫游"],
        },
        interestPool: {
          core: ["羽毛球装备", "球馆测评", "双打技巧"],
          extended: ["运动恢复"],
          general: ["咖啡", "城市漫游", "摄影", "美食"],
        },
      },
      {
        label: "周末混双搭子",
        positioning: "周末混双和运动恢复",
        persona: {
          age: "33岁",
          gender: "男",
          region: "杭州滨江",
          occupation: "工程师",
          lifeStatus: "新婚",
        },
        personaTags: {
          vertical: ["羽毛球装备"],
          general: ["家居", "摄影"],
        },
        interestPool: {
          core: ["混双训练", "步法训练", "球拍测评"],
          extended: ["体能训练"],
          general: ["家居", "摄影", "旅行", "美食"],
        },
      },
    ];
    apiMocks.listAccounts.mockResolvedValue([]);
    apiMocks.getProject.mockResolvedValue(project);
    apiMocks.generatePersonas.mockResolvedValue({
      suggestions,
      distribution: "女1、男1；杭州拱墅1、杭州滨江1",
      project: { ...project, personaCount: 2, updatedAt: "project-revision-2" },
    });
    const savedAccounts = suggestions.map((suggestion, index) =>
      account(`generated-${index + 1}`, {
        ...suggestion,
        deviceId: null,
        deviceName: null,
        updatedAt: `account-revision-${index + 1}`,
      }),
    );
    apiMocks.createAccount.mockImplementation(
      async (_projectId: string, input: (typeof suggestions)[number]) => {
        const index = suggestions.findIndex(
          (item) => item.label === input.label,
        );
        return savedAccounts[index];
      },
    );
    apiMocks.confirmPersonas.mockResolvedValue(
      savedAccounts.map((item) => ({
        ...item,
        personaReviewedAt: "2026-09-09T03:00:00.000Z",
        personaReviewNote: "分布符合目标",
      })),
    );

    renderWithQuery(
      <XhsOpsAccountPlanner
        {...props({ type: "XhsOpsAccountPlanner", projectId: "project-1" })}
      />,
    );
    const countInput = await screen.findByLabelText("批量生成人设数量");
    fireEvent.change(countInput, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "批量生成人设" }));
    expect(await screen.findByText("球馆下班局")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全部加入" }));
    expect(screen.getAllByText(/待人工确认 \/ 复核/)).toHaveLength(2);
    expect(screen.getAllByText(/核心兴趣与.*重叠 100%/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "保存账号配置" }));
    expect(await screen.findByText(/草稿已保存/)).toBeTruthy();
    fireEvent.click(
      screen.getByLabelText("我已核对选定人设的差异及整体分布符合目标画像"),
    );
    fireEvent.change(screen.getByLabelText("人设分布复核说明"), {
      target: { value: "分布符合目标" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "确认选定人设，进入素材" }),
    );

    await waitFor(() =>
      expect(apiMocks.confirmPersonas).toHaveBeenCalledTimes(1),
    );
    expect(apiMocks.confirmPersonas).toHaveBeenCalledWith("project-1", {
      accounts: [
        { accountId: "generated-1", expectedUpdatedAt: "account-revision-1" },
        { accountId: "generated-2", expectedUpdatedAt: "account-revision-2" },
      ],
      expectedUpdatedAt: "project-revision-2",
      distributionReviewed: true,
      reviewNote: "分布符合目标",
    });
  });

  it("links incomplete profile and persona gates to their review components", async () => {
    const onAction = vi.fn();
    apiMocks.getProject.mockResolvedValue({ schedule: null, profile: null });
    apiMocks.listAccounts.mockResolvedValue([account("account-1")]);

    renderWithQuery(
      <XhsOpsRunPlanner
        {...props(
          {
            type: "XhsOpsRunPlanner",
            projectId: "project-1",
            plans: [singlePlan("account-1")],
          },
          onAction,
        )}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "去确认目标画像" }),
    );
    await waitFor(() =>
      expect(apiMocks.getProject.mock.calls.length).toBeGreaterThan(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "去复核账号人设" }));

    expect(onAction).toHaveBeenCalledWith(
      "xhs_ops_profile_review_requested",
      expect.objectContaining({ component: "XhsOpsProfileCard" }),
    );
    expect(onAction).toHaveBeenCalledWith(
      "xhs_ops_persona_review_requested",
      expect.objectContaining({ component: "XhsOpsAccountPlanner" }),
    );
    expect(screen.queryByRole("button", { name: "开始执行" })).toBeNull();
  });

  it.each([
    ["应用失败", "failed", null, null, null],
    ["尚未核验", "applied", "2026-09-09T01:01:00.000Z", null, null],
  ] as const)(
    "does not expose start when reviewed material is %s",
    async (_label, applyStatus, appliedAt, verifiedAt, verificationTaskId) => {
      const ready = nurtureReadyAccount("account-1");
      apiMocks.listAccounts.mockResolvedValue([
        {
          ...ready,
          profileDraft: {
            ...ready.profileDraft,
            applyStatus,
            appliedAt,
            verifiedAt,
            verifiedAccountId: verifiedAt ? ready.platformAccountId : null,
            verificationTaskId,
          },
        },
      ]);

      renderWithQuery(
        <XhsOpsRunPlanner
          {...props({
            type: "XhsOpsRunPlanner",
            projectId: "project-1",
            plans: [singlePlan("account-1")],
          })}
        />,
      );

      expect(
        await screen.findAllByText(/请先完成手机账号配置及资料生效核验/),
      ).not.toHaveLength(0);
      expect(screen.queryByRole("button", { name: "开始执行" })).toBeNull();
      expect(apiMocks.createRun).not.toHaveBeenCalled();
    },
  );

  it("keeps an active run cancellable while new runs are gated", async () => {
    const ready = nurtureReadyAccount("account-1");
    apiMocks.listAccounts.mockResolvedValue([
      {
        ...ready,
        profileDraft: {
          ...ready.profileDraft,
          applyStatus: "failed",
          appliedAt: null,
          verifiedAt: null,
          verifiedAccountId: null,
          verificationTaskId: null,
        },
      },
    ]);
    apiMocks.listRuns.mockResolvedValue([
      unsegmentedRun("active-before-gate", "running", "account-1"),
    ]);

    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: [singlePlan("account-1")],
        })}
      />,
    );

    expect(await screen.findByRole("button", { name: "取消" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "开始执行" })).toBeNull();
  });

  it.each(["preparation", "chunk"] as const)(
    "shows %s transport uncertainty as awaiting device confirmation",
    async (phase) => {
      const uncertain = unsegmentedRun(
        `uncertain-${phase}`,
        "running",
        "account-1",
      );
      if (phase === "preparation") {
        uncertain.preparation = {
          status: "running",
          reasonCode: "dispatch_failed",
          reason: "手机准备任务结果待核验",
          taskId: null,
          startedAt: "2026-09-09T01:00:00.000Z",
          completedAt: null,
        };
      } else {
        uncertain.error = "手机任务结果待核验：transport closed after dispatch";
        uncertain.chunks = [
          {
            index: 0,
            mode: "search",
            keyword: "羽毛球",
            plannedCount: 1,
            status: "running",
            taskId: null,
            startedAt: "2026-09-09T01:00:00.000Z",
            completedAt: null,
            browsed: 0,
            skipped: 0,
            refreshCount: 0,
            interactions: { like: 0, collect: 0, follow: 0 },
            anomalies: ["interrupted"],
            observation: null,
            posts: [],
            message: null,
            totalSteps: null,
            finalScreenshot: null,
            error: "手机任务结果待核验：transport closed after dispatch",
          },
        ];
      }
      apiMocks.listRuns.mockResolvedValue([uncertain]);

      renderWithQuery(
        <XhsOpsRunPlanner
          {...props({
            type: "XhsOpsRunPlanner",
            projectId: "project-1",
            plans: [singlePlan("account-1")],
          })}
        />,
      );

      expect(await screen.findByText("等待手机停止确认")).toBeTruthy();
      expect(
        screen.getByText(
          /手机仍可能继续执行，确认停止前不会向该设备派发后续任务/,
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    },
  );

  it("waits for history and adopts running before a newer queued run", async () => {
    let resolveHistory: ((runs: XhsOpsRun[]) => void) | undefined;
    apiMocks.listRuns.mockImplementation(
      () =>
        new Promise<XhsOpsRun[]>((resolve) => {
          resolveHistory = resolve;
        }),
    );
    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: [singlePlan("account-1")],
        })}
      />,
    );

    const start = (await screen.findByRole("button", {
      name: "开始执行",
    })) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    expect(apiMocks.createRun).not.toHaveBeenCalled();

    resolveHistory?.([
      unsegmentedRun("newer-queued", "planned", "account-1", "other-run"),
      unsegmentedRun("older-running", "running", "account-1"),
    ]);
    await screen.findByRole("button", { name: "取消" });
    expect(screen.queryByText("排队中")).toBeNull();
    expect(apiMocks.createRun).not.toHaveBeenCalled();
    expect(apiMocks.startRun).not.toHaveBeenCalled();
  });

  it("rechecks history before create and adopts a scheduler run", async () => {
    apiMocks.listRuns
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        unsegmentedRun("scheduled-running", "running", "account-1"),
      ]);
    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: [singlePlan("account-1")],
        })}
      />,
    );

    const start = await waitFor(() => {
      const button = screen.getByRole("button", {
        name: "开始执行",
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      return button;
    });
    fireEvent.click(start);

    await screen.findByRole("button", { name: "取消" });
    expect(apiMocks.createRun).not.toHaveBeenCalled();
    expect(apiMocks.startRun).not.toHaveBeenCalled();
  });

  it("ignores an active comment run when starting a browse plan", async () => {
    const commentRun = unsegmentedRun(
      "comment-running",
      "running",
      "account-1",
    );
    commentRun.plan = {
      ...commentRun.plan,
      kind: "comment",
      keywords: [],
      homeFeedCount: 0,
      comments: [
        {
          draftId: "draft-1",
          postTitle: "球拍选择",
          postAuthor: "作者",
          text: "很实用",
        },
      ],
    };
    apiMocks.listRuns.mockResolvedValue([commentRun]);
    apiMocks.createRun.mockResolvedValue(
      unsegmentedRun("browse-created", "planned", "account-1"),
    );
    apiMocks.startRun.mockResolvedValue(
      unsegmentedRun("browse-created", "running", "account-1"),
    );
    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: [singlePlan("account-1")],
        })}
      />,
    );

    const start = await waitFor(() => {
      const button = screen.getByRole("button", {
        name: "开始执行",
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      return button;
    });
    fireEvent.click(start);

    await screen.findByRole("button", { name: "取消" });
    expect(apiMocks.createRun).toHaveBeenCalledTimes(1);
    expect(apiMocks.startRun).toHaveBeenCalledWith("browse-created");
  });

  it("requires a successful history retry before starting", async () => {
    apiMocks.listRuns
      .mockRejectedValueOnce(new Error("历史暂不可用"))
      .mockResolvedValue([]);
    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: [singlePlan("account-1")],
        })}
      />,
    );

    await screen.findByText("历史暂不可用");
    expect(
      (screen.getByRole("button", { name: "开始执行" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(apiMocks.createRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重试加载运行历史" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "开始执行" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it.each([
    ["running", null],
    ["planned", "other-run"],
  ] as const)(
    "adopts a reused %s create result without starting it again",
    async (status, queuedBehindRunId) => {
      apiMocks.createRun.mockResolvedValue(
        unsegmentedRun("reused-active", status, "account-1", queuedBehindRunId),
      );
      renderWithQuery(
        <XhsOpsRunPlanner
          {...props({
            type: "XhsOpsRunPlanner",
            projectId: "project-1",
            plans: [singlePlan("account-1")],
          })}
        />,
      );

      const start = await waitFor(() => {
        const button = screen.getByRole("button", {
          name: "开始执行",
        }) as HTMLButtonElement;
        expect(button.disabled).toBe(false);
        return button;
      });
      fireEvent.click(start);

      if (status === "running") {
        await screen.findByRole("button", { name: "取消" });
      } else {
        await screen.findByText("排队中");
      }
      expect(apiMocks.createRun).toHaveBeenCalledWith(
        expect.objectContaining({ reuseActive: true }),
      );
      expect(apiMocks.startRun).not.toHaveBeenCalled();
    },
  );

  it("adopts a run started concurrently after start returns 409", async () => {
    const created = unsegmentedRun("concurrent-start", "planned", "account-1");
    apiMocks.createRun.mockResolvedValue(created);
    apiMocks.startRun.mockRejectedValue(
      Object.assign(new Error("运行状态已变化"), { status: 409 }),
    );
    apiMocks.getRun.mockResolvedValue(
      unsegmentedRun("concurrent-start", "running", "account-1"),
    );
    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: [singlePlan("account-1")],
        })}
      />,
    );

    const start = await waitFor(() => {
      const button = screen.getByRole("button", {
        name: "开始执行",
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      return button;
    });
    fireEvent.click(start);

    await screen.findByRole("button", { name: "取消" });
    expect(apiMocks.getRun).toHaveBeenCalledWith("concurrent-start");
    expect(screen.queryByText(/计划已创建但启动失败/)).toBeNull();
  });

  it("starts cards for different devices independently", async () => {
    const first = nurtureReadyAccount("account-1", {
      deviceId: "phone-1",
      deviceName: "手机1",
    });
    const second = nurtureReadyAccount("account-2", {
      deviceId: "phone-2",
      deviceName: "手机2",
    });
    apiMocks.listAccounts.mockResolvedValue([first, second]);
    apiMocks.listRuns.mockResolvedValue([]);
    apiMocks.createRun.mockImplementation(
      async (input: { accountId: string }) =>
        unsegmentedRun(
          `created-${input.accountId}`,
          "planned",
          input.accountId,
        ),
    );
    apiMocks.startRun.mockImplementation(async (id: string) =>
      unsegmentedRun(id, "running", id.replace("created-", "")),
    );

    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: [singlePlan("account-1"), singlePlan("account-2")],
        })}
      />,
    );

    await waitFor(() =>
      expect(
        (
          screen.getAllByRole("button", {
            name: "开始执行",
          }) as HTMLButtonElement[]
        ).every((button) => !button.disabled),
      ).toBe(true),
    );
    for (const button of screen.getAllByRole("button", {
      name: "开始执行",
    })) {
      fireEvent.click(button);
    }

    await waitFor(() => expect(apiMocks.createRun).toHaveBeenCalledTimes(2));
    expect(
      apiMocks.createRun.mock.calls.map(([input]) => input.accountId),
    ).toEqual(["account-1", "account-2"]);
    await waitFor(() => expect(apiMocks.startRun).toHaveBeenCalledTimes(2));
  });

  it("guards duplicate start events before React commits busy state", async () => {
    let resolveFreshHistory: ((runs: XhsOpsRun[]) => void) | undefined;
    apiMocks.listRuns.mockResolvedValueOnce([]).mockImplementationOnce(
      () =>
        new Promise<XhsOpsRun[]>((resolve) => {
          resolveFreshHistory = resolve;
        }),
    );
    apiMocks.createRun.mockResolvedValue(
      unsegmentedRun("created-once", "planned", "account-1"),
    );
    apiMocks.startRun.mockResolvedValue(
      unsegmentedRun("created-once", "running", "account-1"),
    );
    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: [singlePlan("account-1")],
        })}
      />,
    );

    const start = await waitFor(() => {
      const button = screen.getByRole("button", {
        name: "开始执行",
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      return button;
    });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(apiMocks.listRuns).toHaveBeenCalledTimes(2);

    resolveFreshHistory?.([]);
    await waitFor(() => expect(apiMocks.createRun).toHaveBeenCalledTimes(1));
    expect(apiMocks.startRun).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "interrupted"] as const)(
    "%s does not unlock or auto-start the next segment",
    async (status) => {
      const created = run("run-1", "planned", 1);
      apiMocks.createRun.mockResolvedValue(created);
      apiMocks.startRun.mockResolvedValue(run("run-1", status, 1));

      renderWithQuery(
        <XhsOpsRunPlanner
          {...props({
            type: "XhsOpsRunPlanner",
            projectId: "project-1",
            plans: plannerPlans(),
          })}
        />,
      );

      const start = await enabledStartButton();
      fireEvent.click(start);
      await screen.findByText(status === "failed" ? "失败" : "已中断");
      expect(
        (
          screen.getByRole("button", {
            name: "等待上一段",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(apiMocks.createRun).toHaveBeenCalledTimes(1);
    },
  );

  it("shows a persisted unconfirmed phone task instead of a terminal failure", async () => {
    const onAction = vi.fn();
    const uncertain = unsegmentedRun("unconfirmed-run", "failed", "account-1");
    uncertain.preparation = {
      status: "running",
      reasonCode: "dispatch_failed",
      reason: "手机任务停止未确认",
      taskId: "owned-phone-task",
      startedAt: "2026-09-07T00:00:01.000Z",
      completedAt: null,
    };
    apiMocks.listRuns.mockResolvedValue([uncertain]);

    renderWithQuery(
      <XhsOpsRunPlanner
        {...props(
          {
            type: "XhsOpsRunPlanner",
            projectId: "project-1",
            plans: [singlePlan("account-1")],
          },
          onAction,
        )}
      />,
    );

    expect(await screen.findByText("等待手机停止确认")).toBeTruthy();
    expect(screen.getByText(/确认任务结束后重启桌面端复核/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "开始执行" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新计划" })).toBeNull();
    expect(apiMocks.createRun).not.toHaveBeenCalled();
    expect(apiMocks.startRun).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("cancelled does not unlock or auto-start the next segment", async () => {
    const created = run("run-1", "planned", 1);
    apiMocks.createRun.mockResolvedValue(created);
    apiMocks.startRun.mockResolvedValue(run("run-1", "running", 1));
    apiMocks.cancelRun.mockResolvedValue(run("run-1", "cancelled", 1));

    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: plannerPlans(),
        })}
      />,
    );

    fireEvent.click(await enabledStartButton());
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await screen.findByText("已取消");
    expect(
      (
        screen.getByRole("button", {
          name: "等待上一段",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(apiMocks.createRun).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["completed", false],
    ["running", true],
  ] as const)(
    "restores a %s predecessor when reopening on a later segment",
    async (status, shouldRemainLocked) => {
      apiMocks.listRuns.mockResolvedValue([run("previous", status, 1)]);
      apiMocks.createRun.mockResolvedValue(run("next", "planned", 2));
      apiMocks.startRun.mockResolvedValue(run("next", "running", 2));

      renderWithQuery(
        <XhsOpsRunPlanner
          {...props({
            type: "XhsOpsRunPlanner",
            projectId: "project-1",
            plans: plannerPlans([2]),
          })}
        />,
      );

      if (shouldRemainLocked) {
        await screen.findByRole("button", { name: "等待上一段" });
        expect(
          (
            screen.getByRole("button", {
              name: "等待上一段",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
      } else {
        await waitFor(() =>
          expect(
            (
              screen.getByRole("button", {
                name: "开始执行",
              }) as HTMLButtonElement
            ).disabled,
          ).toBe(false),
        );
      }
      expect(apiMocks.createRun).not.toHaveBeenCalled();
    },
  );

  it("uses the newest predecessor status when older history was completed", async () => {
    apiMocks.listRuns.mockResolvedValue([
      run("newer-failed", "failed", 1),
      run("older-completed", "completed", 1),
    ]);

    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: plannerPlans([2]),
        })}
      />,
    );

    const button = (await screen.findByRole("button", {
      name: "等待上一段",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(apiMocks.createRun).not.toHaveBeenCalled();
  });

  it("retries an unqueued planned run after start fails without creating another run", async () => {
    const created = unsegmentedRun("retry-run", "planned", "account-1");
    apiMocks.listRuns
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([created]);
    apiMocks.createRun.mockResolvedValue(created);
    apiMocks.startRun
      .mockRejectedValueOnce(new Error("前序段尚未完成"))
      .mockResolvedValueOnce(run("retry-run", "running", 1));

    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: [singlePlan("account-1")],
        })}
      />,
    );

    fireEvent.click(await enabledStartButton());
    await screen.findByText(/计划已创建但启动失败.*前序段尚未完成/);
    fireEvent.click(await enabledStartButton());
    await screen.findByRole("button", { name: "取消" });
    expect(apiMocks.createRun).toHaveBeenCalledTimes(1);
    expect(apiMocks.startRun).toHaveBeenCalledTimes(2);
  });

  it("creates a new run when the local pending snapshot is terminal in fresh history", async () => {
    const first = unsegmentedRun("first-run", "planned", "account-1");
    const cancelled = unsegmentedRun("first-run", "cancelled", "account-1");
    const second = unsegmentedRun("second-run", "planned", "account-1");
    apiMocks.listRuns
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([cancelled]);
    apiMocks.createRun
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    apiMocks.startRun
      .mockRejectedValueOnce(new Error("首次启动失败"))
      .mockResolvedValueOnce(
        unsegmentedRun("second-run", "running", "account-1"),
      );
    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: [singlePlan("account-1")],
        })}
      />,
    );

    fireEvent.click(await enabledStartButton());
    await screen.findByText(/首次启动失败/);
    fireEvent.click(await enabledStartButton());

    await screen.findByRole("button", { name: "取消" });
    expect(apiMocks.createRun).toHaveBeenCalledTimes(2);
    expect(apiMocks.startRun).toHaveBeenLastCalledWith("second-run");
  });

  it("allows a home-only plan after deleting the final keyword", async () => {
    const created = run("home-only", "planned", 1);
    apiMocks.createRun.mockResolvedValue(created);
    apiMocks.startRun.mockResolvedValue(run("home-only", "running", 1));

    renderWithQuery(
      <XhsOpsRunPlanner
        {...props({
          type: "XhsOpsRunPlanner",
          projectId: "project-1",
          plans: plannerPlans([1]),
        })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "删除关键词" }));
    await waitFor(() => expect(screen.queryByLabelText("关键词 1")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "开始执行" }));
    await waitFor(() => expect(apiMocks.createRun).toHaveBeenCalled());
    expect(apiMocks.createRun.mock.calls[0]?.[0]).toMatchObject({
      plan: { keywords: [], homeFeedCount: 1 },
    });
  });
});
