/** Typed wrappers over the generated xhs-ops SDK contract. */
import {
  type XhsOpsAccountAudit,
  type XhsOpsAccountDiagnosis,
  type XhsOpsAccountTransferInput,
  type XhsOpsChangeOrder,
  type XhsOpsChangeOrderActionResponse,
  type XhsOpsChangeOrderResponse,
  type XhsOpsDeviceBinding,
  type XhsOpsPlanSkip,
  type XhsOpsPlaybookRule,
  type XhsOpsTakeoverEvent,
  type XhsOpsTakeoverPlanResponse,
  type XhsOpsTakeoverResumeResponse,
  xhsOpsAccountIdentityResponseSchema,
  xhsOpsAccountListResponseSchema,
  xhsOpsAccountResponseSchema,
  xhsOpsAuditBaselineResponseSchema,
  xhsOpsAuditListResponseSchema,
  xhsOpsAuditResponseSchema,
  xhsOpsChangeOrderActionResponseSchema,
  xhsOpsChangeOrderListResponseSchema,
  xhsOpsChangeOrderResponseSchema,
  xhsOpsCommentGenerateResponseSchema,
  xhsOpsCommentListResponseSchema,
  xhsOpsCommentResponseSchema,
  xhsOpsDeviceBindingListResponseSchema,
  xhsOpsDiagnosisResponseSchema,
  xhsOpsDiagnosisViewResponseSchema,
  type xhsOpsPersonaGenerateBodySchema,
  xhsOpsPersonaGenerateResponseSchema,
  type xhsOpsPersonasConfirmBodySchema,
  xhsOpsPlanSuggestResponseSchema,
  xhsOpsPlaybookResponseSchema,
  type xhsOpsProfileConfirmBodySchema,
  xhsOpsProfileReadbackResponseSchema,
  xhsOpsProjectListResponseSchema,
  xhsOpsProjectResponseSchema,
  xhsOpsRunListResponseSchema,
  xhsOpsRunResponseSchema,
  xhsOpsTakeoverIdentityConfirmResponseSchema,
  xhsOpsTakeoverIdentityReadResponseSchema,
  xhsOpsTakeoverPlanResponseSchema,
  xhsOpsTakeoverPlanRevertResponseSchema,
  xhsOpsTakeoverResumeResponseSchema,
} from "@nexu/shared";
import type { z } from "zod";
import {
  deleteApiV1XhsOpsAccountsByAccountId,
  deleteApiV1XhsOpsProjectsByProjectId,
  getApiV1XhsOpsAccountsByAccountId,
  getApiV1XhsOpsAccountsByAccountIdAudits,
  getApiV1XhsOpsAccountsByAccountIdChangeOrders,
  getApiV1XhsOpsAuditsByAuditId,
  getApiV1XhsOpsChangeOrdersByOrderId,
  getApiV1XhsOpsDeviceBindings,
  getApiV1XhsOpsDiagnosesByDiagnosisId,
  getApiV1XhsOpsPlaybook,
  getApiV1XhsOpsProjects,
  getApiV1XhsOpsProjectsByProjectId,
  getApiV1XhsOpsProjectsByProjectIdAccounts,
  getApiV1XhsOpsProjectsByProjectIdComments,
  getApiV1XhsOpsProjectsByProjectIdPlanSuggest,
  getApiV1XhsOpsRuns,
  getApiV1XhsOpsRunsByRunId,
  patchApiV1XhsOpsAccountsByAccountId,
  patchApiV1XhsOpsProjectsByProjectId,
  patchApiV1XhsOpsRunsByRunId,
  postApiV1XhsOpsAccountsByAccountIdAudits,
  postApiV1XhsOpsAccountsByAccountIdChangeOrders,
  postApiV1XhsOpsAccountsByAccountIdDiagnoses,
  postApiV1XhsOpsAccountsByAccountIdIdentityRead,
  postApiV1XhsOpsAccountsByAccountIdProfileDraftApply,
  postApiV1XhsOpsAccountsByAccountIdProfileDraftConfirm,
  postApiV1XhsOpsAccountsByAccountIdProfileDraftGenerate,
  postApiV1XhsOpsAccountsByAccountIdProfileDraftReadback,
  postApiV1XhsOpsAccountsByAccountIdProfileDraftReconcile,
  postApiV1XhsOpsAccountsByAccountIdTakeoverAuthorize,
  postApiV1XhsOpsAccountsByAccountIdTakeoverDeviceHoldRelease,
  postApiV1XhsOpsAccountsByAccountIdTakeoverIdentityConfirm,
  postApiV1XhsOpsAccountsByAccountIdTakeoverIdentityRead,
  postApiV1XhsOpsAccountsByAccountIdTakeoverPause,
  postApiV1XhsOpsAccountsByAccountIdTakeoverPlanRevert,
  postApiV1XhsOpsAccountsByAccountIdTakeoverResume,
  postApiV1XhsOpsAuditsByAuditIdBaseline,
  postApiV1XhsOpsAuditsByAuditIdCancel,
  postApiV1XhsOpsChangeOrdersByOrderIdCancel,
  postApiV1XhsOpsChangeOrdersByOrderIdConfirm,
  postApiV1XhsOpsChangeOrdersByOrderIdManualCheck,
  postApiV1XhsOpsChangeOrdersByOrderIdObservationReview,
  postApiV1XhsOpsChangeOrdersByOrderIdPrecheck,
  postApiV1XhsOpsChangeOrdersByOrderIdVerify,
  postApiV1XhsOpsChangeOrdersByOrderIdVisualCheck,
  postApiV1XhsOpsCommentsByCommentIdReview,
  postApiV1XhsOpsDiagnosesByDiagnosisIdConfirm,
  postApiV1XhsOpsDiagnosesByDiagnosisIdDecisions,
  postApiV1XhsOpsDiagnosesByDiagnosisIdRegenerate,
  postApiV1XhsOpsProjects,
  postApiV1XhsOpsProjectsByProjectIdAccounts,
  postApiV1XhsOpsProjectsByProjectIdAccountsTransferDevice,
  postApiV1XhsOpsProjectsByProjectIdCommentRuns,
  postApiV1XhsOpsProjectsByProjectIdPersonasConfirm,
  postApiV1XhsOpsProjectsByProjectIdPersonasGenerate,
  postApiV1XhsOpsProjectsByProjectIdProfileConfirm,
  postApiV1XhsOpsProjectsByProjectIdProfileGenerate,
  postApiV1XhsOpsRuns,
  postApiV1XhsOpsRunsByRunIdCancel,
  postApiV1XhsOpsRunsByRunIdCommentsGenerate,
  postApiV1XhsOpsRunsByRunIdStart,
  putApiV1XhsOpsChangeOrdersByOrderIdFieldsByFieldImage,
} from "../../../../../lib/api/sdk.gen";
import type {
  PatchApiV1XhsOpsAccountsByAccountIdData,
  PostApiV1XhsOpsAccountsByAccountIdAuditsData,
  PostApiV1XhsOpsAccountsByAccountIdChangeOrdersData,
  PostApiV1XhsOpsAccountsByAccountIdDiagnosesData,
  PostApiV1XhsOpsAccountsByAccountIdTakeoverAuthorizeData,
  PostApiV1XhsOpsAccountsByAccountIdTakeoverDeviceHoldReleaseData,
  PostApiV1XhsOpsAccountsByAccountIdTakeoverIdentityConfirmData,
  PostApiV1XhsOpsAccountsByAccountIdTakeoverPlanRevertData,
  PostApiV1XhsOpsAccountsByAccountIdTakeoverResumeData,
  PostApiV1XhsOpsAuditsByAuditIdBaselineData,
  PostApiV1XhsOpsChangeOrdersByOrderIdConfirmData,
  PostApiV1XhsOpsChangeOrdersByOrderIdVisualCheckData,
  PostApiV1XhsOpsDiagnosesByDiagnosisIdConfirmData,
  PostApiV1XhsOpsDiagnosesByDiagnosisIdDecisionsData,
  PostApiV1XhsOpsDiagnosesByDiagnosisIdRegenerateData,
  PostApiV1XhsOpsProjectsByProjectIdAccountsData,
  PostApiV1XhsOpsProjectsByProjectIdAccountsTransferDeviceData,
  PutApiV1XhsOpsChangeOrdersByOrderIdFieldsByFieldImageData,
} from "../../../../../lib/api/types.gen";
import type {
  XhsOpsAccount,
  XhsOpsAccountCreateInput,
  XhsOpsAccountIdentity,
  XhsOpsAccountUpdateInput,
  XhsOpsCommentDraft,
  XhsOpsCommentQuota,
  XhsOpsCommentStatus,
  XhsOpsPlanSuggestion,
  XhsOpsProfileField,
  XhsOpsProfilePart,
  XhsOpsProfileReadback,
  XhsOpsProject,
  XhsOpsProjectCreateInput,
  XhsOpsProjectUpdateInput,
  XhsOpsRun,
  XhsOpsRunCreateInput,
  XhsOpsRunListFilter,
} from "./xhs-ops-types";

export class XhsOpsApiError extends Error {
  /** HTTP status when the server answered; null when the request never landed. */
  readonly status: number | null;
  /**
   * The error body as the server sent it (undefined when none), for answers
   * that carry more than a message — e.g. the `code` and `issues` of a
   * takeover parameter 409 (xhsOpsAccountConflictResponseSchema).
   */
  readonly body: unknown;

  constructor(message: string, status: number | null, body?: unknown) {
    super(message);
    this.name = "XhsOpsApiError";
    this.status = status;
    this.body = body;
  }
}

/** Accepts `{ error: { code, message } }`, `{ error: "…" }`, `{ message }`, or a string. */
function extractErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const nested = record.error;
    if (typeof nested === "string" && nested.trim()) return nested;
    if (nested && typeof nested === "object") {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
  }
  return fallback;
}

interface ApiResult<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

interface ApiSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

async function unwrap<T>(
  call: () => Promise<ApiResult<unknown>>,
  fallback: string,
  schema: ApiSchema<T>,
): Promise<T> {
  let result: ApiResult<unknown>;
  try {
    result = await call();
  } catch (err) {
    // fetch itself rejected — controller down, network gone, CORS.
    const detail =
      err instanceof Error && err.message ? `：${err.message}` : "";
    throw new XhsOpsApiError(`无法连接桌面端服务${detail}`, null);
  }
  if (result.error !== undefined || result.data === undefined) {
    const status = result.response?.status ?? null;
    const message =
      status === 404 && result.error === undefined
        ? "接口不存在（桌面端尚未更新到支持小红书运营的版本）"
        : extractErrorMessage(result.error, fallback);
    throw new XhsOpsApiError(message, status, result.error);
  }
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) {
    throw new XhsOpsApiError(
      `桌面端返回了不兼容的数据格式：${fallback}`,
      result.response?.status ?? null,
    );
  }
  return parsed.data;
}

/** Same as unwrap but tolerates an empty success body (DELETE). */
async function unwrapVoid(
  call: () => Promise<ApiResult<unknown>>,
  fallback: string,
): Promise<void> {
  let result: ApiResult<unknown>;
  try {
    result = await call();
  } catch (err) {
    const detail =
      err instanceof Error && err.message ? `：${err.message}` : "";
    throw new XhsOpsApiError(`无法连接桌面端服务${detail}`, null);
  }
  if (result.error !== undefined) {
    throw new XhsOpsApiError(
      extractErrorMessage(result.error, fallback),
      result.response?.status ?? null,
    );
  }
}

export const xhsOpsApi = {
  async confirmProfile(
    projectId: string,
    body: z.input<typeof xhsOpsProfileConfirmBodySchema>,
  ): Promise<XhsOpsProject> {
    const result = await unwrap(
      () =>
        postApiV1XhsOpsProjectsByProjectIdProfileConfirm({
          path: { projectId },
          body,
        }),
      "画像确认失败",
      xhsOpsProjectResponseSchema,
    );
    return result.project;
  },

  async generateProfile(
    projectId: string,
    body: { expectedUpdatedAt: string },
  ): Promise<XhsOpsProject> {
    const result = await unwrap(
      () =>
        postApiV1XhsOpsProjectsByProjectIdProfileGenerate({
          path: { projectId },
          body,
        }),
      "画像生成失败",
      xhsOpsProjectResponseSchema,
    );
    return result.project;
  },

  async generatePersonas(
    projectId: string,
    body: z.input<typeof xhsOpsPersonaGenerateBodySchema>,
  ) {
    return unwrap(
      () =>
        postApiV1XhsOpsProjectsByProjectIdPersonasGenerate({
          path: { projectId },
          body,
        }),
      "人设生成失败",
      xhsOpsPersonaGenerateResponseSchema,
    );
  },

  async confirmPersonas(
    projectId: string,
    body: z.input<typeof xhsOpsPersonasConfirmBodySchema>,
  ): Promise<XhsOpsAccount[]> {
    const result = await unwrap(
      () =>
        postApiV1XhsOpsProjectsByProjectIdPersonasConfirm({
          path: { projectId },
          body,
        }),
      "人设确认失败",
      xhsOpsAccountListResponseSchema,
    );
    return result.accounts;
  },
  // ── Projects ──
  async listProjects(): Promise<XhsOpsProject[]> {
    const data = await unwrap(
      () => getApiV1XhsOpsProjects(),
      "项目列表加载失败",
      xhsOpsProjectListResponseSchema,
    );
    return data.projects ?? [];
  },

  async getProject(projectId: string): Promise<XhsOpsProject> {
    const data = await unwrap(
      () => getApiV1XhsOpsProjectsByProjectId({ path: { projectId } }),
      "项目加载失败",
      xhsOpsProjectResponseSchema,
    );
    return data.project;
  },

  async createProject(input: XhsOpsProjectCreateInput): Promise<XhsOpsProject> {
    const data = await unwrap(
      () => postApiV1XhsOpsProjects({ body: input }),
      "项目创建失败",
      xhsOpsProjectResponseSchema,
    );
    return data.project;
  },

  async updateProject(
    projectId: string,
    patch: XhsOpsProjectUpdateInput,
  ): Promise<XhsOpsProject> {
    const data = await unwrap(
      () =>
        patchApiV1XhsOpsProjectsByProjectId({
          path: { projectId },
          body: patch,
        }),
      "项目保存失败",
      xhsOpsProjectResponseSchema,
    );
    return data.project;
  },

  async deleteProject(projectId: string): Promise<void> {
    await unwrapVoid(
      () => deleteApiV1XhsOpsProjectsByProjectId({ path: { projectId } }),
      "项目删除失败",
    );
  },

  // ── Accounts ──
  async listDeviceBindings(): Promise<XhsOpsDeviceBinding[]> {
    const data = await unwrap(
      () => getApiV1XhsOpsDeviceBindings(),
      "设备绑定信息加载失败",
      xhsOpsDeviceBindingListResponseSchema,
    );
    return data.bindings;
  },

  async transferDevice(
    projectId: string,
    input: XhsOpsAccountTransferInput,
  ): Promise<XhsOpsAccount> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsProjectsByProjectIdAccountsTransferDevice({
          path: { projectId },
          body: input as PostApiV1XhsOpsProjectsByProjectIdAccountsTransferDeviceData["body"],
        }),
      "设备转移失败",
      xhsOpsAccountResponseSchema,
    );
    return data.account;
  },

  async listAccounts(projectId: string): Promise<XhsOpsAccount[]> {
    const data = await unwrap(
      () => getApiV1XhsOpsProjectsByProjectIdAccounts({ path: { projectId } }),
      "账号列表加载失败",
      xhsOpsAccountListResponseSchema,
    );
    return data.accounts ?? [];
  },

  async createAccount(
    projectId: string,
    input: XhsOpsAccountCreateInput,
  ): Promise<XhsOpsAccount> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsProjectsByProjectIdAccounts({
          path: { projectId },
          body: input as PostApiV1XhsOpsProjectsByProjectIdAccountsData["body"],
        }),
      "账号创建失败",
      xhsOpsAccountResponseSchema,
    );
    return data.account;
  },

  async getAccount(accountId: string): Promise<XhsOpsAccount> {
    const data = await unwrap(
      () => getApiV1XhsOpsAccountsByAccountId({ path: { accountId } }),
      "账号加载失败",
      xhsOpsAccountResponseSchema,
    );
    return data.account;
  },

  async readAccountIdentity(accountId: string): Promise<XhsOpsAccountIdentity> {
    return unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdIdentityRead({ path: { accountId } }),
      "读取手机当前账号失败",
      xhsOpsAccountIdentityResponseSchema,
    );
  },

  async readbackProfile(accountId: string): Promise<XhsOpsProfileReadback> {
    return unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdProfileDraftReadback({
          path: { accountId },
        }),
      "回读手机资料失败",
      xhsOpsProfileReadbackResponseSchema,
    );
  },

  async reconcileProfileDraft(accountId: string): Promise<XhsOpsAccount> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdProfileDraftReconcile({
          path: { accountId },
        }),
      "资料应用状态刷新失败",
      xhsOpsAccountResponseSchema,
    );
    return data.account;
  },

  async updateAccount(
    accountId: string,
    patch: XhsOpsAccountUpdateInput,
  ): Promise<XhsOpsAccount> {
    const data = await unwrap(
      () =>
        patchApiV1XhsOpsAccountsByAccountId({
          path: { accountId },
          body: patch as PatchApiV1XhsOpsAccountsByAccountIdData["body"],
        }),
      "账号保存失败",
      xhsOpsAccountResponseSchema,
    );
    return data.account;
  },

  async deleteAccount(accountId: string): Promise<void> {
    await unwrapVoid(
      () => deleteApiV1XhsOpsAccountsByAccountId({ path: { accountId } }),
      "账号删除失败",
    );
  },

  // ── Profile draft (P2-1) ──
  async generateProfileDraft(
    accountId: string,
    parts: XhsOpsProfilePart[],
    hints: { avatarPrompt?: string; coverPrompt?: string } = {},
  ): Promise<XhsOpsAccount> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdProfileDraftGenerate({
          path: { accountId },
          body: { parts, ...hints },
        }),
      "资料生成失败",
      xhsOpsAccountResponseSchema,
    );
    return data.account;
  },

  async applyProfileDraft(
    accountId: string,
    fields?: XhsOpsProfileField[],
  ): Promise<XhsOpsAccount> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdProfileDraftApply({
          path: { accountId },
          body: fields ? { fields } : {},
        }),
      "资料应用到手机失败",
      xhsOpsAccountResponseSchema,
    );
    return data.account;
  },

  async confirmProfileDraft(
    accountId: string,
    expectedUpdatedAt?: string,
  ): Promise<XhsOpsAccount> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdProfileDraftConfirm({
          path: { accountId },
          query: { expectedUpdatedAt },
        }),
      "资料校验确认失败",
      xhsOpsAccountResponseSchema,
    );
    return data.account;
  },

  // ── Comment review queue (P3-1 D1) ──
  async listComments(
    projectId: string,
    filter: { status?: XhsOpsCommentStatus; accountId?: string } = {},
  ): Promise<{ drafts: XhsOpsCommentDraft[]; quotas: XhsOpsCommentQuota[] }> {
    return unwrap(
      () =>
        getApiV1XhsOpsProjectsByProjectIdComments({
          path: { projectId },
          query: filter,
        }),
      "评论队列加载失败",
      xhsOpsCommentListResponseSchema,
    );
  },

  async generateComments(
    runId: string,
    posts?: Array<{ chunkIndex: number; postIndex: number }>,
  ): Promise<{ drafts: XhsOpsCommentDraft[]; skipped: string[] }> {
    return unwrap(
      () =>
        postApiV1XhsOpsRunsByRunIdCommentsGenerate({
          path: { runId },
          body: posts ? { posts } : {},
        }),
      "评论候选生成失败",
      xhsOpsCommentGenerateResponseSchema,
    );
  },

  async reviewComment(
    commentId: string,
    body: { decision: "approved" | "rejected"; text?: string; note?: string },
  ): Promise<XhsOpsCommentDraft> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsCommentsByCommentIdReview({
          path: { commentId },
          body,
        }),
      "评论审核失败",
      xhsOpsCommentResponseSchema,
    );
    return data.draft;
  },

  /** P3-1 D2：把账号已批准的评论打成评论 run 并启动（同一手机排队串行）。 */
  async createCommentRun(
    projectId: string,
    accountId: string,
    draftIds?: string[],
  ): Promise<XhsOpsRun> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsProjectsByProjectIdCommentRuns({
          path: { projectId },
          body: draftIds ? { accountId, draftIds } : { accountId },
        }),
      "评论任务派发失败",
      xhsOpsRunResponseSchema,
    );
    return data.run;
  },

  // ── Plan suggestion ──
  /** `skipped`: accounts whose plan could not be built today, with the reason (one account no longer fails the project). */
  async suggestPlans(projectId: string): Promise<{
    plans: XhsOpsPlanSuggestion[];
    skipped: XhsOpsPlanSkip[];
  }> {
    const data = await unwrap(
      () =>
        getApiV1XhsOpsProjectsByProjectIdPlanSuggest({ path: { projectId } }),
      "今日计划建议加载失败",
      xhsOpsPlanSuggestResponseSchema,
    );
    return { plans: data.plans ?? [], skipped: data.skipped ?? [] };
  },

  // ── Runs ──
  async listRuns(filter: XhsOpsRunListFilter = {}): Promise<XhsOpsRun[]> {
    const data = await unwrap(
      () => getApiV1XhsOpsRuns({ query: filter }),
      "运行记录加载失败",
      xhsOpsRunListResponseSchema,
    );
    return data.runs ?? [];
  },

  async createRun(input: XhsOpsRunCreateInput): Promise<XhsOpsRun> {
    const data = await unwrap(
      () => postApiV1XhsOpsRuns({ body: input }),
      "运行计划创建失败",
      xhsOpsRunResponseSchema,
    );
    return data.run;
  },

  async getRun(runId: string): Promise<XhsOpsRun> {
    const data = await unwrap(
      () => getApiV1XhsOpsRunsByRunId({ path: { runId } }),
      "运行状态读取失败",
      xhsOpsRunResponseSchema,
    );
    return data.run;
  },

  async updateRunNotes(runId: string, notes: string): Promise<XhsOpsRun> {
    const data = await unwrap(
      () =>
        patchApiV1XhsOpsRunsByRunId({
          path: { runId },
          body: { notes },
        }),
      "运营观察保存失败",
      xhsOpsRunResponseSchema,
    );
    return data.run;
  },

  async startRun(runId: string): Promise<XhsOpsRun> {
    const data = await unwrap(
      () => postApiV1XhsOpsRunsByRunIdStart({ path: { runId } }),
      "启动执行失败",
      xhsOpsRunResponseSchema,
    );
    return data.run;
  },

  async cancelRun(runId: string): Promise<XhsOpsRun> {
    const data = await unwrap(
      () => postApiV1XhsOpsRunsByRunIdCancel({ path: { runId } }),
      "取消执行失败",
      xhsOpsRunResponseSchema,
    );
    return data.run;
  },

  // ── Takeover of an existing account (老号接管) ──
  async authorizeTakeover(
    accountId: string,
    body: BodyOf<PostApiV1XhsOpsAccountsByAccountIdTakeoverAuthorizeData>,
  ): Promise<XhsOpsAccount> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdTakeoverAuthorize({
          path: { accountId },
          body,
        }),
      "授权接管失败",
      xhsOpsAccountResponseSchema,
    );
    return data.account;
  },

  async readTakeoverIdentity(
    accountId: string,
  ): Promise<{ identity: XhsOpsAccountIdentity; account: XhsOpsAccount }> {
    return unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdTakeoverIdentityRead({
          path: { accountId },
        }),
      "读取手机当前账号失败",
      xhsOpsTakeoverIdentityReadResponseSchema,
    );
  },

  async confirmTakeoverIdentity(
    accountId: string,
    body: BodyOf<PostApiV1XhsOpsAccountsByAccountIdTakeoverIdentityConfirmData>,
  ): Promise<{ account: XhsOpsAccount; event: XhsOpsTakeoverEvent }> {
    return unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdTakeoverIdentityConfirm({
          path: { accountId },
          body,
        }),
      "锁定小红书号失败",
      xhsOpsTakeoverIdentityConfirmResponseSchema,
    );
  },

  async revertTakeoverPlan(
    accountId: string,
    body: BodyOf<PostApiV1XhsOpsAccountsByAccountIdTakeoverPlanRevertData>,
  ): Promise<{
    account: XhsOpsAccount;
    diagnosis: XhsOpsAccountDiagnosis | null;
    changeOrders: XhsOpsChangeOrder[];
  }> {
    return unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdTakeoverPlanRevert({
          path: { accountId },
          body,
        }),
      "撤销方案失败",
      xhsOpsTakeoverPlanRevertResponseSchema,
    );
  },

  async pauseTakeover(
    accountId: string,
    reason: string,
  ): Promise<XhsOpsAccount> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdTakeoverPause({
          path: { accountId },
          body: { reason },
        }),
      "暂停接管失败",
      xhsOpsAccountResponseSchema,
    );
    return data.account;
  },

  async resumeTakeover(
    accountId: string,
    body: BodyOf<PostApiV1XhsOpsAccountsByAccountIdTakeoverResumeData>,
  ): Promise<XhsOpsTakeoverResumeResponse> {
    return unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdTakeoverResume({
          path: { accountId },
          body,
        }),
      "恢复接管失败",
      xhsOpsTakeoverResumeResponseSchema,
    );
  },

  async releaseTakeoverDeviceHold(
    accountId: string,
    body: BodyOf<PostApiV1XhsOpsAccountsByAccountIdTakeoverDeviceHoldReleaseData>,
  ): Promise<XhsOpsAccount> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdTakeoverDeviceHoldRelease({
          path: { accountId },
          body,
        }),
      "解除手机任务占用失败",
      xhsOpsAccountResponseSchema,
    );
    return data.account;
  },

  /** `bundleVersion`: the phone-skills bundle the doc rules were checked against (PHONE_SKILLS_BUNDLE, §4.5). */
  async getPlaybook(): Promise<{
    version: string;
    bundleVersion: number;
    rules: XhsOpsPlaybookRule[];
  }> {
    return unwrap(
      () => getApiV1XhsOpsPlaybook(),
      "经验库加载失败",
      xhsOpsPlaybookResponseSchema,
    );
  },

  async listAudits(accountId: string): Promise<XhsOpsAccountAudit[]> {
    const data = await unwrap(
      () => getApiV1XhsOpsAccountsByAccountIdAudits({ path: { accountId } }),
      "盘点记录加载失败",
      xhsOpsAuditListResponseSchema,
    );
    return data.audits;
  },

  async startAudit(
    accountId: string,
    body: BodyOf<PostApiV1XhsOpsAccountsByAccountIdAuditsData> = {},
  ): Promise<XhsOpsAccountAudit> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdAudits({
          path: { accountId },
          body,
        }),
      "开始只读盘点失败",
      xhsOpsAuditResponseSchema,
    );
    return data.audit;
  },

  async getAudit(auditId: string): Promise<XhsOpsAccountAudit> {
    const data = await unwrap(
      () => getApiV1XhsOpsAuditsByAuditId({ path: { auditId } }),
      "盘点进度读取失败",
      xhsOpsAuditResponseSchema,
    );
    return data.audit;
  },

  async cancelAudit(auditId: string): Promise<XhsOpsAccountAudit> {
    const data = await unwrap(
      () => postApiV1XhsOpsAuditsByAuditIdCancel({ path: { auditId } }),
      "取消盘点失败",
      xhsOpsAuditResponseSchema,
    );
    return data.audit;
  },

  async confirmBaseline(
    auditId: string,
    body: BodyOf<PostApiV1XhsOpsAuditsByAuditIdBaselineData>,
  ): Promise<{
    account: XhsOpsAccount;
    audit: XhsOpsAccountAudit;
    event: XhsOpsTakeoverEvent;
  }> {
    return unwrap(
      () => postApiV1XhsOpsAuditsByAuditIdBaseline({ path: { auditId }, body }),
      "设为基线失败",
      xhsOpsAuditBaselineResponseSchema,
    );
  },

  async generateDiagnosis(
    accountId: string,
    body: BodyOf<PostApiV1XhsOpsAccountsByAccountIdDiagnosesData>,
  ): Promise<XhsOpsAccountDiagnosis> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdDiagnoses({
          path: { accountId },
          body,
        }),
      "生成诊断失败",
      xhsOpsDiagnosisResponseSchema,
    );
    return data.diagnosis;
  },

  async getDiagnosis(diagnosisId: string): Promise<{
    diagnosis: XhsOpsAccountDiagnosis;
    event: XhsOpsTakeoverEvent | null;
  }> {
    return unwrap(
      () => getApiV1XhsOpsDiagnosesByDiagnosisId({ path: { diagnosisId } }),
      "诊断加载失败",
      xhsOpsDiagnosisViewResponseSchema,
    );
  },

  async regenerateDiagnosis(
    diagnosisId: string,
    body: BodyOf<PostApiV1XhsOpsDiagnosesByDiagnosisIdRegenerateData>,
  ): Promise<XhsOpsAccountDiagnosis> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsDiagnosesByDiagnosisIdRegenerate({
          path: { diagnosisId },
          body,
        }),
      "重新生成诊断失败",
      xhsOpsDiagnosisResponseSchema,
    );
    return data.diagnosis;
  },

  async decideDiagnosis(
    diagnosisId: string,
    body: BodyOf<PostApiV1XhsOpsDiagnosesByDiagnosisIdDecisionsData>,
  ): Promise<XhsOpsAccountDiagnosis> {
    const data = await unwrap(
      () =>
        postApiV1XhsOpsDiagnosesByDiagnosisIdDecisions({
          path: { diagnosisId },
          body,
        }),
      "保存采纳决定失败",
      xhsOpsDiagnosisResponseSchema,
    );
    return data.diagnosis;
  },

  async confirmTakeoverPlan(
    diagnosisId: string,
    body: BodyOf<PostApiV1XhsOpsDiagnosesByDiagnosisIdConfirmData>,
  ): Promise<XhsOpsTakeoverPlanResponse> {
    return unwrap(
      () =>
        postApiV1XhsOpsDiagnosesByDiagnosisIdConfirm({
          path: { diagnosisId },
          body,
        }),
      "确认接管方案失败",
      xhsOpsTakeoverPlanResponseSchema,
    );
  },

  async listChangeOrders(accountId: string): Promise<XhsOpsChangeOrder[]> {
    const data = await unwrap(
      () =>
        getApiV1XhsOpsAccountsByAccountIdChangeOrders({ path: { accountId } }),
      "变更单加载失败",
      xhsOpsChangeOrderListResponseSchema,
    );
    return data.orders;
  },

  async createChangeOrder(
    accountId: string,
    body: BodyOf<PostApiV1XhsOpsAccountsByAccountIdChangeOrdersData>,
  ): Promise<XhsOpsChangeOrderActionResponse> {
    return unwrap(
      () =>
        postApiV1XhsOpsAccountsByAccountIdChangeOrders({
          path: { accountId },
          body,
        }),
      "新建变更单失败",
      xhsOpsChangeOrderActionResponseSchema,
    );
  },

  async getChangeOrder(orderId: string): Promise<XhsOpsChangeOrderResponse> {
    return unwrap(
      () => getApiV1XhsOpsChangeOrdersByOrderId({ path: { orderId } }),
      "变更单读取失败",
      xhsOpsChangeOrderResponseSchema,
    );
  },

  async precheckChangeOrder(
    orderId: string,
    body: { expectedUpdatedAt: string },
  ): Promise<XhsOpsChangeOrderActionResponse> {
    return unwrap(
      () =>
        postApiV1XhsOpsChangeOrdersByOrderIdPrecheck({
          path: { orderId },
          body,
        }),
      "预检失败",
      xhsOpsChangeOrderActionResponseSchema,
    );
  },

  async confirmChangeOrder(
    orderId: string,
    body: BodyOf<PostApiV1XhsOpsChangeOrdersByOrderIdConfirmData>,
  ): Promise<XhsOpsChangeOrderActionResponse> {
    return unwrap(
      () =>
        postApiV1XhsOpsChangeOrdersByOrderIdConfirm({
          path: { orderId },
          body,
        }),
      "确认执行失败",
      xhsOpsChangeOrderActionResponseSchema,
    );
  },

  async cancelChangeOrder(
    orderId: string,
    body: { expectedUpdatedAt: string },
  ): Promise<XhsOpsChangeOrderActionResponse> {
    return unwrap(
      () =>
        postApiV1XhsOpsChangeOrdersByOrderIdCancel({ path: { orderId }, body }),
      "取消变更单失败",
      xhsOpsChangeOrderActionResponseSchema,
    );
  },

  async verifyChangeOrder(
    orderId: string,
    body: { expectedUpdatedAt: string },
  ): Promise<XhsOpsChangeOrderActionResponse> {
    return unwrap(
      () =>
        postApiV1XhsOpsChangeOrdersByOrderIdVerify({ path: { orderId }, body }),
      "补跑核验失败",
      xhsOpsChangeOrderActionResponseSchema,
    );
  },

  async visualCheckChangeOrder(
    orderId: string,
    body: BodyOf<PostApiV1XhsOpsChangeOrdersByOrderIdVisualCheckData>,
  ): Promise<XhsOpsChangeOrderActionResponse> {
    return unwrap(
      () =>
        postApiV1XhsOpsChangeOrdersByOrderIdVisualCheck({
          path: { orderId },
          body,
        }),
      "提交图片对照结果失败",
      xhsOpsChangeOrderActionResponseSchema,
    );
  },

  async manualCheckChangeOrder(
    orderId: string,
    body: { expectedUpdatedAt: string },
  ): Promise<XhsOpsChangeOrderActionResponse> {
    return unwrap(
      () =>
        postApiV1XhsOpsChangeOrdersByOrderIdManualCheck({
          path: { orderId },
          body,
        }),
      "提交人工检查失败",
      xhsOpsChangeOrderActionResponseSchema,
    );
  },

  async reviewObservation(
    orderId: string,
    body: { expectedUpdatedAt: string },
  ): Promise<XhsOpsChangeOrderActionResponse> {
    return unwrap(
      () =>
        postApiV1XhsOpsChangeOrdersByOrderIdObservationReview({
          path: { orderId },
          body,
        }),
      "开始复查失败",
      xhsOpsChangeOrderActionResponseSchema,
    );
  },

  async uploadChangeOrderImage(
    orderId: string,
    field: PutApiV1XhsOpsChangeOrdersByOrderIdFieldsByFieldImageData["path"]["field"],
    body: BodyOf<PutApiV1XhsOpsChangeOrdersByOrderIdFieldsByFieldImageData>,
  ): Promise<XhsOpsChangeOrderActionResponse> {
    return unwrap(
      () =>
        putApiV1XhsOpsChangeOrdersByOrderIdFieldsByFieldImage({
          path: { orderId, field },
          body,
        }),
      "上传图片失败",
      xhsOpsChangeOrderActionResponseSchema,
    );
  },
};

/** Request body of a generated SDK call (the generator marks every body optional). */
type BodyOf<T extends { body?: unknown }> = NonNullable<T["body"]>;

/** Human-readable message for any error thrown by this module (or anything else). */
export function describeXhsOpsError(
  err: unknown,
  fallback = "请求失败",
): string {
  if (err instanceof XhsOpsApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
