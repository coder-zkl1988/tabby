/** Typed wrappers over the generated xhs-ops SDK contract. */
import {
  type XhsOpsAccountTransferInput,
  type XhsOpsDeviceBinding,
  xhsOpsAccountIdentityResponseSchema,
  xhsOpsAccountListResponseSchema,
  xhsOpsAccountResponseSchema,
  xhsOpsCommentGenerateResponseSchema,
  xhsOpsCommentListResponseSchema,
  xhsOpsCommentResponseSchema,
  xhsOpsDeviceBindingListResponseSchema,
  type xhsOpsPersonaGenerateBodySchema,
  xhsOpsPersonaGenerateResponseSchema,
  type xhsOpsPersonasConfirmBodySchema,
  xhsOpsPlanSuggestResponseSchema,
  type xhsOpsProfileConfirmBodySchema,
  xhsOpsProfileReadbackResponseSchema,
  xhsOpsProjectListResponseSchema,
  xhsOpsProjectResponseSchema,
  xhsOpsRunListResponseSchema,
  xhsOpsRunResponseSchema,
} from "@nexu/shared";
import type { z } from "zod";
import {
  deleteApiV1XhsOpsAccountsByAccountId,
  deleteApiV1XhsOpsProjectsByProjectId,
  getApiV1XhsOpsAccountsByAccountId,
  getApiV1XhsOpsDeviceBindings,
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
  postApiV1XhsOpsAccountsByAccountIdIdentityRead,
  postApiV1XhsOpsAccountsByAccountIdProfileDraftApply,
  postApiV1XhsOpsAccountsByAccountIdProfileDraftConfirm,
  postApiV1XhsOpsAccountsByAccountIdProfileDraftGenerate,
  postApiV1XhsOpsAccountsByAccountIdProfileDraftReadback,
  postApiV1XhsOpsAccountsByAccountIdProfileDraftReconcile,
  postApiV1XhsOpsCommentsByCommentIdReview,
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
} from "../../../../../lib/api/sdk.gen";
import type {
  PatchApiV1XhsOpsAccountsByAccountIdData,
  PostApiV1XhsOpsProjectsByProjectIdAccountsData,
  PostApiV1XhsOpsProjectsByProjectIdAccountsTransferDeviceData,
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

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "XhsOpsApiError";
    this.status = status;
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
    throw new XhsOpsApiError(message, status);
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
  async suggestPlans(projectId: string): Promise<XhsOpsPlanSuggestion[]> {
    const data = await unwrap(
      () =>
        getApiV1XhsOpsProjectsByProjectIdPlanSuggest({ path: { projectId } }),
      "今日计划建议加载失败",
      xhsOpsPlanSuggestResponseSchema,
    );
    return data.plans ?? [];
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
};

/** Human-readable message for any error thrown by this module (or anything else). */
export function describeXhsOpsError(
  err: unknown,
  fallback = "请求失败",
): string {
  if (err instanceof XhsOpsApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
