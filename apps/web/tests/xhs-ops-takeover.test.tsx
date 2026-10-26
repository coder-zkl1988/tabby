// @vitest-environment jsdom

import {
  PHONE_SKILLS_BUNDLE,
  XHS_TAKEOVER_IDENTITY_READ_TTL_MS,
  XHS_TAKEOVER_MANUAL_CHECK_AUDIT_FLAGS,
  XHS_TAKEOVER_RESUME_REASON_CODES,
  xhsOpsAccountAuditSchema,
  xhsOpsAccountDiagnosisSchema,
  xhsOpsAccountSchema,
  xhsOpsChangeOrderSchema,
  xhsOpsRunSchema,
} from "@nexu/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import {
  type MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { SurfaceManager } from "../src/lib/a2ui/a2ui-surface";
import type { A2UIComponent, SurfaceState } from "../src/lib/a2ui/a2ui-types";
import type { CustomComponentProps } from "../src/lib/a2ui/custom-components/registry";
import { XhsOpsAccountPlanner } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsAccountPlanner";
import { XhsOpsCommentReview } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsCommentReview";
import { XhsOpsProfileMaterial } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsProfileMaterial";
import { XhsOpsRunPlanner } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsRunPlanner";
import { XhsOpsTakeover } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsTakeover";
import * as takeoverModel from "../src/lib/a2ui/custom-components/xhs-ops/xhs-ops-takeover-model";
import {
  TAKEOVER_AUTHORIZATION_STATEMENT,
  TAKEOVER_POLICY_MODE_UNKNOWN_NOTICE,
  TAKEOVER_SKILL_BUNDLE_NOTICE,
  isTakeoverRecovering,
  mergeRevisions,
  olderRevision,
  takeoverEventKey,
  takeoverImageProblem,
  takeoverParamConflict,
  takeoverPolicyModeState,
  takeoverSkillDocsState,
  takeoverSkillPhoneOlderNotice,
  takeoverSkillSyncNotice,
} from "../src/lib/a2ui/custom-components/xhs-ops/xhs-ops-takeover-model";

const apiMocks = vi.hoisted(() => ({
  getAccount: vi.fn(),
  getProject: vi.fn(),
  listAccounts: vi.fn(),
  listDeviceBindings: vi.fn(),
  listRuns: vi.fn(),
  listAudits: vi.fn(),
  listChangeOrders: vi.fn(),
  getDiagnosis: vi.fn(),
  getPlaybook: vi.fn(),
  authorizeTakeover: vi.fn(),
  readTakeoverIdentity: vi.fn(),
  confirmTakeoverIdentity: vi.fn(),
  startAudit: vi.fn(),
  getAudit: vi.fn(),
  confirmBaseline: vi.fn(),
  generateDiagnosis: vi.fn(),
  regenerateDiagnosis: vi.fn(),
  decideDiagnosis: vi.fn(),
  confirmTakeoverPlan: vi.fn(),
  getChangeOrder: vi.fn(),
  createChangeOrder: vi.fn(),
  confirmChangeOrder: vi.fn(),
  uploadChangeOrderImage: vi.fn(),
  visualCheckChangeOrder: vi.fn(),
  applyProfileDraft: vi.fn(),
  resumeTakeover: vi.fn(),
  pauseTakeover: vi.fn(),
  confirmPersonas: vi.fn(),
  updateAccount: vi.fn(),
  createAccount: vi.fn(),
  transferDevice: vi.fn(),
  suggestPlans: vi.fn(),
  listComments: vi.fn(),
  createCommentRun: vi.fn(),
  getRun: vi.fn(),
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

const T0 = "2026-10-20T02:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

const resolveLiteral = <T,>(value: T): unknown => value;

/**
 * A catalog component's node as the renderer hands it over. A2UI's own
 * union has no member for "XhsOpsTakeover" and the like: the renderer's
 * default branch passes the node through as it arrived, typed A2UIComponent
 * (a2ui-renderer.tsx), and the cards read it with readProp. The narrowing
 * below is that same boundary, from a node every A2UIComponent satisfies.
 */
function customNode(
  fields: { type: string } & Record<string, unknown>,
): A2UIComponent {
  const node: Pick<A2UIComponent, "id"> & { type: string } = {
    id: `test-${fields.type}`,
    ...fields,
  };
  return node as A2UIComponent;
}

function props(
  fields: { type: string } & Record<string, unknown>,
  onAction: CustomComponentProps["onAction"] = () => {},
): CustomComponentProps {
  return {
    comp: customNode(fields),
    resolve: resolveLiteral,
    surface: {} as SurfaceState,
    manager: {} as SurfaceManager,
    onAction,
  };
}

function withQuery(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{element}</QueryClientProvider>;
}

/** One client per test, so a rerender keeps the card's device query. */
let cardQueryClient = new QueryClient();

/** What the controller answers while its startup recovery runs (§2.6). */
function recoveringError(): Error {
  return Object.assign(
    new Error("控制端刚重启，正在收口上次未完成的接管任务，请稍后重试"),
    { status: 503 },
  );
}

/** The controller's structured 409 for takeover parameters (xhsOpsAccountConflictResponseSchema). */
function paramConflictError(
  code: "takeover_override_reason_required" | "takeover_param_hard_limit",
  issues: Array<{ field: string; message: string; overridable: boolean }>,
): Error {
  const message =
    code === "takeover_param_hard_limit"
      ? issues
          .filter((issue) => !issue.overridable)
          .map((issue) => issue.message)
          .join("；")
      : `${issues.map((issue) => issue.message).join("；")}。超出接管档位的调整需要填写理由`;
  return Object.assign(new Error(message), {
    status: 409,
    body: { message, code, issues },
  });
}

const LIKE_OVER_TIER = {
  field: "interaction.like.dailyCap",
  message: "点赞每日上限 6 超过接管档位（成熟档）上限 4",
  overridable: true,
};
const DWELL_TOO_SHORT = {
  field: "browseDefaults.dwellSecMin",
  message: "停留时间下限 5 秒低于硬下限 11 秒",
  overridable: false,
};

/** Resolves a little later, like a request would. */
function later<T>(value: T, ms = 20): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Lets settled queries and requests render. */
async function flush(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** An existing-mode account; `takeover` null = bound, nothing authorized yet. */
function account(
  takeover: Record<string, unknown> | null,
  overrides: Record<string, unknown> = {},
) {
  return xhsOpsAccountSchema.parse({
    id: "account-1",
    projectId: "project-1",
    entryMode: "existing",
    label: "接管·Phone 1",
    platformAccountId: takeover?.identityConfirmedAt ? "xhs-123" : "",
    deviceId: "device-1",
    deviceName: "Phone 1",
    takeover,
    createdAt: T0,
    updatedAt: "account-rev-1",
    ...overrides,
  });
}

const LOCKED = {
  authorizedAt: T0,
  identityConfirmedAt: T0,
  identitySource: "takeover",
};
const BASELINED = {
  ...LOCKED,
  baselineAuditId: "audit-1",
  latestAuditId: "audit-1",
};
const PLAN_CONFIRMED = {
  ...BASELINED,
  activeDiagnosisId: "diag-1",
  planConfirmedAt: T0,
  maturity: "established",
};

function audit(overrides: Record<string, unknown> = {}) {
  return xhsOpsAccountAuditSchema.parse({
    id: "audit-1",
    projectId: "project-1",
    accountId: "account-1",
    deviceId: "device-1",
    platformAccountId: "xhs-123",
    trigger: "takeover",
    status: "completed",
    profile: {
      status: "read",
      code: "ok",
      evidence: null,
      accountMatched: true,
      values: {
        nickname: "小林的通勤穿搭",
        bio: "上班族穿搭记录",
        occupation: "产品经理",
        gender: "女",
        birthdayFilled: true,
        region: "中国 上海 上海",
      },
    },
    home: {
      status: "read",
      code: "ok",
      evidence: null,
      nickname: "小林的通勤穿搭",
      header: {
        following: { text: "120", value: 120, approx: false },
        followers: { text: "1.2万", value: 12000, approx: true },
        likesCollects: { text: "8.9万", value: 89000, approx: true },
      },
      headerEnd: null,
      notesEnd: false,
      notes: [
        {
          i: 1,
          title: "通勤穿搭合集",
          likes: { text: "356", value: 356, approx: false },
          video: false,
          pinned: true,
        },
      ],
    },
    startedAt: T0,
    completedAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
}

function diagnosis(overrides: Record<string, unknown> = {}) {
  return xhsOpsAccountDiagnosisSchema.parse({
    id: "diag-1",
    projectId: "project-1",
    accountId: "account-1",
    auditId: "audit-1",
    version: 1,
    status: "ready",
    playbookVersion: "2026-10-20.1",
    facts: { tier: "established" },
    cadence: { browseDefaults: {}, interaction: {}, rationale: [] },
    summary: "通勤穿搭为主的成熟号",
    generator: { botId: "bot-1", model: null },
    createdAt: T0,
    updatedAt: "diag-rev-1",
    ...overrides,
  });
}

function imageOrder(overrides: Record<string, unknown> = {}) {
  return xhsOpsChangeOrderSchema.parse({
    id: "order-1",
    projectId: "project-1",
    accountId: "account-1",
    deviceId: "device-1",
    platformAccountId: "xhs-123",
    diagnosisId: "diag-1",
    proposalIds: ["P3"],
    batchIndex: 3,
    risk: "L2",
    fields: [
      {
        field: "avatar",
        baselineValue: "",
        after: "户外自然光半身照",
        imagePath: "/state/media/xhs-takeover/order-1/avatar.png",
        imageSha256: "sha-1",
      },
    ],
    status: "awaiting_confirm",
    precheck: {
      taskId: "task-1",
      readAt: T0,
      accountMatched: true,
      drift: [],
      confirmDigest: "a".repeat(64),
      expiresAt: FUTURE,
    },
    createdAt: T0,
    updatedAt: "order-rev-1",
    ...overrides,
  });
}

const confirmedProject = {
  id: "project-1",
  schedule: null,
  updatedAt: T0,
  profile: { confirmedAt: T0 },
};

function takeoverCard(
  comp: Record<string, unknown> = {},
  onAction: CustomComponentProps["onAction"] = () => {},
) {
  return (
    <QueryClientProvider client={cardQueryClient}>
      <XhsOpsTakeover
        {...props(
          {
            type: "XhsOpsTakeover",
            projectId: "project-1",
            accountId: "account-1",
            ...comp,
          },
          onAction,
        )}
      />
    </QueryClientProvider>
  );
}

function section(name: string): HTMLElement | null {
  return document.querySelector(`[data-takeover-section="${name}"]`);
}

describe("XhsOpsTakeover", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sessionStorage.clear();
    cardQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    apiMocks.getProject.mockResolvedValue(confirmedProject);
    apiMocks.listAudits.mockResolvedValue([]);
    apiMocks.listChangeOrders.mockResolvedValue([]);
    apiMocks.getPlaybook.mockResolvedValue({ version: "v", rules: [] });
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

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows only the authorization step before the takeover starts", async () => {
    const bound = account(null);
    const authorized = account({ authorizedAt: T0 }, { updatedAt: "rev-2" });
    apiMocks.getAccount
      .mockResolvedValueOnce(bound)
      .mockResolvedValue(authorized);
    apiMocks.authorizeTakeover.mockResolvedValue(authorized);

    render(takeoverCard());

    const statement = await screen.findByLabelText(
      TAKEOVER_AUTHORIZATION_STATEMENT,
    );
    expect(section("authorize")).not.toBeNull();
    expect(section("identity")).toBeNull();
    expect(section("audit")).toBeNull();
    const authorize = screen.getByRole("button", {
      name: "确认授权，开始接管",
    }) as HTMLButtonElement;
    expect(authorize.disabled).toBe(true);

    fireEvent.click(statement);
    expect(authorize.disabled).toBe(false);
    fireEvent.click(authorize);

    await waitFor(() =>
      expect(apiMocks.authorizeTakeover).toHaveBeenCalledWith("account-1", {
        expectedUpdatedAt: "account-rev-1",
        ownershipConfirmed: true,
      }),
    );
    expect(
      await screen.findByRole("button", { name: "读取手机当前账号" }),
    ).toBeTruthy();
    expect(section("audit")).toBeNull();
  });

  it("opens the sections the derived stage has reached", async () => {
    apiMocks.getAccount.mockResolvedValue(account(LOCKED));

    render(takeoverCard());

    expect(
      await screen.findByRole("button", { name: "开始只读盘点" }),
    ).toBeTruthy();
    expect(
      within(section("identity") as HTMLElement).getByText("xhs-123"),
    ).toBeTruthy();
    expect(section("authorize")?.textContent).toContain("已授权");
    expect(section("audit")?.textContent).toContain(
      "误赞、误收藏他人内容无法事后检出。",
    );
    expect(section("diagnosis")).toBeNull();
    expect(section("change-orders")).toBeNull();
  });

  it("requires the manual check before a flagged audit becomes the baseline", async () => {
    const flagged = audit({ flags: ["countsChanged"] });
    apiMocks.getAccount.mockResolvedValue(
      account({ ...LOCKED, latestAuditId: "audit-1" }),
    );
    apiMocks.listAudits.mockResolvedValue([flagged]);
    apiMocks.confirmBaseline.mockResolvedValue({
      account: account(BASELINED),
      audit: { ...flagged, manualCheckAt: T0 },
      event: {
        name: "xhs_ops_account_audited",
        payload: { auditId: "audit-1", status: "completed", baseline: true },
      },
    });
    const onAction = vi.fn();

    render(takeoverCard({}, onAction));

    const baseline = (await screen.findByRole("button", {
      name: "数据核对无误，设为基线",
    })) as HTMLButtonElement;
    expect(baseline.disabled).toBe(true);
    expect(screen.getByText("1.2万 → 约 12,000")).toBeTruthy();
    expect(screen.getByText("通勤穿搭合集")).toBeTruthy();
    expect(screen.getByText("已填")).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/已人工检查/));
    fireEvent.click(baseline);

    await waitFor(() =>
      expect(apiMocks.confirmBaseline).toHaveBeenCalledWith("audit-1", {
        manualChecked: true,
      }),
    );
    expect(onAction).toHaveBeenCalledWith(
      "xhs_ops_account_audited",
      expect.objectContaining({ baseline: true }),
    );
  });

  it("uses feedbackDraft only to pre-fill, and never over the user's typing", async () => {
    apiMocks.getAccount.mockResolvedValue(account(BASELINED));
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.generateDiagnosis.mockResolvedValue(
      diagnosis({ status: "generating" }),
    );

    const view = render(
      takeoverCard({ feedbackDraft: "昵称保留，护肤慢慢加" }),
    );

    const box = (await screen.findByLabelText(
      "来自对话的意见（未提交）",
    )) as HTMLTextAreaElement;
    expect(box.value).toBe("昵称保留，护肤慢慢加");
    expect(apiMocks.generateDiagnosis).not.toHaveBeenCalled();

    // A new draft replaces one the user has not touched…
    view.rerender(takeoverCard({ feedbackDraft: "整体转向护肤" }));
    await waitFor(() => expect(box.value).toBe("整体转向护肤"));

    // …but never what the user is typing.
    fireEvent.change(box, { target: { value: "我自己的意见" } });
    view.rerender(takeoverCard({ feedbackDraft: "第三版意见" }));
    await screen.findByText(/对话里有新的意见/);
    expect(box.value).toBe("我自己的意见");
    expect(apiMocks.generateDiagnosis).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "按意见生成诊断" }));
    await waitFor(() =>
      expect(apiMocks.generateDiagnosis).toHaveBeenCalledWith("account-1", {
        auditId: "audit-1",
        feedback: "我自己的意见",
      }),
    );
  });

  it("asks twice before adopting an item that cites no known rule", async () => {
    const ready = diagnosis({
      proposals: [
        {
          id: "P1",
          kind: "profileField",
          field: "bio",
          to: "通勤穿搭也聊护肤",
          rationale: "目标人群关注护肤",
          ruleIds: ["ZZ-99"],
          risk: "L1",
          batch: 1,
          from: "上班族穿搭记录",
        },
      ],
    });
    apiMocks.getAccount.mockResolvedValue(
      account({ ...BASELINED, activeDiagnosisId: "diag-1" }),
    );
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({ diagnosis: ready, event: null });
    apiMocks.decideDiagnosis.mockResolvedValue(ready);

    render(takeoverCard());

    const card = (await screen.findByText(/P1 · 简介/)).closest(
      "[data-proposal]",
    ) as HTMLElement;
    expect(within(card).getByText("无经验依据")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "采纳" }));
    expect(
      screen.getByRole("dialog", { name: "这条建议没有经验依据" }),
    ).toBeTruthy();
    expect(apiMocks.decideDiagnosis).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "仍然采纳" }));
    await waitFor(() =>
      expect(apiMocks.decideDiagnosis).toHaveBeenCalledWith("diag-1", {
        expectedUpdatedAt: "diag-rev-1",
        decisions: { P1: { decision: "adopt" } },
      }),
    );
    expect(screen.getByRole("button", { name: "确认优化方案" })).toBeTruthy();
  });

  it("keeps the change-order confirmation disabled until every required ack is ticked", async () => {
    apiMocks.getAccount.mockResolvedValue(
      account({ ...PLAN_CONFIRMED, activeChangeOrderId: "order-1" }),
    );
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });
    apiMocks.listChangeOrders.mockResolvedValue([imageOrder()]);
    apiMocks.confirmChangeOrder.mockResolvedValue({
      order: imageOrder({ status: "applying", applyTaskId: "pending" }),
      account: account({ ...PLAN_CONFIRMED, activeChangeOrderId: "order-1" }),
      event: null,
    });

    render(takeoverCard());

    const orders = await waitFor(() => {
      const card = document.querySelector<HTMLElement>(
        '[data-change-order="order-1"]',
      );
      expect(card).not.toBeNull();
      return card as HTMLElement;
    });
    // awaiting_confirm holds nurture: the card lists it as a to-do.
    expect(screen.getByTestId("change-order-todo").textContent).toContain(
      "养号暂停",
    );
    fireEvent.click(within(orders).getByRole("button", { name: "确认执行" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("公开、不可撤销");
    expect(dialog.textContent).toContain("头像无法恢复原图");
    expect(dialog.textContent).toContain("剩余预算");
    const confirm = within(dialog).getByRole("button", {
      name: "确认执行",
    }) as HTMLButtonElement;
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    expect(dialog.textContent).toContain(
      "推进手机相册的图片不会自动删除，换好后请自己在手机相册里删除。",
    );
    expect(confirm.disabled).toBe(true);

    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[1] as HTMLElement);
    expect(confirm.disabled).toBe(true);
    fireEvent.click(boxes[2] as HTMLElement);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(apiMocks.confirmChangeOrder).toHaveBeenCalledWith("order-1", {
        confirmDigest: "a".repeat(64),
        expectedUpdatedAt: "order-rev-1",
        acks: { photoPermission: true, screenshotPrivacy: true, cleanup: true },
      }),
    );
  });

  it("validates a picture's type and size before uploading it", async () => {
    const draft = imageOrder({
      status: "draft",
      precheck: null,
      fields: [{ field: "avatar", baselineValue: "", after: "户外半身照" }],
    });
    apiMocks.getAccount.mockResolvedValue(account(PLAN_CONFIRMED));
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });
    apiMocks.listChangeOrders.mockResolvedValue([draft]);
    apiMocks.uploadChangeOrderImage.mockResolvedValue({
      order: imageOrder({ status: "draft", precheck: null }),
      account: account(PLAN_CONFIRMED),
      event: null,
    });

    render(takeoverCard());

    const input = await screen.findByLabelText("上传头像图片");
    expect(
      (screen.getByRole("button", { name: "预检" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.change(input, {
      target: { files: [new File(["GIF89a"], "a.gif", { type: "image/gif" })] },
    });
    expect(
      await screen.findByText("头像：只支持 png、jpeg 或 webp 图片"),
    ).toBeTruthy();

    const huge = new File(["x"], "big.png", { type: "image/png" });
    Object.defineProperty(huge, "size", { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [huge] } });
    expect(await screen.findByText("头像：图片不能超过 10MB")).toBeTruthy();
    expect(apiMocks.uploadChangeOrderImage).not.toHaveBeenCalled();

    const png = new File([new Uint8Array([137, 80, 78, 71])], "ok.png", {
      type: "image/png",
    });
    fireEvent.change(input, { target: { files: [png] } });
    await waitFor(() =>
      expect(apiMocks.uploadChangeOrderImage).toHaveBeenCalledWith(
        "order-1",
        "avatar",
        {
          dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
          expectedUpdatedAt: "order-rev-1",
        },
      ),
    );
  });

  it("forwards a polled event once, across cards and remounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const verifying = imageOrder({
      status: "verifying",
      confirmedAt: T0,
      applyTaskId: "task-apply",
    });
    const observing = imageOrder({
      status: "observing",
      confirmedAt: T0,
      applyTaskId: "task-apply",
      observation: {
        until: FUTURE,
        auditId: null,
        baseAuditId: "audit-1",
        verdict: "pending",
        notes: [],
      },
    });
    const finished = {
      name: "xhs_ops_change_order_finished",
      payload: {
        orderId: "order-1",
        status: "observing",
        agentInstruction: "报告结果和观察期截止时间",
      },
    };
    apiMocks.getAccount.mockResolvedValue(
      account({ ...PLAN_CONFIRMED, activeChangeOrderId: "order-1" }),
    );
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });
    apiMocks.listChangeOrders.mockResolvedValue([verifying]);
    apiMocks.getChangeOrder.mockResolvedValue({
      order: observing,
      event: finished,
    });
    const onAction = vi.fn();

    // The agent rendered the same account twice: both cards poll the order.
    const view = render(
      <>
        {takeoverCard({}, onAction)}
        {takeoverCard({}, onAction)}
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByText(/手机正在只读核验本单字段/)).toHaveLength(2),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    const finishedCalls = () =>
      onAction.mock.calls.filter(
        ([name]) => name === "xhs_ops_change_order_finished",
      );
    await waitFor(() => expect(finishedCalls()).toHaveLength(1));
    expect(finishedCalls()[0]?.[1]).toEqual(finished.payload);

    // A remount (the chat re-rendered the surface) sees the same event again.
    view.unmount();
    render(takeoverCard({}, onAction));
    await screen.findByText(/手机正在只读核验本单字段/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(apiMocks.getChangeOrder).toHaveBeenCalled());
    expect(finishedCalls()).toHaveLength(1);
  });

  it("shows why the identity gate kept the pause after 「恢复」", async () => {
    const paused = account({
      ...PLAN_CONFIRMED,
      safetyPause: {
        code: "manual",
        reason: "客户要求先停一下",
        since: T0,
      },
    });
    apiMocks.getAccount.mockResolvedValue(paused);
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });
    apiMocks.resumeTakeover.mockResolvedValue({
      account: paused,
      resumed: false,
      gate: {
        status: "blocked",
        code: "phone_required",
        reason: "手机上的小红书没有登录，请账号本人登录后再恢复",
        taskId: "gate-1",
      },
    });

    render(takeoverCard());

    expect(await screen.findByText(/接管已暂停（手动暂停）/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() =>
      expect(apiMocks.resumeTakeover).toHaveBeenCalledWith("account-1", {
        expectedUpdatedAt: "account-rev-1",
      }),
    );
    expect(
      (await screen.findByTestId("resume-gate-reason")).textContent,
    ).toContain("手机上的小红书没有登录，请账号本人登录后再恢复");
  });

  it("needs a written reason to resume an observation failure", async () => {
    apiMocks.getAccount.mockResolvedValue(
      account({
        ...PLAN_CONFIRMED,
        safetyPause: {
          code: "observation_failed",
          reason: "复查回读与目标值不一致：简介",
          sourceRef: "order-1",
          since: T0,
        },
      }),
    );
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });

    render(takeoverCard());

    const resume = (await screen.findByRole("button", {
      name: "恢复",
    })) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("恢复原因"), {
      target: { value: "已在手机上手动改回" },
    });
    expect(resume.disabled).toBe(false);
  });

  it("waits out the controller's startup recovery instead of failing the card", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMocks.getAccount.mockResolvedValue(account(LOCKED));
    apiMocks.listChangeOrders
      .mockRejectedValueOnce(recoveringError())
      .mockRejectedValueOnce(recoveringError())
      .mockResolvedValue([]);
    apiMocks.pauseTakeover.mockResolvedValue(
      account(
        {
          ...LOCKED,
          safetyPause: {
            code: "manual",
            reason: "客户要求先停一下",
            since: T0,
          },
        },
        { updatedAt: "account-rev-2" },
      ),
    );

    render(takeoverCard());

    // The account is in: the details area says why it waits, and pausing —
    // which the recovery does not hold back (§2.6) — already works.
    const waiting = await screen.findByTestId("takeover-details-recovering");
    expect(waiting.textContent).toContain(
      takeoverModel.TAKEOVER_DETAILS_RECOVERING,
    );
    expect(screen.queryByTestId("takeover-recovering")).toBeNull();
    expect(section("authorize")).toBeNull();
    expect(screen.queryByRole("button", { name: "重新加载" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "暂停接管" }));
    fireEvent.change(screen.getByLabelText("暂停原因"), {
      target: { value: "客户要求先停一下" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认暂停" }));
    expect(await screen.findByTestId("takeover-paused")).toBeTruthy();
    expect(apiMocks.pauseTakeover).toHaveBeenCalledWith(
      "account-1",
      "客户要求先停一下",
    );
    expect(screen.getByTestId("takeover-details-recovering")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(screen.getByTestId("takeover-details-recovering")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(section("identity")).not.toBeNull());
    expect(screen.queryByTestId("takeover-details-recovering")).toBeNull();
    expect(screen.queryByTestId("takeover-recovering")).toBeNull();
    expect(apiMocks.listChangeOrders).toHaveBeenCalledTimes(3);
    // The account was read once; only the lists were retried.
    expect(apiMocks.getAccount).toHaveBeenCalledTimes(1);
  });

  it("drops a list read that went out before a write and came back after it", async () => {
    let answerStale: (orders: unknown[]) => void = () => {};
    const created = imageOrder({
      id: "order-2",
      status: "draft",
      precheck: null,
      proposalIds: [],
      batchIndex: 1,
      risk: "L1",
      fields: [
        { field: "bio", baselineValue: "上班族穿搭记录", after: "通勤穿搭" },
      ],
      updatedAt: "order-rev-2",
    });
    apiMocks.getAccount.mockResolvedValue(account(PLAN_CONFIRMED));
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });
    apiMocks.listChangeOrders
      // The first load.
      .mockResolvedValueOnce([])
      // The re-read after the 409 below: it answers only after the create.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerStale = resolve;
          }),
      )
      .mockResolvedValue([created]);
    apiMocks.createChangeOrder
      .mockRejectedValueOnce(
        Object.assign(new Error("账号已更新，请重新加载后再保存"), {
          status: 409,
        }),
      )
      .mockResolvedValueOnce({
        order: created,
        account: account(PLAN_CONFIRMED, { updatedAt: "account-rev-2" }),
        event: null,
      });

    render(takeoverCard());

    fireEvent.click(
      await screen.findByRole("button", { name: "手动新建变更单" }),
    );
    fireEvent.click(screen.getByLabelText("改简介"));
    fireEvent.change(screen.getByLabelText("新的简介"), {
      target: { value: "通勤穿搭" },
    });
    const create = screen.getByRole("button", { name: "新建草案" });
    fireEvent.click(create);
    expect(
      await screen.findByText("账号已更新，请重新加载后再保存"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(apiMocks.listChangeOrders).toHaveBeenCalledTimes(2),
    );

    fireEvent.click(create);
    const order = () => document.querySelector('[data-change-order="order-2"]');
    await waitFor(() => expect(order()).not.toBeNull());

    // The read sent before the create lands now, without the new order.
    await act(async () => {
      answerStale([]);
    });
    await flush();
    expect(order()).not.toBeNull();
    // It was dropped and the lists read again.
    await waitFor(() =>
      expect(apiMocks.listChangeOrders).toHaveBeenCalledTimes(3),
    );
    await flush();
    expect(order()).not.toBeNull();
  });

  it("re-reads the card after a 409, so the retry sends the current revision", async () => {
    apiMocks.getAccount
      .mockResolvedValueOnce(account(null))
      .mockResolvedValue(account(null, { updatedAt: "account-rev-2" }));
    apiMocks.authorizeTakeover
      .mockRejectedValueOnce(
        Object.assign(new Error("账号已更新，请重新加载后再保存"), {
          status: 409,
        }),
      )
      .mockResolvedValue(
        account({ authorizedAt: T0 }, { updatedAt: "account-rev-3" }),
      );

    render(takeoverCard());

    fireEvent.click(
      await screen.findByLabelText(TAKEOVER_AUTHORIZATION_STATEMENT),
    );
    const authorize = screen.getByRole("button", {
      name: "确认授权，开始接管",
    });
    fireEvent.click(authorize);
    expect(
      await screen.findByText("账号已更新，请重新加载后再保存"),
    ).toBeTruthy();
    await waitFor(() => expect(apiMocks.getAccount).toHaveBeenCalledTimes(2));

    fireEvent.click(authorize);
    await waitFor(() =>
      expect(apiMocks.authorizeTakeover).toHaveBeenLastCalledWith("account-1", {
        expectedUpdatedAt: "account-rev-2",
        ownershipConfirmed: true,
      }),
    );
  });

  it("announces a diagnosis that settled before any poll saw it running", async () => {
    const failed = diagnosis({ status: "failed", error: "模型服务不可用" });
    const diagnosed = {
      name: "xhs_ops_account_diagnosed",
      payload: { diagnosisId: "diag-1", status: "failed" },
    };
    apiMocks.getAccount
      .mockResolvedValueOnce(account(BASELINED))
      .mockResolvedValue(
        account({ ...BASELINED, activeDiagnosisId: "diag-1" }),
      );
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.generateDiagnosis.mockResolvedValue(
      diagnosis({ status: "generating" }),
    );
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: failed,
      event: diagnosed,
    });
    const onAction = vi.fn();

    render(takeoverCard({}, onAction));

    fireEvent.click(
      await screen.findByRole("button", { name: "按意见生成诊断" }),
    );
    expect(
      await screen.findByRole("button", { name: "再生成方案" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith(
        "xhs_ops_account_diagnosed",
        diagnosed.payload,
      ),
    );
    expect(
      onAction.mock.calls.filter(
        ([name]) => name === "xhs_ops_account_diagnosed",
      ),
    ).toHaveLength(1);
  });

  it("flags doc-rule citations when the phone runs another skill bundle, and says so when it is behind", async () => {
    sdkMocks.getDevices.mockResolvedValue({
      data: {
        devices: [
          {
            deviceId: "device-1",
            name: "Phone 1",
            status: "idle",
            lastSeen: Date.now(),
            skillBundleVersion: 65,
            skillSyncStatus: "current",
          },
        ],
      },
    });
    apiMocks.getPlaybook.mockResolvedValue({
      version: "v",
      bundleVersion: 66,
      rules: [
        {
          id: "ID-01",
          topic: "identity",
          text: "只操作当前已登录账号；检测到其他账号不得切换",
          source: "xhs/references/profile.md:17",
          appliesTo: ["existing"],
          confidence: "doc",
          excerpt: "只操作当前已登录账号自己的内容",
          bundleVersion: 66,
          signedOffAt: null,
        },
      ],
    });
    apiMocks.getAccount.mockResolvedValue(
      account({ ...BASELINED, activeDiagnosisId: "diag-1" }),
    );
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis(),
      event: null,
    });

    const view = render(takeoverCard());

    // §4.5's notice, plus the clearer line: it is the phone that is behind.
    const changed = await screen.findByTestId("skill-docs-changed");
    expect(
      within(changed).getByText(TAKEOVER_SKILL_BUNDLE_NOTICE),
    ).toBeTruthy();
    expect(screen.getByTestId("skill-docs-phone-older").textContent).toBe(
      takeoverSkillPhoneOlderNotice(65, 66),
    );
    expect(screen.queryByTestId("skill-docs-unsynced")).toBeNull();

    // A newer phone bundle moved the docs just as well: the notice alone.
    view.unmount();
    cardQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    sdkMocks.getDevices.mockResolvedValue({
      data: {
        devices: [
          {
            deviceId: "device-1",
            name: "Phone 1",
            status: "idle",
            lastSeen: Date.now(),
            skillBundleVersion: 67,
            skillSyncStatus: "current",
          },
        ],
      },
    });
    render(takeoverCard());
    expect((await screen.findByTestId("skill-docs-changed")).textContent).toBe(
      TAKEOVER_SKILL_BUNDLE_NOTICE,
    );
    expect(screen.queryByTestId("skill-docs-phone-older")).toBeNull();
  });

  it("shows only a softer note while the phone's skill sync is not current, and nothing before it reported", async () => {
    const devices = (extra: Record<string, unknown>) => ({
      data: {
        devices: [
          {
            deviceId: "device-1",
            name: "Phone 1",
            status: "idle",
            lastSeen: Date.now(),
            ...extra,
          },
        ],
      },
    });
    sdkMocks.getDevices.mockResolvedValue(
      devices({ skillBundleVersion: 66, skillSyncStatus: "syncing" }),
    );
    apiMocks.getPlaybook.mockResolvedValue({
      version: "v",
      bundleVersion: 66,
      rules: [],
    });
    apiMocks.getAccount.mockResolvedValue(
      account({ ...BASELINED, activeDiagnosisId: "diag-1" }),
    );
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis(),
      event: null,
    });

    const view = render(takeoverCard());

    expect((await screen.findByTestId("skill-docs-unsynced")).textContent).toBe(
      takeoverSkillSyncNotice("syncing"),
    );
    expect(screen.queryByTestId("skill-docs-changed")).toBeNull();

    // Between connect and skill.hello the fields are absent: no hint at all.
    view.unmount();
    cardQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    sdkMocks.getDevices.mockResolvedValue(devices({}));
    render(takeoverCard());
    expect(await screen.findByText("通勤穿搭为主的成熟号")).toBeTruthy();
    await waitFor(() => expect(sdkMocks.getDevices).toHaveBeenCalledTimes(2));
    await flush();
    expect(screen.queryByTestId("skill-docs-unsynced")).toBeNull();
    expect(screen.queryByTestId("skill-docs-changed")).toBeNull();
  });

  it("blocks the card while the phone's policy mode is audit or off, and notes an unreported one", async () => {
    const withMode = (mode?: string) => ({
      data: {
        devices: [
          {
            deviceId: "device-1",
            name: "Phone 1",
            status: "idle",
            lastSeen: Date.now(),
            ...(mode ? { devicePolicyMode: mode } : {}),
          },
        ],
      },
    });
    apiMocks.getAccount.mockResolvedValue(account(LOCKED));

    sdkMocks.getDevices.mockResolvedValue(withMode("audit"));
    const audited = render(takeoverCard());
    const blocked = await screen.findByTestId("device-policy-blocked");
    expect(blocked.textContent).toContain("手机端策略模式是 audit");
    expect(blocked.textContent).toContain("enforce");
    expect(screen.queryByTestId("device-policy-unknown")).toBeNull();
    audited.unmount();

    cardQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    sdkMocks.getDevices.mockResolvedValue(withMode());
    const unknown = render(takeoverCard());
    expect(
      (await screen.findByTestId("device-policy-unknown")).textContent,
    ).toBe(TAKEOVER_POLICY_MODE_UNKNOWN_NOTICE);
    expect(screen.queryByTestId("device-policy-blocked")).toBeNull();
    // Unknown blocks nothing.
    expect(
      (
        screen.getByRole("button", {
          name: "开始只读盘点",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    unknown.unmount();

    cardQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    sdkMocks.getDevices.mockResolvedValue(withMode("enforce"));
    render(takeoverCard());
    expect(
      await screen.findByRole("button", { name: "开始只读盘点" }),
    ).toBeTruthy();
    await waitFor(() => expect(sdkMocks.getDevices).toHaveBeenCalledTimes(3));
    await flush();
    expect(screen.queryByTestId("device-policy-blocked")).toBeNull();
    expect(screen.queryByTestId("device-policy-unknown")).toBeNull();
  });

  it("drafts a manual change order from the value the plan adopted", async () => {
    const adoptedAvatar = diagnosis({
      status: "confirmed",
      proposals: [
        {
          id: "P3",
          kind: "profileField",
          field: "avatar",
          to: "户外自然光半身照",
          rationale: "头像与调性不符",
          ruleIds: ["PF-04"],
          risk: "L2",
          batch: 3,
        },
      ],
      decisions: { P3: { decision: "adopt", decidedAt: T0 } },
    });
    const draft = imageOrder({
      status: "draft",
      precheck: null,
      proposalIds: [],
      fields: [
        { field: "avatar", baselineValue: "", after: "户外自然光半身照" },
      ],
    });
    apiMocks.getAccount.mockResolvedValue(account(PLAN_CONFIRMED));
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: adoptedAvatar,
      event: null,
    });
    apiMocks.createChangeOrder.mockResolvedValue({
      order: draft,
      account: account(PLAN_CONFIRMED),
      event: null,
    });

    render(takeoverCard());

    fireEvent.click(
      await screen.findByRole("button", { name: "手动新建变更单" }),
    );
    fireEvent.change(screen.getByLabelText("批次"), {
      target: { value: "3" },
    });
    const create = screen.getByRole("button", {
      name: "新建草案",
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("改头像"));
    expect(
      (screen.getByLabelText("头像图片方向") as HTMLInputElement).value,
    ).toBe("户外自然光半身照");
    expect(create.disabled).toBe(false);
    fireEvent.click(create);

    await waitFor(() =>
      expect(apiMocks.createChangeOrder).toHaveBeenCalledWith("account-1", {
        fields: [{ field: "avatar", after: "户外自然光半身照" }],
      }),
    );
    expect(
      await waitFor(() => {
        const card = document.querySelector('[data-change-order="order-1"]');
        expect(card).not.toBeNull();
        return card;
      }),
    ).toBeTruthy();
    expect(screen.queryByTestId("manual-change-order")).toBeNull();
  });

  it("shows the 内容支柱 → 兴趣词 mapping once the plan is confirmed", async () => {
    apiMocks.getAccount.mockResolvedValue(
      account({ ...BASELINED, activeDiagnosisId: "diag-1" }),
    );
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis(),
      event: null,
    });
    apiMocks.confirmTakeoverPlan.mockResolvedValue({
      account: account(PLAN_CONFIRMED, {
        updatedAt: "account-rev-2",
        interestPool: {
          core: ["通勤穿搭", "职场穿搭技巧"],
          extended: ["护肤"],
          general: ["咖啡"],
        },
        toneGuide: {
          summary: "轻松的通勤分享",
          pillars: [
            { name: "穿搭", sharePercent: 60 },
            { name: "护肤", sharePercent: 30 },
            { name: "读书", sharePercent: 10 },
          ],
        },
      }),
      diagnosis: diagnosis({ status: "confirmed", updatedAt: "diag-rev-2" }),
      changeOrders: [],
      skippedFields: [],
      event: {
        name: "xhs_ops_takeover_plan_confirmed",
        payload: { accountId: "account-1" },
      },
    });

    render(takeoverCard());

    fireEvent.click(
      await screen.findByRole("button", { name: "确认优化方案" }),
    );
    expect(screen.queryByTestId("pillar-mapping")).toBeNull();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "确认方案",
      }),
    );

    const mapping = await screen.findByTestId("pillar-mapping");
    expect(mapping.textContent).toContain("内容支柱 → 兴趣词");
    expect(mapping.textContent).toContain("穿搭 → 通勤穿搭、职场穿搭技巧");
    expect(mapping.textContent).toContain("护肤 → 护肤");
    expect(mapping.textContent).toContain("读书 → （没有对应的兴趣词）");
    expect(screen.getByTestId("plan-confirmed")).toBeTruthy();
  });

  it("reminds the user to delete the pushed albums once an image order is done", async () => {
    const pushed = (status: string, applied: boolean) =>
      imageOrder({
        status,
        confirmedAt: T0,
        applyTaskId: applied ? "task-apply" : null,
        fields: [
          {
            field: "avatar",
            baselineValue: "",
            after: "户外自然光半身照",
            imagePath: "/state/media/xhs-takeover/order-1/avatar.png",
            imageSha256: "sha-1",
            mediaAlbum: "Tabby-1a2b3c4d-a",
            outcome: applied ? "verified" : "pending",
          },
        ],
      });
    apiMocks.getAccount.mockResolvedValue(account(PLAN_CONFIRMED));
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });
    apiMocks.listChangeOrders.mockResolvedValue([pushed("completed", true)]);

    const view = render(takeoverCard());

    const cleanup = await screen.findByTestId("album-cleanup");
    expect(cleanup.textContent).toContain("不会自动删除");
    expect(cleanup.textContent).toContain("Tabby-1a2b3c4d-a");
    view.unmount();

    // Before it ran there is nothing on the phone to clean up yet.
    cardQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    apiMocks.listChangeOrders.mockResolvedValue([
      pushed("awaiting_confirm", false),
    ]);
    render(takeoverCard());
    await waitFor(() =>
      expect(
        document.querySelector('[data-change-order="order-1"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByTestId("album-cleanup")).toBeNull();
  });

  it("tells the user to swap the picture back by hand after a mismatch, and pauses the takeover", async () => {
    const mismatchText = "图片与原图不一致，请立即在手机上手动换回";
    const checking = imageOrder({
      status: "awaiting_visual_check",
      confirmedAt: T0,
      applyTaskId: "task-apply",
      verificationScreenshotUrl: "/api/internal/media/verify.png",
      fields: [
        {
          field: "avatar",
          baselineValue: "",
          after: "户外自然光半身照",
          imagePath: "/state/media/xhs-takeover/order-1/avatar.png",
          imageSha256: "sha-1",
          mediaAlbum: "Tabby-1a2b3c4d-a",
          outcome: "done",
        },
      ],
    });
    const failed = imageOrder({
      ...checking,
      status: "failed",
      error: mismatchText,
      updatedAt: "order-rev-2",
      fields: [
        {
          ...checking.fields[0],
          outcome: "mismatch",
          visualCheck: { screenshotUrl: null, result: "mismatch", at: T0 },
        },
      ],
    });
    const changing = { ...PLAN_CONFIRMED, activeChangeOrderId: "order-1" };
    apiMocks.getAccount.mockResolvedValue(account(changing));
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });
    apiMocks.listChangeOrders.mockResolvedValue([checking]);
    apiMocks.visualCheckChangeOrder.mockResolvedValue({
      order: failed,
      account: account(
        {
          ...PLAN_CONFIRMED,
          safetyPause: {
            code: "manual",
            reason: mismatchText,
            sourceRef: "order-1",
            since: T0,
          },
        },
        { updatedAt: "account-rev-2" },
      ),
      event: null,
    });

    render(takeoverCard());

    const compare = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(
        '[data-visual-check="avatar"]',
      );
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(compare.textContent).toContain("手动换回");
    fireEvent.click(within(compare).getByRole("button", { name: "不一致" }));
    await waitFor(() =>
      expect(apiMocks.visualCheckChangeOrder).toHaveBeenCalledWith("order-1", {
        field: "avatar",
        result: "mismatch",
        expectedUpdatedAt: "order-rev-1",
      }),
    );

    const order = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(
        '[data-change-order="order-1"]',
      );
      expect(node?.textContent).toContain(mismatchText);
      return node as HTMLElement;
    });
    expect(order.textContent).toContain("与目标不一致");
    expect(document.querySelector('[data-visual-check="avatar"]')).toBeNull();
    expect(
      within(order).getByRole("button", { name: "新建回滚单" }),
    ).toBeTruthy();
    expect(screen.getByTestId("takeover-paused").textContent).toContain(
      `接管已暂停（手动暂停）：${mismatchText}`,
    );
  });

  it("marks design rules nobody signed off yet as 「待确认」 (D8)", async () => {
    apiMocks.getAccount.mockResolvedValue(
      account({ ...BASELINED, activeDiagnosisId: "diag-1" }),
    );
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getPlaybook.mockResolvedValue({
      version: "v",
      bundleVersion: PHONE_SKILLS_BUNDLE,
      rules: [
        {
          id: "PF-06",
          topic: "profile",
          text: "简介保留原有的自我介绍句式",
          source: "design",
          appliesTo: ["existing"],
          confidence: "design",
          signedOffAt: null,
        },
      ],
    });
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({
        findings: [
          {
            id: "F1",
            dimension: "persona_fit",
            severity: "medium",
            summary: "简介没有提到目标人群关心的护肤",
            evidence: ["profile.bio"],
            ruleIds: ["MT-01", "MT-02", "PF-06"],
          },
        ],
        citedRules: [
          {
            id: "MT-01",
            text: "最小改动，不套模板",
            source: "design",
            confidence: "design",
            signedOff: false,
          },
          {
            id: "MT-02",
            text: "公开资料按风险分批修改",
            source: "design",
            confidence: "design",
            signedOff: true,
          },
        ],
      }),
      event: null,
    });

    render(takeoverCard());

    const findings = await screen.findByTestId("diagnosis-findings");
    await waitFor(() => expect(apiMocks.getPlaybook).toHaveBeenCalled());
    const chip = (id: string) => {
      const node = Array.from(
        findings.querySelectorAll<HTMLElement>("[data-rule-category]"),
      ).find((entry) => entry.firstElementChild?.textContent === id);
      expect(node).toBeTruthy();
      return node as HTMLElement;
    };
    // Unsigned per the diagnosis' own snapshot.
    expect(chip("MT-01").dataset.ruleCategory).toBe("design");
    expect(chip("MT-01").textContent).toContain("本方案");
    expect(chip("MT-01").textContent).toContain("待确认");
    // Signed off: 「本方案」 only.
    expect(chip("MT-02").textContent).toContain("本方案");
    expect(chip("MT-02").textContent).not.toContain("待确认");
    // Not in the snapshot: the current playbook says it is unsigned.
    await waitFor(() => expect(chip("PF-06").textContent).toContain("待确认"));
  });

  it("words the device hold and the budget note as the design does", async () => {
    apiMocks.getAccount.mockResolvedValue(
      account({
        ...PLAN_CONFIRMED,
        deviceHold: { taskId: "task-9", sourceRef: "audit-2", since: T0 },
      }),
    );
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });

    render(takeoverCard());

    const hold = await screen.findByTestId("device-hold");
    // §3.1 表二.
    expect(hold.textContent).toContain("请到手机上确认任务已结束");
    expect(hold.textContent).not.toContain("已经结束");
    expect(screen.getByLabelText("我已在手机上确认任务已结束")).toBeTruthy();
    // §5.3 #9, verbatim.
    expect(section("change-orders")?.textContent).toContain(
      "接管前的历史改动桌面不知道，平台实际剩余以手机提示为准",
    );
  });

  it("lets a pending identity read expire after the shared TTL", async () => {
    const readAt = (ageMs: number) =>
      account(
        {
          authorizedAt: T0,
          pendingIdentity: {
            taskId: "task-read",
            deviceId: "device-1",
            readAt: new Date(Date.now() - ageMs).toISOString(),
            screenshotUrl: null,
            readAccountId: "xhs-123",
          },
        },
        { platformAccountId: "" },
      );
    apiMocks.getAccount.mockResolvedValue(
      readAt(XHS_TAKEOVER_IDENTITY_READ_TTL_MS + 60_000),
    );

    const view = render(takeoverCard());

    expect(
      await screen.findByText("读取结果已超过 30 分钟，请重新读取。"),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "确认就是这个号，锁定",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    view.unmount();

    apiMocks.getAccount.mockResolvedValue(
      readAt(XHS_TAKEOVER_IDENTITY_READ_TTL_MS - 5 * 60_000),
    );
    render(takeoverCard());
    const lock = (await screen.findByRole("button", {
      name: "确认就是这个号，锁定",
    })) as HTMLButtonElement;
    expect(lock.disabled).toBe(false);
    expect(
      screen.queryByText("读取结果已超过 30 分钟，请重新读取。"),
    ).toBeNull();
  });

  it("asks for a resume reason exactly for the shared reason codes", async () => {
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });
    apiMocks.listAudits.mockResolvedValue([audit()]);
    for (const code of ["account_restricted", "login_required"] as const) {
      apiMocks.getAccount.mockResolvedValue(
        account({
          ...PLAN_CONFIRMED,
          safetyPause: { code, reason: "暂停原因", since: T0 },
        }),
      );
      const view = render(takeoverCard());
      const resume = (await screen.findByRole("button", {
        name: "恢复",
      })) as HTMLButtonElement;
      expect(resume.disabled).toBe(XHS_TAKEOVER_RESUME_REASON_CODES.has(code));
      view.unmount();
    }
  });

  it("requires 「已人工检查」 for every flag in the shared manual-check list", async () => {
    const flag = "profileDrift" as const;
    expect(XHS_TAKEOVER_MANUAL_CHECK_AUDIT_FLAGS.has(flag)).toBe(true);
    apiMocks.getAccount.mockResolvedValue(
      account({ ...LOCKED, latestAuditId: "audit-1" }),
    );
    apiMocks.listAudits.mockResolvedValue([
      audit({ flags: [flag, "creatorUnavailable"] }),
    ]);

    const view = render(takeoverCard());

    expect(await screen.findByLabelText(/已人工检查/)).toBeTruthy();
    view.unmount();

    // A flag outside the list needs no manual check.
    apiMocks.listAudits.mockResolvedValue([
      audit({ flags: ["creatorUnavailable"] }),
    ]);
    render(takeoverCard());
    const baseline = (await screen.findByRole("button", {
      name: "数据核对无误，设为基线",
    })) as HTMLButtonElement;
    expect(baseline.disabled).toBe(false);
    expect(screen.queryByLabelText(/已人工检查/)).toBeNull();
  });

  it("asks for warnAcknowledged after a warn review, by the shared rule, under the shared status label", async () => {
    const bio = imageOrder({
      id: "order-2",
      batchIndex: 1,
      risk: "L1",
      proposalIds: ["P1"],
      fields: [
        {
          field: "bio",
          baselineValue: "上班族穿搭记录",
          before: "上班族穿搭记录",
          after: "通勤穿搭也聊护肤",
        },
      ],
      createdAt: "2026-10-20T03:00:00.000Z",
    });
    const warned = imageOrder({
      id: "order-1",
      status: "completed",
      batchIndex: 1,
      risk: "L1",
      fields: [
        {
          field: "occupation",
          baselineValue: "产品经理",
          before: "产品经理",
          after: "时尚博主",
          outcome: "verified",
        },
      ],
      confirmedAt: T0,
      applyTaskId: "task-apply",
      precheck: null,
      observation: {
        until: T0,
        auditId: "audit-9",
        baseAuditId: "audit-1",
        verdict: "warn",
        notes: ["关注数小幅变化"],
      },
    });
    apiMocks.getAccount.mockResolvedValue(
      account({ ...PLAN_CONFIRMED, activeChangeOrderId: "order-2" }),
    );
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });
    apiMocks.listChangeOrders.mockResolvedValue([bio, warned]);

    render(takeoverCard());

    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-change-order="order-2"]',
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(card.textContent).toContain("待确认");
    fireEvent.click(within(card).getByRole("button", { name: "确认执行" }));
    const dialog = screen.getByRole("dialog");
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes).toHaveLength(1);
    expect(dialog.textContent).toContain("观察期复查结果是 warn");
  });

  it("shows the adopted fields no order was drafted for from the account, across a remount", async () => {
    const confirmed = account({
      ...PLAN_CONFIRMED,
      skippedFields: [
        {
          proposalId: "P3",
          field: "avatar",
          reason: "手机不在线，头像变更单没有生成",
        },
      ],
    });
    apiMocks.getAccount.mockResolvedValue(confirmed);
    apiMocks.listAudits.mockResolvedValue([audit()]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });

    const view = render(takeoverCard());
    expect(
      (await screen.findByTestId("plan-skipped-fields")).textContent,
    ).toContain("头像：手机不在线，头像变更单没有生成");

    // The chat re-rendered the surface: nothing kept in component state.
    view.unmount();
    render(takeoverCard());
    expect(
      (await screen.findByTestId("plan-skipped-fields")).textContent,
    ).toContain("头像：手机不在线，头像变更单没有生成");
    expect(apiMocks.confirmTakeoverPlan).not.toHaveBeenCalled();
  });

  it("re-reads the account after starting an audit, so the next write sends the new revision", async () => {
    const paused = (rev: string, extra: Record<string, unknown> = {}) =>
      account(
        {
          ...PLAN_CONFIRMED,
          safetyPause: {
            code: "observation_failed",
            reason: "复查回读与目标值不一致：简介",
            sourceRef: "order-1",
            since: T0,
          },
          ...extra,
        },
        { updatedAt: rev },
      );
    apiMocks.getAccount
      .mockResolvedValueOnce(paused("account-rev-1"))
      .mockResolvedValue(paused("account-rev-2", { activeAuditId: "audit-2" }));
    const running = audit({
      id: "audit-2",
      trigger: "manual",
      status: "running",
    });
    apiMocks.listAudits
      .mockResolvedValueOnce([audit()])
      .mockResolvedValue([running, audit()]);
    apiMocks.getAudit.mockResolvedValue(running);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });
    apiMocks.startAudit.mockResolvedValue(running);
    apiMocks.resumeTakeover.mockResolvedValue({
      account: paused("account-rev-3"),
      resumed: false,
      gate: null,
    });

    render(takeoverCard());

    fireEvent.click(await screen.findByRole("button", { name: "重新盘点" }));
    await waitFor(() =>
      expect(apiMocks.startAudit).toHaveBeenCalledWith("account-1", {}),
    );
    await waitFor(() => expect(apiMocks.getAccount).toHaveBeenCalledTimes(2));
    // The running audit holds the phone: no second start.
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "取消盘点" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );

    fireEvent.change(screen.getByLabelText("恢复原因"), {
      target: { value: "已在手机上手动改回" },
    });
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() =>
      expect(apiMocks.resumeTakeover).toHaveBeenCalledWith("account-1", {
        expectedUpdatedAt: "account-rev-2",
        reason: "已在手机上手动改回",
      }),
    );
  });
});

describe("takeover event keys", () => {
  it("separates the baseline event from the earlier audit event", () => {
    const audited = {
      name: "xhs_ops_account_audited" as const,
      payload: { auditId: "audit-1", status: "completed", baseline: false },
    };
    expect(takeoverEventKey(audited)).not.toBe(
      takeoverEventKey({
        ...audited,
        payload: { ...audited.payload, baseline: true },
      }),
    );
    const locked = {
      name: "xhs_ops_takeover_identity_locked" as const,
      payload: { accountId: "account-1" },
    };
    expect(takeoverEventKey(locked, "t1")).not.toBe(
      takeoverEventKey(locked, "t2"),
    );
  });

  it("checks picture type and size like the controller", () => {
    expect(takeoverImageProblem({ type: "image/webp", size: 10 })).toBeNull();
    expect(takeoverImageProblem({ type: "image/heic", size: 10 })).toBe(
      "只支持 png、jpeg 或 webp 图片",
    );
    expect(
      takeoverImageProblem({ type: "image/jpeg", size: 10 * 1024 * 1024 + 1 }),
    ).toBe("图片不能超过 10MB");
  });

  it("never lets an older read replace a newer revision", () => {
    const newer = { id: "a", updatedAt: "2026-10-21T10:00:00.001Z", v: 2 };
    const older = { id: "a", updatedAt: "2026-10-21T10:00:00.000Z", v: 1 };
    expect(olderRevision(older, newer)).toBe(true);
    expect(olderRevision(newer, older)).toBe(false);
    expect(olderRevision(older, { ...newer, id: "b" })).toBe(false);
    expect(olderRevision(older, null)).toBe(false);
    // Unparseable revisions are taken as they come.
    expect(olderRevision({ id: "a", updatedAt: "rev-1" }, newer)).toBe(false);
    const fresh = { id: "c", updatedAt: "2026-10-21T09:00:00.000Z", v: 9 };
    expect(mergeRevisions([newer], [older, fresh])).toEqual([newer, fresh]);
  });

  it("tells the recovery 503 and the structured parameter 409 from other errors", () => {
    expect(isTakeoverRecovering(recoveringError())).toBe(true);
    expect(isTakeoverRecovering(new Error("账号已更新"))).toBe(false);
    const capped = paramConflictError("takeover_override_reason_required", [
      LIKE_OVER_TIER,
    ]);
    expect(takeoverParamConflict(capped)).toEqual({
      code: "takeover_override_reason_required",
      message: capped.message,
      issues: [LIKE_OVER_TIER],
    });
    expect(
      takeoverParamConflict(
        paramConflictError("takeover_param_hard_limit", [
          LIKE_OVER_TIER,
          DWELL_TOO_SHORT,
        ]),
      ),
    ).toMatchObject({
      code: "takeover_param_hard_limit",
      issues: [LIKE_OVER_TIER, DWELL_TOO_SHORT],
    });
    // The old wording alone no longer counts: only the code does.
    expect(
      takeoverParamConflict(
        Object.assign(new Error("超出接管档位的调整需要填写理由"), {
          status: 409,
          body: { message: "超出接管档位的调整需要填写理由" },
        }),
      ),
    ).toBeNull();
    expect(
      takeoverParamConflict(
        Object.assign(new Error("账号已更新，请重新加载后再保存"), {
          status: 409,
        }),
      ),
    ).toBeNull();
    expect(
      takeoverParamConflict(
        Object.assign(new Error("x"), {
          status: 400,
          body: { message: "x", code: "takeover_param_hard_limit" },
        }),
      ),
    ).toBeNull();
  });

  it("compares the phone's skill bundle with the playbook's, and its sync status", () => {
    expect(takeoverSkillDocsState({ skillBundleVersion: 65 }, 66)).toEqual({
      kind: "bundle_mismatch",
      phoneBundle: 65,
      playbookBundle: 66,
    });
    expect(
      takeoverSkillDocsState(
        { skillBundleVersion: 66, skillSyncStatus: "current" },
        66,
      ),
    ).toBeNull();
    // §4.5: any other bundle moves the doc rules' citations, a newer one too.
    expect(takeoverSkillDocsState({ skillBundleVersion: 67 }, 66)).toEqual({
      kind: "bundle_mismatch",
      phoneBundle: 67,
      playbookBundle: 66,
    });
    // A bundle mismatch wins over a sync status that is not current either.
    expect(
      takeoverSkillDocsState(
        { skillBundleVersion: 65, skillSyncStatus: "error" },
        66,
      ),
    ).toMatchObject({ kind: "bundle_mismatch" });
    expect(
      takeoverSkillDocsState(
        { skillBundleVersion: 66, skillSyncStatus: "incompatible" },
        66,
      ),
    ).toEqual({ kind: "unsynced", status: "incompatible" });
    // Absent fields — briefly, between connect and skill.hello — say nothing.
    expect(takeoverSkillDocsState({}, 66)).toBeNull();
    expect(takeoverSkillDocsState(null)).toBeNull();
    // Before the playbook loads, PHONE_SKILLS_BUNDLE is the reference.
    expect(
      takeoverSkillDocsState({ skillBundleVersion: PHONE_SKILLS_BUNDLE - 1 }),
    ).toEqual({
      kind: "bundle_mismatch",
      phoneBundle: PHONE_SKILLS_BUNDLE - 1,
      playbookBundle: PHONE_SKILLS_BUNDLE,
    });
    expect(
      takeoverSkillDocsState({ skillBundleVersion: PHONE_SKILLS_BUNDLE }),
    ).toBeNull();
  });

  it("reads the phone's policy mode: audit and off block, an unreported one is unknown", () => {
    expect(takeoverPolicyModeState({ devicePolicyMode: "off" })).toMatchObject({
      kind: "blocked",
    });
    expect(
      takeoverPolicyModeState({ devicePolicyMode: "audit" }),
    ).toMatchObject({ kind: "blocked" });
    expect(takeoverPolicyModeState({ devicePolicyMode: "enforce" })).toBeNull();
    expect(takeoverPolicyModeState({})).toEqual({ kind: "unknown" });
    // A phone that is not connected says nothing about its mode.
    expect(takeoverPolicyModeState(null)).toBeNull();
  });

  it("takes the takeover rules from @nexu/shared instead of keeping copies", () => {
    for (const name of [
      "IDENTITY_READ_TTL_MS",
      "RESUME_REASON_CODES",
      "MANUAL_CHECK_AUDIT_FLAGS",
      "previousReviewWarned",
      "CHANGE_ORDER_STATUS_LABEL",
      "fieldLabels",
      "takeoverOverrideReasonRequired",
    ])
      expect(takeoverModel).not.toHaveProperty(name);
    // The card still words its own outcome and code labels.
    expect(takeoverModel.FIELD_OUTCOME_LABEL.verified).toBe("已核验");
    expect(takeoverModel.FIELD_CODE_LABEL.platform_limit).toBe(
      "平台修改次数限制",
    );
  });
});

describe("takeover rows in the other xhs-ops cards", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sessionStorage.clear();
    apiMocks.getProject.mockResolvedValue({
      ...confirmedProject,
      personaCount: 10,
      profile: {
        summary: "上海职场女性",
        base: { ageRange: "25-32", genderRatio: "女", regions: ["上海"] },
        verticalInterests: ["护肤"],
        generalInterests: ["穿搭"],
        confirmedAt: T0,
      },
    });
    apiMocks.listDeviceBindings.mockResolvedValue([]);
    apiMocks.listAudits.mockResolvedValue([]);
    apiMocks.listChangeOrders.mockResolvedValue([]);
    apiMocks.getPlaybook.mockResolvedValue({ version: "v", rules: [] });
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

  afterEach(() => {
    cleanup();
  });

  const newRow = () =>
    xhsOpsAccountSchema.parse({
      id: "account-new",
      projectId: "project-1",
      entryMode: "new",
      label: "新号",
      positioning: "通勤护肤",
      persona: {
        age: "28岁",
        gender: "女",
        region: "上海",
        occupation: "产品经理",
        lifeStatus: "独居",
      },
      personaTags: { vertical: ["护肤"], general: ["穿搭", "咖啡"] },
      interestPool: {
        core: ["护肤"],
        extended: ["穿搭"],
        general: ["咖啡"],
      },
      deviceId: "device-2",
      deviceName: "Phone 2",
      createdAt: T0,
      updatedAt: "new-rev-1",
    });

  it("splits a mixed selection: takeover rows never reach persona confirmation", async () => {
    apiMocks.listAccounts.mockResolvedValue([account(null), newRow()]);
    apiMocks.confirmPersonas.mockResolvedValue([
      { ...newRow(), personaReviewedAt: T0 },
    ]);
    const onAction = vi.fn();

    render(
      withQuery(
        <XhsOpsAccountPlanner
          {...props(
            { type: "XhsOpsAccountPlanner", projectId: "project-1" },
            onAction,
          )}
        />,
      ),
    );

    fireEvent.click(await screen.findByLabelText("选择人设 接管·Phone 1"));
    fireEvent.click(screen.getByLabelText("选择人设 新号"));
    fireEvent.click(
      screen.getByLabelText("我已核对选定人设的差异及整体分布符合目标画像"),
    );
    fireEvent.change(screen.getByLabelText("人设分布复核说明"), {
      target: { value: "新号分布符合目标" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认人设并进入接管" }));

    await waitFor(() =>
      expect(apiMocks.confirmPersonas).toHaveBeenCalledWith("project-1", {
        accounts: [
          { accountId: "account-new", expectedUpdatedAt: "new-rev-1" },
        ],
        expectedUpdatedAt: T0,
        distributionReviewed: true,
        reviewNote: "新号分布符合目标",
      }),
    );
    expect(onAction).toHaveBeenCalledWith(
      "xhs_ops_existing_accounts_selected",
      expect.objectContaining({
        accountIds: ["account-1"],
        agentInstruction: expect.stringContaining("XhsOpsTakeover"),
      }),
    );
  });

  it("locks the mode of an authorized takeover row and names new takeover rows after the phone", async () => {
    apiMocks.listAccounts.mockResolvedValue([account({ authorizedAt: T0 })]);

    render(
      withQuery(
        <XhsOpsAccountPlanner
          {...props({ type: "XhsOpsAccountPlanner", projectId: "project-1" })}
        />,
      ),
    );

    const [locked] = (await screen.findAllByLabelText(
      "账号模式",
    )) as HTMLSelectElement[];
    expect(locked?.disabled).toBe(true);
    expect(locked?.selectedOptions[0]?.textContent).toBe("接管已有账号");

    fireEvent.click(screen.getByRole("button", { name: "新增账号" }));
    const modes = screen.getAllByLabelText("账号模式") as HTMLSelectElement[];
    const added = modes[1] as HTMLSelectElement;
    expect(added.disabled).toBe(false);
    fireEvent.change(added, { target: { value: "existing" } });
    await waitFor(() =>
      expect(document.querySelector('option[value="device-2"]')).not.toBeNull(),
    );
    const devices = screen.getAllByLabelText("执行设备");
    fireEvent.change(devices[1] as HTMLElement, {
      target: { value: "device-2" },
    });
    expect(screen.getByDisplayValue("接管·Phone 2")).toBeTruthy();
    // Both rows are takeover rows now: content direction is optional on each.
    expect(screen.getAllByText("内容方向与风格（选填）")).toHaveLength(2);
  });

  it("redirects an existing account away from the new-account material", async () => {
    apiMocks.listAccounts.mockResolvedValue([account(null)]);
    const onAction = vi.fn();

    render(
      <XhsOpsProfileMaterial
        {...props(
          { type: "XhsOpsProfileMaterial", projectId: "project-1" },
          onAction,
        )}
      />,
    );

    expect(await screen.findByTestId("takeover-redirect")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "一键生成完整资料" }),
    ).toBeNull();
    expect(screen.queryByLabelText("目标小红书号")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开接管卡片" }));
    expect(onAction).toHaveBeenCalledWith(
      "xhs_ops_existing_accounts_selected",
      expect.objectContaining({ accountIds: ["account-1"] }),
    );
  });

  it("gates a takeover account with today's no-nurture date and a running audit, and embeds its card", async () => {
    const changedToday = account({
      ...PLAN_CONFIRMED,
      noNurtureDates: [localDate()],
      activeAuditId: "audit-2",
    });
    apiMocks.listAccounts.mockResolvedValue([changedToday]);
    apiMocks.getAccount.mockResolvedValue(changedToday);
    apiMocks.listAudits.mockResolvedValue([
      audit({ id: "audit-2", trigger: "manual", status: "running" }),
    ]);
    apiMocks.getDiagnosis.mockResolvedValue({
      diagnosis: diagnosis({ status: "confirmed" }),
      event: null,
    });

    render(
      withQuery(
        <XhsOpsRunPlanner
          {...props({
            type: "XhsOpsRunPlanner",
            projectId: "project-1",
            plans: [
              {
                accountId: "account-1",
                keywords: [{ keyword: "护肤", count: 1 }],
                homeFeedCount: 1,
              },
            ],
          })}
        />,
      ),
    );

    expect(
      (await screen.findAllByText(/今天改过公开资料，按规则当天不养号/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/只读盘点进行中/).length).toBeGreaterThan(0);
    expect(await screen.findByTestId("run-planner-takeover")).toBeTruthy();
    expect(
      document.querySelector('[data-takeover-account="account-1"]'),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "开始执行" })).toBeNull();
  });

  it("embeds a gated takeover card in a planner without plans, without remounting it in a loop", async () => {
    // Real requests take time: the planner shows a skeleton while it
    // re-suggests plans, which unmounted the card, whose reload reported the
    // account back, which re-suggested plans — forever.
    const authorized = account({ authorizedAt: T0 });
    apiMocks.listAccounts.mockImplementation(() => later([authorized]));
    apiMocks.getAccount.mockImplementation(() => later(authorized));
    apiMocks.suggestPlans.mockImplementation(() =>
      later({ plans: [], skipped: [] }),
    );

    render(
      withQuery(
        <XhsOpsRunPlanner
          {...props({ type: "XhsOpsRunPlanner", projectId: "project-1" })}
        />,
      ),
    );

    expect(
      await screen.findByRole("button", { name: "读取手机当前账号" }),
    ).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(apiMocks.getAccount).toHaveBeenCalledTimes(1);
    expect(apiMocks.suggestPlans).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("run-planner-takeover")).toBeTruthy();
  });

  it("lists the accounts the desktop could not plan today", async () => {
    apiMocks.listAccounts.mockResolvedValue([]);
    apiMocks.suggestPlans.mockResolvedValue({
      plans: [],
      skipped: [
        {
          accountId: "account-1",
          accountLabel: "接管·Phone 1",
          reason: "本段搜索目标 36 篇至少需要 5 个兴趣词，当前只有 2 个",
        },
      ],
    });

    render(
      withQuery(
        <XhsOpsRunPlanner
          {...props({ type: "XhsOpsRunPlanner", projectId: "project-1" })}
        />,
      ),
    );

    const skipped = await screen.findByTestId("plan-skipped");
    expect(skipped.textContent).toContain("接管·Phone 1");
    expect(skipped.textContent).toContain("至少需要 5 个兴趣词");
  });

  it("asks for a reason when a takeover row goes past the tier caps, then resends with it", async () => {
    const takeoverRow = account(PLAN_CONFIRMED);
    apiMocks.listAccounts.mockResolvedValue([takeoverRow]);
    apiMocks.updateAccount
      .mockRejectedValueOnce(
        paramConflictError("takeover_override_reason_required", [
          LIKE_OVER_TIER,
        ]),
      )
      .mockResolvedValueOnce({ ...takeoverRow, updatedAt: "account-rev-2" });
    const onAction = vi.fn();

    render(
      withQuery(
        <XhsOpsAccountPlanner
          {...props(
            { type: "XhsOpsAccountPlanner", projectId: "project-1" },
            onAction,
          )}
        />,
      ),
    );

    await screen.findByDisplayValue("接管·Phone 1");
    const save = screen.getByRole("button", { name: "保存账号配置" });
    fireEvent.click(save);
    const prompt = await screen.findByTestId("override-reason");
    expect(prompt.textContent).toContain(LIKE_OVER_TIER.message);
    expect(prompt.textContent).toContain("填好后点「保存账号配置」");
    expect(screen.queryByTestId("param-hard-limit")).toBeNull();
    expect(apiMocks.updateAccount.mock.calls[0]?.[1]).not.toHaveProperty(
      "overrideReason",
    );
    expect(onAction).not.toHaveBeenCalled();

    // No reason, no request.
    fireEvent.click(save);
    expect(
      await screen.findByText("请填写超出接管档位的理由，再保存"),
    ).toBeTruthy();
    expect(apiMocks.updateAccount).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("超出接管档位的理由"), {
      target: { value: "客户要求加量" },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(apiMocks.updateAccount).toHaveBeenCalledTimes(2),
    );
    expect(apiMocks.updateAccount.mock.calls[1]?.[1]).toMatchObject({
      overrideReason: "客户要求加量",
      expectedUpdatedAt: "account-rev-1",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("override-reason")).toBeNull(),
    );
    expect(onAction).toHaveBeenCalledWith(
      "xhs_ops_accounts_saved",
      expect.objectContaining({ existingAccountIds: ["account-1"] }),
    );
  });

  it("holds a takeover account on its activeAuditId without listing audits", async () => {
    apiMocks.listAccounts.mockResolvedValue([
      account({ ...PLAN_CONFIRMED, activeAuditId: "audit-2" }),
    ]);
    // The embedded card never gets its account, so every audit read would be
    // the planner's own.
    apiMocks.getAccount.mockReturnValue(new Promise(() => {}));

    render(
      withQuery(
        <XhsOpsRunPlanner
          {...props({
            type: "XhsOpsRunPlanner",
            projectId: "project-1",
            plans: [
              {
                accountId: "account-1",
                keywords: [{ keyword: "护肤", count: 1 }],
                homeFeedCount: 1,
              },
            ],
          })}
        />,
      ),
    );

    expect(
      (await screen.findAllByText(/只读盘点进行中/)).length,
    ).toBeGreaterThan(0);
    await flush();
    expect(apiMocks.listAudits).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "开始执行" })).toBeNull();
  });

  it("shows a hard limit without an override, and holds the save until the values change", async () => {
    const takeoverRow = account(PLAN_CONFIRMED);
    apiMocks.listAccounts.mockResolvedValue([takeoverRow]);
    apiMocks.updateAccount
      .mockRejectedValueOnce(
        paramConflictError("takeover_param_hard_limit", [
          LIKE_OVER_TIER,
          DWELL_TOO_SHORT,
        ]),
      )
      .mockResolvedValueOnce({ ...takeoverRow, updatedAt: "account-rev-2" });

    render(
      withQuery(
        <XhsOpsAccountPlanner
          {...props({ type: "XhsOpsAccountPlanner", projectId: "project-1" })}
        />,
      ),
    );

    await screen.findByDisplayValue("接管·Phone 1");
    const save = screen.getByRole("button", { name: "保存账号配置" });
    fireEvent.click(save);
    const block = await screen.findByTestId("param-hard-limit");
    expect(block.textContent).toContain(`${DWELL_TOO_SHORT.message}（硬上限）`);
    expect(block.textContent).toContain(
      `${LIKE_OVER_TIER.message}（超出档位，可填理由）`,
    );
    expect(screen.queryByLabelText("超出接管档位的理由")).toBeNull();
    expect(screen.queryByTestId("override-reason")).toBeNull();

    // The same values would be refused again: nothing goes out.
    fireEvent.click(save);
    expect(
      await screen.findByText("请先把超出硬上限的参数调回范围内，再保存"),
    ).toBeTruthy();
    expect(apiMocks.updateAccount).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("最长停留（秒）"), {
      target: { value: "30" },
    });
    expect(screen.queryByTestId("param-hard-limit")).toBeNull();
    fireEvent.click(save);
    await waitFor(() =>
      expect(apiMocks.updateAccount).toHaveBeenCalledTimes(2),
    );
    expect(apiMocks.updateAccount.mock.calls[1]?.[1]).not.toHaveProperty(
      "overrideReason",
    );
  });

  it("lifts an interest-pool hard limit once the pool changes, and saves again", async () => {
    const takeoverRow = account(PLAN_CONFIRMED);
    const WORDS_TOO_FEW = {
      field: "interestPool",
      message: "本段搜索目标 12 篇至少需要 2 个兴趣词，当前只有 0 个",
      overridable: false,
    };
    apiMocks.listAccounts.mockResolvedValue([takeoverRow]);
    apiMocks.updateAccount
      .mockRejectedValueOnce(
        paramConflictError("takeover_param_hard_limit", [WORDS_TOO_FEW]),
      )
      .mockResolvedValueOnce({ ...takeoverRow, updatedAt: "account-rev-2" });

    render(
      withQuery(
        <XhsOpsAccountPlanner
          {...props({ type: "XhsOpsAccountPlanner", projectId: "project-1" })}
        />,
      ),
    );

    await screen.findByDisplayValue("接管·Phone 1");
    const save = screen.getByRole("button", { name: "保存账号配置" });
    fireEvent.click(save);
    expect(
      (await screen.findByTestId("param-hard-limit")).textContent,
    ).toContain(`${WORDS_TOO_FEW.message}（硬上限）`);
    fireEvent.click(save);
    expect(
      await screen.findByText("请先把超出硬上限的参数调回范围内，再保存"),
    ).toBeTruthy();
    expect(apiMocks.updateAccount).toHaveBeenCalledTimes(1);

    // Adding the words it asked for is the change that lifts it.
    const core = screen.getByLabelText("核心（core）");
    fireEvent.change(core, { target: { value: "通勤穿搭、职场穿搭" } });
    fireEvent.keyDown(core, { key: "Enter" });
    expect(screen.queryByTestId("param-hard-limit")).toBeNull();
    fireEvent.click(save);
    await waitFor(() =>
      expect(apiMocks.updateAccount).toHaveBeenCalledTimes(2),
    );
    expect(apiMocks.updateAccount.mock.calls[1]?.[1]).toMatchObject({
      interestPool: expect.objectContaining({
        core: ["通勤穿搭", "职场穿搭"],
      }),
    });
    expect(apiMocks.updateAccount.mock.calls[1]?.[1]).not.toHaveProperty(
      "overrideReason",
    );
  });

  it("announces a mixed selection's takeover rows once, only after the persona confirmation went through", async () => {
    apiMocks.listAccounts.mockResolvedValue([account(null), newRow()]);
    apiMocks.confirmPersonas
      .mockRejectedValueOnce(new Error("项目画像已更新，请重新确认"))
      .mockResolvedValue([{ ...newRow(), personaReviewedAt: T0 }]);
    const onAction = vi.fn();

    render(
      withQuery(
        <XhsOpsAccountPlanner
          {...props(
            { type: "XhsOpsAccountPlanner", projectId: "project-1" },
            onAction,
          )}
        />,
      ),
    );

    const submit = async () => {
      fireEvent.click(await screen.findByLabelText("选择人设 接管·Phone 1"));
      fireEvent.click(screen.getByLabelText("选择人设 新号"));
      fireEvent.click(
        screen.getByLabelText("我已核对选定人设的差异及整体分布符合目标画像"),
      );
      fireEvent.change(screen.getByLabelText("人设分布复核说明"), {
        target: { value: "新号分布符合目标" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "确认人设并进入接管" }),
      );
    };
    const selected = () =>
      onAction.mock.calls.filter(
        ([name]) => name === "xhs_ops_existing_accounts_selected",
      );

    await submit();
    expect(await screen.findByText("项目画像已更新，请重新确认")).toBeTruthy();
    expect(selected()).toHaveLength(0);
    // The failure reloads the rows, which clears the selection.
    await waitFor(() => expect(apiMocks.listAccounts).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("选择人设 接管·Phone 1") as HTMLInputElement)
          .checked,
      ).toBe(false),
    );

    await submit();
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith(
        "xhs_ops_personas_confirmed",
        expect.objectContaining({ accountIds: ["account-new"] }),
      ),
    );
    expect(selected()).toHaveLength(1);
    expect(selected()[0]?.[1]).toMatchObject({ accountIds: ["account-1"] });

    // The same selection again: the persona confirmation runs, the takeover
    // rows are not announced a second time.
    fireEvent.click(screen.getByRole("button", { name: "确认人设并进入接管" }));
    await waitFor(() =>
      expect(apiMocks.confirmPersonas).toHaveBeenCalledTimes(3),
    );
    await flush();
    expect(selected()).toHaveLength(1);
  });

  it("confirms a selection of new rows alone as before, without a takeover event", async () => {
    apiMocks.listAccounts.mockResolvedValue([account(null), newRow()]);
    apiMocks.confirmPersonas.mockResolvedValue([
      { ...newRow(), personaReviewedAt: T0 },
    ]);
    const onAction = vi.fn();

    render(
      withQuery(
        <XhsOpsAccountPlanner
          {...props(
            { type: "XhsOpsAccountPlanner", projectId: "project-1" },
            onAction,
          )}
        />,
      ),
    );

    fireEvent.click(await screen.findByLabelText("选择人设 新号"));
    fireEvent.click(
      screen.getByLabelText("我已核对选定人设的差异及整体分布符合目标画像"),
    );
    fireEvent.change(screen.getByLabelText("人设分布复核说明"), {
      target: { value: "新号分布符合目标" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "确认选定人设，进入素材" }),
    );

    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith(
        "xhs_ops_personas_confirmed",
        expect.objectContaining({
          accountIds: ["account-new"],
          agentInstruction: expect.stringContaining("XhsOpsProfileMaterial"),
        }),
      ),
    );
    expect(apiMocks.confirmPersonas).toHaveBeenCalledWith("project-1", {
      accounts: [{ accountId: "account-new", expectedUpdatedAt: "new-rev-1" }],
      expectedUpdatedAt: T0,
      distributionReviewed: true,
      reviewNote: "新号分布符合目标",
    });
    expect(onAction.mock.calls.map(([name]) => name)).not.toContain(
      "xhs_ops_existing_accounts_selected",
    );
  });

  it("keeps the new-account material flow for a new account", async () => {
    const ready = xhsOpsAccountSchema.parse({
      ...newRow(),
      personaReviewedAt: T0,
      platformAccountId: "xhs-new",
      profileDraft: {
        nickname: "通勤护肤日记",
        bio: "天秤座 INFJ｜上海产品经理｜通勤护肤和咖啡",
        occupation: "产品经理",
        gender: "女",
        birthday: "1996-10-01",
        region: "上海",
        interestTags: ["护肤", "穿搭", "咖啡"],
        avatarCandidates: ["/avatar-ready.png"],
        coverCandidates: ["/cover-ready.png"],
        avatarPath: "/avatar-ready.png",
        coverPath: "/cover-ready.png",
        reviewedAt: T0,
      },
    });
    apiMocks.listAccounts.mockResolvedValue([ready]);
    apiMocks.updateAccount.mockResolvedValue(ready);
    apiMocks.applyProfileDraft.mockResolvedValue(ready);

    render(
      <XhsOpsProfileMaterial
        {...props({ type: "XhsOpsProfileMaterial", projectId: "project-1" })}
      />,
    );

    const apply = await screen.findByRole("button", {
      name: "安装登录、应用并核验",
    });
    expect(screen.queryByTestId("takeover-redirect")).toBeNull();
    expect(screen.getByText("新建账号 ·")).toBeTruthy();
    expect(
      screen.getByText("生成后仍需人工核对；确认应用后才会修改手机公开资料。"),
    ).toBeTruthy();
    expect(screen.queryByText(/已有账号/)).toBeNull();
    fireEvent.click(apply);
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    // Without a readback the whole draft goes, as before: no field list.
    await waitFor(() =>
      expect(apiMocks.applyProfileDraft).toHaveBeenCalledWith(
        "account-new",
        undefined,
      ),
    );
  });

  it("embeds the new-account material, not a takeover card, for a new account the planner holds", async () => {
    apiMocks.listAccounts.mockResolvedValue([
      { ...newRow(), personaReviewedAt: T0 },
    ]);

    render(
      withQuery(
        <XhsOpsRunPlanner
          {...props({
            type: "XhsOpsRunPlanner",
            projectId: "project-1",
            plans: [
              {
                accountId: "account-new",
                keywords: [{ keyword: "护肤", count: 1 }],
                homeFeedCount: 1,
              },
            ],
          })}
        />,
      ),
    );

    expect(
      await screen.findByRole("button", { name: "一键生成完整资料" }),
    ).toBeTruthy();
    expect(
      screen.getAllByText(/手机账号配置及资料生效核验/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByTestId("run-planner-takeover")).toBeNull();
    expect(screen.queryByTestId("takeover-redirect")).toBeNull();
    expect(document.querySelector("[data-takeover-account]")).toBeNull();
    expect(screen.queryByRole("button", { name: "开始执行" })).toBeNull();
    expect(apiMocks.getAccount).not.toHaveBeenCalled();
  });

  it("asks for a reason when a device transfer puts a takeover target past the tier caps, then resends it with the transfer", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const takeoverRow = account(PLAN_CONFIRMED);
    apiMocks.listAccounts.mockResolvedValue([takeoverRow]);
    apiMocks.listDeviceBindings.mockResolvedValue([
      {
        deviceId: "device-1",
        accountId: "account-old",
        accountLabel: "旧号",
        projectId: "project-2",
        projectName: "旧项目",
        canTransfer: true,
        blockingReason: null,
      },
    ]);
    apiMocks.transferDevice
      .mockRejectedValueOnce(
        paramConflictError("takeover_override_reason_required", [
          LIKE_OVER_TIER,
        ]),
      )
      .mockResolvedValueOnce({ ...takeoverRow, updatedAt: "account-rev-2" });

    render(
      withQuery(
        <XhsOpsAccountPlanner
          {...props({ type: "XhsOpsAccountPlanner", projectId: "project-1" })}
        />,
      ),
    );

    const transfer = await screen.findByRole("button", {
      name: "转移设备并保存此账号",
    });
    fireEvent.click(transfer);
    const prompt = await screen.findByTestId("override-reason");
    expect(prompt.textContent).toContain(LIKE_OVER_TIER.message);
    expect(prompt.textContent).toContain("填好后点「转移设备并保存此账号」");
    expect(apiMocks.transferDevice.mock.calls[0]?.[1]).not.toHaveProperty(
      "overrideReason",
    );

    // No reason, no request.
    fireEvent.click(
      screen.getByRole("button", { name: "转移设备并保存此账号" }),
    );
    expect(
      await screen.findByText("请填写超出接管档位的理由，再转移"),
    ).toBeTruthy();
    expect(apiMocks.transferDevice).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("超出接管档位的理由"), {
      target: { value: "客户要求加量" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "转移设备并保存此账号" }),
    );
    await waitFor(() =>
      expect(apiMocks.transferDevice).toHaveBeenCalledTimes(2),
    );
    expect(apiMocks.transferDevice.mock.calls[1]).toEqual([
      "project-1",
      expect.objectContaining({
        fromAccountId: "account-old",
        toAccountId: "account-1",
        overrideReason: "客户要求加量",
      }),
    ]);
    await waitFor(() =>
      expect(screen.queryByTestId("override-reason")).toBeNull(),
    );
    confirm.mockRestore();
  });

  describe("comment review of a takeover account", () => {
    const approved = {
      id: "comment-1",
      projectId: "project-1",
      accountId: "account-1",
      sourceRunId: "run-browse",
      sourceChunkIndex: 0,
      sourcePostIndex: 0,
      post: { title: "通勤穿搭合集", author: "小林" },
      candidates: ["好看"],
      text: "好看",
      status: "approved",
      createdAt: T0,
      updatedAt: T0,
    };
    const quota = {
      accountId: "account-1",
      accountLabel: "接管·Phone 1",
      date: localDate(),
      enabled: true,
      dailyCap: 3,
      todayBrowsed: 24,
      byBrowse: 3,
      cap: 3,
      sentToday: 0,
      approvedPending: 1,
      remaining: 2,
    };
    const commentRun = (overrides: Record<string, unknown>) =>
      xhsOpsRunSchema.parse({
        id: "run-comment",
        projectId: "project-1",
        accountId: "account-1",
        deviceId: "device-1",
        accountLabel: "接管·Phone 1",
        date: localDate(),
        status: "running",
        plan: {
          kind: "comment",
          keywords: [],
          homeFeedCount: 0,
          dwellSecMin: 11,
          dwellSecMax: 20,
          interaction: {},
          comments: [],
        },
        createdAt: T0,
        updatedAt: T0,
        ...overrides,
      });
    const reviewCard = () => (
      <XhsOpsCommentReview
        {...props({ type: "XhsOpsCommentReview", projectId: "project-1" })}
      />
    );

    let confirm: MockInstance<typeof window.confirm>;
    beforeEach(() => {
      confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      apiMocks.listComments.mockResolvedValue({
        drafts: [approved],
        quotas: [quota],
      });
    });
    afterEach(() => {
      confirm.mockRestore();
      vi.useRealTimers();
    });

    it("shows the controller's 409 when a paused takeover account's comments are dispatched", async () => {
      apiMocks.listAccounts.mockResolvedValue([
        account({
          ...PLAN_CONFIRMED,
          safetyPause: {
            code: "manual",
            reason: "客户要求先停一下",
            since: T0,
          },
        }),
      ]);
      apiMocks.createCommentRun.mockRejectedValue(
        Object.assign(new Error("账号暂停中：客户要求先停一下"), {
          status: 409,
        }),
      );

      render(reviewCard());

      fireEvent.click(
        await screen.findByRole("button", { name: "派发已批准的评论（1）" }),
      );
      expect(
        await screen.findByText("账号暂停中：客户要求先停一下"),
      ).toBeTruthy();
      expect(screen.queryByText("派发失败")).toBeNull();
    });

    it("follows a dispatched run and shows why its identity gate failed it", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      apiMocks.listAccounts.mockResolvedValue([account(PLAN_CONFIRMED)]);
      const started = commentRun({
        status: "running",
        preparation: {
          status: "running",
          reasonCode: null,
          reason: null,
          taskId: "gate-1",
          startedAt: T0,
          completedAt: null,
        },
      });
      const failed = commentRun({
        status: "failed",
        error: "手机上登录的不是这个小红书号，账号已暂停",
        preparation: {
          status: "blocked",
          reasonCode: "account_mismatch",
          reason: "手机上登录的不是这个小红书号，账号已暂停",
          taskId: "gate-1",
          startedAt: T0,
          completedAt: T0,
        },
      });
      apiMocks.createCommentRun.mockResolvedValue(started);
      apiMocks.getRun.mockResolvedValue(failed);
      // Before the dispatch, right after it, and once the run settled.
      apiMocks.listRuns
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([started])
        .mockResolvedValue([failed]);

      render(reviewCard());

      fireEvent.click(
        await screen.findByRole("button", { name: "派发已批准的评论（1）" }),
      );
      expect(
        (await screen.findByTestId("comment-run-active")).textContent,
      ).toContain("只读核对手机上登录的账号");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100);
      });
      expect(
        (await screen.findByTestId("comment-run-failed")).textContent,
      ).toBe(
        "评论任务没有发出：启动前的身份检查没有通过，手机上登录的不是这个小红书号，账号已暂停",
      );
      expect(apiMocks.getRun).toHaveBeenCalledWith("run-comment");
    });

    it("shows today's failed gate from the run list after a remount", async () => {
      apiMocks.listAccounts.mockResolvedValue([account(PLAN_CONFIRMED)]);
      apiMocks.listRuns.mockResolvedValue([
        commentRun({
          status: "failed",
          error: "启动检查失败",
          preparation: {
            status: "failed",
            reasonCode: "phone_required",
            reason: "手机上的小红书没有登录，请账号本人登录后再恢复",
            taskId: "gate-1",
            startedAt: T0,
            completedAt: T0,
          },
        }),
      ]);

      render(reviewCard());

      expect(
        (await screen.findByTestId("comment-run-failed")).textContent,
      ).toContain("手机上的小红书没有登录，请账号本人登录后再恢复");
      expect(apiMocks.getRun).not.toHaveBeenCalled();
    });

    it("leaves a new account's comment runs as they were", async () => {
      apiMocks.listAccounts.mockResolvedValue([
        account(null, { entryMode: "new" }),
      ]);
      apiMocks.listRuns.mockResolvedValue([
        commentRun({ status: "failed", error: "部分任务块执行失败" }),
      ]);

      render(reviewCard());

      expect(
        await screen.findByRole("button", { name: "派发已批准的评论（1）" }),
      ).toBeTruthy();
      await flush();
      expect(screen.queryByTestId("comment-run-failed")).toBeNull();
    });
  });

  it("warns about look-alike personas among new rows only", async () => {
    const persona = {
      age: "28岁",
      gender: "女",
      region: "上海",
      occupation: "产品经理",
      lifeStatus: "独居",
    };
    apiMocks.listAccounts.mockResolvedValue([
      newRow(),
      { ...newRow(), id: "account-new-2", label: "新号二", deviceId: null },
      account(PLAN_CONFIRMED, { persona }),
      account(PLAN_CONFIRMED, {
        id: "account-2",
        label: "接管·Phone 3",
        persona,
        deviceId: null,
      }),
    ]);

    render(
      withQuery(
        <XhsOpsAccountPlanner
          {...props({ type: "XhsOpsAccountPlanner", projectId: "project-1" })}
        />,
      ),
    );

    await screen.findByDisplayValue("接管·Phone 3");
    const warnings = screen
      .getAllByTestId("persona-overlap")
      .map((entry) => entry.textContent ?? "");
    // The two new rows warn about each other; the takeover rows, whose
    // persona comes from their diagnosis, neither warn nor are named.
    expect(warnings).toHaveLength(2);
    expect(warnings.join("")).not.toContain("接管·");
  });
});
