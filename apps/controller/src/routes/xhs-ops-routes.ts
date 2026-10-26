import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  PHONE_SKILLS_BUNDLE,
  XHS_OPS_PLAYBOOK,
  XHS_OPS_PLAYBOOK_VERSION,
  XHS_TAKEOVER_IMAGE_PHONE_UNREACHABLE_MESSAGE,
  XHS_TAKEOVER_PROFILE_DRAFT_LOCKED_MESSAGE,
  type XhsOpsAccount,
  type XhsOpsChangeOrder,
  type XhsOpsPlanSkip,
  xhsOpsAccountConflictResponseSchema,
  xhsOpsAccountCreateSchema,
  xhsOpsAccountIdentityResponseSchema,
  xhsOpsAccountListResponseSchema,
  xhsOpsAccountResponseSchema,
  xhsOpsAccountTransferSchema,
  xhsOpsAccountUpdateSchema,
  xhsOpsAuditBaselineConfirmBodySchema,
  xhsOpsAuditBaselineResponseSchema,
  xhsOpsAuditListResponseSchema,
  xhsOpsAuditResponseSchema,
  xhsOpsAuditStartBodySchema,
  xhsOpsChangeOrderActionResponseSchema,
  xhsOpsChangeOrderCancelBodySchema,
  xhsOpsChangeOrderConfirmBodySchema,
  xhsOpsChangeOrderCreateBodySchema,
  xhsOpsChangeOrderFinishedEvent,
  xhsOpsChangeOrderImageBodySchema,
  xhsOpsChangeOrderListResponseSchema,
  xhsOpsChangeOrderManualCheckBodySchema,
  xhsOpsChangeOrderPrecheckBodySchema,
  xhsOpsChangeOrderResponseSchema,
  xhsOpsChangeOrderVerifyBodySchema,
  xhsOpsChangeOrderVisualCheckBodySchema,
  xhsOpsCommentGenerateBodySchema,
  xhsOpsCommentGenerateResponseSchema,
  xhsOpsCommentListQuerySchema,
  xhsOpsCommentListResponseSchema,
  xhsOpsCommentQuotaResponseSchema,
  xhsOpsCommentResponseSchema,
  xhsOpsCommentReviewBodySchema,
  xhsOpsCommentRunConflictResponseSchema,
  xhsOpsDeviceBindingListResponseSchema,
  xhsOpsDeviceSupportsTakeoverImages,
  xhsOpsDiagnosisDecisionsBodySchema,
  xhsOpsDiagnosisGenerateBodySchema,
  xhsOpsDiagnosisRegenerateBodySchema,
  xhsOpsDiagnosisResponseSchema,
  xhsOpsDiagnosisViewResponseSchema,
  xhsOpsObservationReviewBodySchema,
  xhsOpsPersonaGenerateBodySchema,
  xhsOpsPersonaGenerateResponseSchema,
  xhsOpsPersonasConfirmBodySchema,
  xhsOpsPlanSuggestResponseSchema,
  xhsOpsPlaybookResponseSchema,
  xhsOpsProfileApplyBodySchema,
  xhsOpsProfileConfirmBodySchema,
  xhsOpsProfileGenerateBodySchema,
  xhsOpsProfileReadbackResponseSchema,
  xhsOpsProjectCreateSchema,
  xhsOpsProjectListResponseSchema,
  xhsOpsProjectResponseSchema,
  xhsOpsProjectSchema,
  xhsOpsProjectUpdateSchema,
  xhsOpsRunCreateSchema,
  xhsOpsRunListQuerySchema,
  xhsOpsRunListResponseSchema,
  xhsOpsRunResponseSchema,
  xhsOpsRunUpdateSchema,
  xhsOpsTakeoverAuthorizeBodySchema,
  xhsOpsTakeoverDeviceHoldReleaseBodySchema,
  xhsOpsTakeoverIdentityConfirmBodySchema,
  xhsOpsTakeoverIdentityConfirmResponseSchema,
  xhsOpsTakeoverIdentityReadResponseSchema,
  xhsOpsTakeoverPauseBodySchema,
  xhsOpsTakeoverPlanConfirmBodySchema,
  xhsOpsTakeoverPlanResponseSchema,
  xhsOpsTakeoverPlanRevertBodySchema,
  xhsOpsTakeoverPlanRevertResponseSchema,
  xhsOpsTakeoverResumeBodySchema,
  xhsOpsTakeoverResumeResponseSchema,
} from "@nexu/shared";
import type { ControllerContainer } from "../app/container.js";
import { logger } from "../lib/logger.js";
import {
  XhsOpsTakeoverParamError,
  XhsOpsTakeoverPausedError,
} from "../lib/xhs-ops-common.js";
import { ImageGenerationFailedError } from "../services/media-generation-service.js";
import {
  generateXhsOpsPersonas,
  generateXhsOpsProfile,
} from "../services/xhs-ops-persona-service.js";
import {
  XHS_OPS_DEFAULT_OFFLINE_AFTER_MS,
  XhsOpsError,
} from "../services/xhs-ops-run-service.js";
import { probeTakeoverDevice } from "../services/xhs-ops-takeover-phone.js";
import type { XhsOpsTakeoverRecoveryState } from "../services/xhs-ops-takeover-recovery.js";
import type { ControllerBindings } from "../types.js";

const TAGS = ["XHS Ops"];
const projectIdParamSchema = z.object({ projectId: z.string() });
const accountIdParamSchema = z.object({ accountId: z.string() });
const runIdParamSchema = z.object({ runId: z.string() });
const auditIdParamSchema = z.object({ auditId: z.string() });
const diagnosisIdParamSchema = z.object({ diagnosisId: z.string() });
const orderIdParamSchema = z.object({ orderId: z.string() });
/** Only the two image fields take an upload (§5.2 step 1). */
const orderImageParamSchema = z.object({
  orderId: z.string(),
  field: z.enum(["avatar", "cover"]),
});
const errorSchema = z.object({ message: z.string() });

/** 503 of the takeover routes while the startup recovery has not settled (§2.6). */
const TAKEOVER_RECOVERING_MESSAGE =
  "控制端刚重启，正在收口上次未完成的接管任务，请稍后重试";

/** Account create body: `projectId` comes from the path and wins over the body. */
const accountCreateBodySchema = xhsOpsAccountCreateSchema.partial({
  projectId: true,
});

const jsonError = (description: string) => ({
  content: { "application/json": { schema: errorSchema } },
  description,
});

/**
 * Media generation fails for reasons the operator can act on (relay down,
 * relay slow, no bot configured). Collapsing them all into the generic retry
 * message meant the only way to tell those apart was reading controller logs.
 */
function describeGenerationFailure(reason: string): string {
  if (/timed out after \d+ms/i.test(reason)) {
    return "素材生成超时：模型服务响应太慢，请稍后重试";
  }
  if (/generation session failed/i.test(reason)) {
    return "素材生成失败：模型服务不可用（上游可能限流或无可用通道），请稍后重试";
  }
  if (/no active bot available/i.test(reason)) {
    return "素材生成失败：没有可用的机器人来执行生成";
  }
  if (/text generation backend is not configured/i.test(reason)) {
    return "素材生成失败：文本生成后端未配置";
  }
  if (/returned empty text|no media path was found/i.test(reason)) {
    return "素材生成失败：模型没有返回可用结果，请重试";
  }
  // tabby-image errors are already operator-readable Chinese.
  return reason;
}

function mapError(err: unknown): {
  status: 400 | 404 | 409 | 500;
  message: string;
} {
  if (err instanceof XhsOpsError) {
    return { status: err.status, message: err.message };
  }
  const reason = err instanceof Error ? err.message : String(err);
  logger.error({ error: reason }, "xhs-ops: route failed");
  if (err instanceof ImageGenerationFailedError) {
    return { status: 500, message: describeGenerationFailure(reason) };
  }
  return { status: 500, message: "小红书运营操作失败，请稍后重试" };
}

/**
 * Error body of the account PATCH and the device transfer: a takeover
 * parameter conflict carries its code and issues next to the unchanged
 * message (xhsOpsAccountConflictResponseSchema, §2.5).
 */
function accountErrorBody(
  err: unknown,
  message: string,
): z.infer<typeof xhsOpsAccountConflictResponseSchema> {
  return err instanceof XhsOpsTakeoverParamError
    ? { message, code: err.code, issues: err.issues }
    : { message };
}

/** 409 of the account PATCH and the device transfer, structured for a takeover parameter conflict. */
const accountConflict = (description: string) => ({
  content: {
    "application/json": { schema: xhsOpsAccountConflictResponseSchema },
  },
  description,
});

/** A change-order response, with the T8 event once the order is past its phone steps. */
function changeOrderAction(result: {
  order: XhsOpsChangeOrder;
  account: XhsOpsAccount;
}) {
  return { ...result, event: xhsOpsChangeOrderFinishedEvent(result) };
}

export function registerXhsOpsRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  const {
    xhsOpsStore: store,
    xhsOpsRunService: runService,
    xhsOpsProfileService: profileService,
    xhsOpsScheduler: scheduler,
    xhsOpsCommentService: commentService,
    xhsOpsAuditService: auditService,
    xhsOpsDiagnosisService: diagnosisService,
    xhsOpsChangeOrderService: changeOrderService,
  } = container;
  const mutationErrors = {
    400: jsonError("Invalid request"),
    404: jsonError("Not found"),
    409: jsonError("Conflict"),
    500: jsonError("Failed"),
  };

  /**
   * Takeover routes that start or advance work — every write but 「暂停接管」,
   * and the change-order reads, which settle expired prechecks and finished
   * reviews on the way — answer 503 until the startup recovery settled
   * (XhsOpsTakeoverRecoveryState says why). Absent in tests that build the
   * routes on their own: nothing to wait for.
   */
  const takeoverRecovery: XhsOpsTakeoverRecoveryState | undefined =
    container.xhsOpsTakeoverRecovery;
  const takeoverRecovering = (): boolean => takeoverRecovery?.settled === false;
  const takeoverErrors = {
    ...mutationErrors,
    503: jsonError("Startup recovery of takeover work still running"),
  };
  const recovering503 = {
    503: jsonError(
      "An existing or taken-over account during the startup recovery of takeover work",
    ),
  };

  /**
   * The shared account routes that write takeover state for an existing
   * account — the identity read, the apply reconcile, an identity-moving
   * PATCH, the device transfer, the delete — answer the same 503 for an
   * existing or taken-over account until the recovery settled. A new account
   * is served as before.
   */
  const recoveringFor = async (
    ...accountIds: Array<string | undefined>
  ): Promise<boolean> => {
    if (!takeoverRecovering()) return false;
    for (const accountId of accountIds) {
      if (!accountId) continue;
      const account = await store.getAccount(accountId);
      if (account && (account.entryMode === "existing" || account.takeover))
        return true;
    }
    return false;
  };

  /** Whether a PATCH would move the account's identity: its device binding or 小红书号. */
  const movesIdentity = async (
    accountId: string,
    patch: z.infer<typeof xhsOpsAccountUpdateSchema>,
  ): Promise<boolean> => {
    const account = await store.getAccount(accountId);
    if (!account) return false;
    return (
      (patch.deviceId !== undefined &&
        (patch.deviceId?.trim() || null) !== account.deviceId) ||
      (patch.platformAccountId !== undefined &&
        patch.platformAccountId !== account.platformAccountId)
    );
  };

  /**
   * §2.5: the profile-draft generate / confirm / apply / readback routes
   * serve new accounts only. Every existing account — a takeover === null
   * legacy row included — changes its public profile through change orders;
   * the old path would dispatch the login preparation, authorize every photo
   * and push generated portraits onto a real account.
   */
  const assertNewAccountProfileDraft = async (accountId: string) => {
    const account = await store.getAccount(accountId);
    if (!account) throw new XhsOpsError(404, "账号不存在");
    if (account.entryMode === "existing")
      throw new XhsOpsError(409, XHS_TAKEOVER_PROFILE_DRAFT_LOCKED_MESSAGE);
  };

  /**
   * §5.2: image fields need Android 10 (API 29) or later on the bound phone.
   * A reported version below that, or none reported, drafts no image order
   * with the too-old message. A phone that could not be asked at all — not
   * bound, not connected or silent past the offline threshold (a status the
   * device service still caches is no answer), its status not queryable —
   * drafts none either, but the skip reason says so instead of blaming the
   * version. Same probe as the change-order service's.
   */
  const diagnosisImageSupport = async (
    diagnosisId: string,
  ): Promise<{
    imageFieldsSupported: boolean;
    imageFieldsSkipReason?: string;
  }> => {
    const diagnosis = await store.getDiagnosis(diagnosisId);
    const account = diagnosis
      ? await store.getAccount(diagnosis.accountId)
      : null;
    const device = account?.deviceId
      ? await probeTakeoverDevice(
          container.deviceControlService,
          account.deviceId,
          { now: Date.now(), offlineAfterMs: XHS_OPS_DEFAULT_OFFLINE_AFTER_MS },
        )
      : null;
    if (!device || device === "unknown")
      return {
        imageFieldsSupported: false,
        imageFieldsSkipReason: XHS_TAKEOVER_IMAGE_PHONE_UNREACHABLE_MESSAGE,
      };
    return { imageFieldsSupported: xhsOpsDeviceSupportsTakeoverImages(device) };
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/projects/{projectId}/profile/confirm",
      tags: TAGS,
      request: {
        params: projectIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsProfileConfirmBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsProjectResponseSchema },
          },
          description: "Human-confirmed current target profile",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        return c.json(
          {
            project: await store.confirmProfile(
              c.req.valid("param").projectId,
              c.req.valid("json"),
            ),
          },
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/projects/{projectId}/profile/generate",
      tags: TAGS,
      request: {
        params: projectIdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: z.object({ expectedUpdatedAt: z.string() }),
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsProjectResponseSchema },
          },
          description: "Generated target profile awaiting human review",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        return c.json(
          {
            project: await generateXhsOpsProfile(
              store,
              container.mediaGenerationService,
              c.req.valid("param").projectId,
              c.req.valid("json").expectedUpdatedAt,
            ),
          },
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/projects/{projectId}/personas/generate",
      tags: TAGS,
      request: {
        params: projectIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsPersonaGenerateBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsPersonaGenerateResponseSchema },
          },
          description:
            "N persona candidates and actual distribution for review",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        const body = c.req.valid("json");
        return c.json(
          await generateXhsOpsPersonas(
            store,
            container.mediaGenerationService,
            c.req.valid("param").projectId,
            body.count,
            body.expectedUpdatedAt,
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/projects/{projectId}/personas/confirm",
      tags: TAGS,
      request: {
        params: projectIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsPersonasConfirmBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountListResponseSchema },
          },
          description: "Human-reviewed personas matching the latest project",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        return c.json(
          {
            accounts: await store.confirmPersonas(
              c.req.valid("param").projectId,
              c.req.valid("json"),
            ),
          },
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  // ─── Profile draft (P2-1) ────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/profile-draft/generate",
      tags: TAGS,
      request: {
        params: accountIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsProfileGenerateBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountResponseSchema },
          },
          description: "Account with regenerated profile draft parts",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        const body = c.req.valid("json");
        await assertNewAccountProfileDraft(c.req.valid("param").accountId);
        const account = await profileService.generate(
          c.req.valid("param").accountId,
          body.parts,
          {
            ...(body.avatarPrompt !== undefined
              ? { avatarPrompt: body.avatarPrompt }
              : {}),
            ...(body.coverPrompt !== undefined
              ? { coverPrompt: body.coverPrompt }
              : {}),
          },
        );
        return c.json({ account }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/profile-draft/confirm",
      tags: TAGS,
      request: {
        params: accountIdParamSchema,
        query: z.object({ expectedUpdatedAt: z.string().optional() }),
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountResponseSchema },
          },
          description: "Confirmed complete profile draft",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        await assertNewAccountProfileDraft(c.req.valid("param").accountId);
        const account = await store.confirmProfileDraft(
          c.req.valid("param").accountId,
          c.req.valid("query").expectedUpdatedAt,
        );
        if (!account) return c.json({ message: "账号不存在" }, 404);
        return c.json({ account }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/profile-draft/reconcile",
      tags: TAGS,
      request: { params: accountIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountResponseSchema },
          },
          description:
            "Reconciled a profile operation left running after a transport failure",
        },
        ...mutationErrors,
        ...recovering503,
      },
    }),
    async (c) => {
      if (await recoveringFor(c.req.valid("param").accountId))
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const account = await profileService.reconcile(
          c.req.valid("param").accountId,
        );
        if (!account) return c.json({ message: "账号不存在" }, 404);
        return c.json({ account }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/identity/read",
      tags: TAGS,
      request: { params: accountIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsAccountIdentityResponseSchema,
            },
          },
          description:
            "Read-only screenshot of the bound phone's 编辑主页 so the operator can confirm which account is signed in",
        },
        ...mutationErrors,
        ...recovering503,
      },
    }),
    async (c) => {
      if (await recoveringFor(c.req.valid("param").accountId))
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const identity = await profileService.readIdentity(
          c.req.valid("param").accountId,
        );
        return c.json(identity, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/profile-draft/readback",
      tags: TAGS,
      request: { params: accountIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsProfileReadbackResponseSchema,
            },
          },
          description:
            "The phone's current profile diffed against the draft, so the operator can pick what to overwrite",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        await assertNewAccountProfileDraft(c.req.valid("param").accountId);
        const readback = await profileService.readbackProfile(
          c.req.valid("param").accountId,
        );
        return c.json(readback, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/profile-draft/apply",
      tags: TAGS,
      request: {
        params: accountIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsProfileApplyBodySchema },
          },
          required: false,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountResponseSchema },
          },
          description:
            "Profile applied on the bound phone; draft carries applyStatus/applyResult",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        const body = c.req.valid("json") as { fields?: string[] } | undefined;
        await assertNewAccountProfileDraft(c.req.valid("param").accountId);
        const account = await profileService.apply(
          c.req.valid("param").accountId,
          body?.fields as Parameters<typeof profileService.apply>[1],
        );
        return c.json({ account }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  // ─── Plan suggestion ──────────────────────────────────────────────────────

  // ─── P3-1 D1 评论审核队列 ───────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/projects/{projectId}/comments",
      tags: TAGS,
      request: {
        params: projectIdParamSchema,
        query: xhsOpsCommentListQuerySchema,
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsCommentListResponseSchema },
          },
          description:
            "Comment drafts (newest first) + today's per-account quota",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        const result = await commentService.listForProject(
          c.req.valid("param").projectId,
          c.req.valid("query"),
        );
        return c.json(result, 200);
      } catch (err) {
        const { status, message } = mapError(err);
        return c.json({ message }, status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/runs/{runId}/comments/generate",
      tags: TAGS,
      request: {
        params: z.object({ runId: z.string().min(1) }),
        body: {
          content: {
            "application/json": { schema: xhsOpsCommentGenerateBodySchema },
          },
          required: false,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsCommentGenerateResponseSchema,
            },
          },
          description:
            "Drafts created for the run's posts (commentWorthy or explicit)",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      const { runId } = c.req.valid("param");
      const body = c.req.valid("json") as
        | { posts?: Array<{ chunkIndex: number; postIndex: number }> }
        | undefined;
      try {
        const result = await commentService.generateForRun(runId, body?.posts);
        return c.json(result, 200);
      } catch (err) {
        const { status, message } = mapError(err);
        return c.json({ message }, status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/comments/{commentId}/review",
      tags: TAGS,
      request: {
        params: z.object({ commentId: z.string().min(1) }),
        body: {
          content: {
            "application/json": { schema: xhsOpsCommentReviewBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsCommentResponseSchema },
          },
          description: "Reviewed draft",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        const draft = await commentService.review(
          c.req.valid("param").commentId,
          c.req.valid("json"),
        );
        return c.json({ draft }, 200);
      } catch (err) {
        const { status, message } = mapError(err);
        return c.json({ message }, status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/accounts/{accountId}/comment-quota",
      tags: TAGS,
      request: { params: accountIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsCommentQuotaResponseSchema },
          },
          description: "Today's comment quota for the account",
        },
        404: jsonError("Account not found"),
      },
    }),
    async (c) => {
      try {
        const quota = await commentService.quotaFor(
          c.req.valid("param").accountId,
        );
        return c.json({ quota }, 200);
      } catch (err) {
        const { status, message } = mapError(err);
        return c.json(
          { message: status === 404 ? message : `${message}` },
          404,
        );
      }
    },
  );

  // P3-1 D2：把账号已批准的评论打成评论 run 并启动（设备队列串行）。
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/projects/{projectId}/comment-runs",
      tags: TAGS,
      request: {
        params: projectIdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: z.object({
                accountId: z.string().min(1),
                draftIds: z.array(z.string().min(1)).max(5).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsRunResponseSchema },
          },
          description:
            "Comment run created and started (or queued behind the phone's current run)",
        },
        ...mutationErrors,
        409: {
          content: {
            "application/json": {
              schema: xhsOpsCommentRunConflictResponseSchema,
            },
          },
          description:
            "Comment run refused; a paused takeover adds code takeover_paused",
        },
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const body = c.req.valid("json");
      try {
        const created = await runService.createCommentRun({
          projectId,
          accountId: body.accountId,
          draftIds: body.draftIds,
        });
        const run = await runService.startRun(created.id);
        return c.json({ run }, 200);
      } catch (err) {
        const { status, message } = mapError(err);
        return c.json(
          err instanceof XhsOpsTakeoverPausedError
            ? { message, code: err.code }
            : { message },
          status,
        );
      }
    },
  );

  // P2-4 立即执行一次：忽略开关/时间，按今日计划建议 createRun+startRun（设备队列串行）。
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/projects/{projectId}/schedule/run-now",
      tags: TAGS,
      request: { params: projectIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                project: xhsOpsProjectSchema,
                result: z.object({
                  date: z.string(),
                  planned: z.number(),
                  created: z.number(),
                  started: z.number(),
                  queued: z.number(),
                  skipped: z.array(z.string()),
                  summary: z.string(),
                }),
              }),
            },
          },
          description: "Today's plans dispatched (or queued) for the project",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      try {
        const result = await scheduler.triggerProject(projectId, {
          reason: "manual",
        });
        const project = await store.getProject(projectId);
        if (!project) return c.json({ message: "项目不存在" }, 404);
        return c.json({ project, result }, 200);
      } catch (err) {
        const { status, message } = mapError(err);
        return c.json({ message }, status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/projects/{projectId}/plan-suggest",
      tags: TAGS,
      request: { params: projectIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsPlanSuggestResponseSchema },
          },
          description: "Deterministic per-account plan suggestions for today",
        },
        404: jsonError("Project not found"),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      if (!(await store.getProject(projectId))) {
        return c.json({ message: "项目不存在" }, 404);
      }
      // One account's 409 is its own skip, not the project's (§5.3 #5).
      const skipped: XhsOpsPlanSkip[] = [];
      const plans = await runService.suggestPlans(projectId, {
        onSkipped: (skip) => skipped.push(skip),
      });
      return c.json({ plans, skipped }, 200);
    },
  );

  // ─── Projects ──────────────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/device-bindings",
      tags: TAGS,
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsDeviceBindingListResponseSchema,
            },
          },
          description: "Global device bindings with transfer availability",
        },
      },
    }),
    async (c) => c.json({ bindings: await store.listDeviceBindings() }, 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/projects",
      tags: TAGS,
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsProjectListResponseSchema },
          },
          description: "Project list",
        },
      },
    }),
    async (c) => c.json({ projects: await store.listProjects() }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/projects",
      tags: TAGS,
      request: {
        body: {
          content: {
            "application/json": { schema: xhsOpsProjectCreateSchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsProjectResponseSchema },
          },
          description: "Created project",
        },
      },
    }),
    async (c) =>
      c.json({ project: await store.createProject(c.req.valid("json")) }, 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/projects/{projectId}",
      tags: TAGS,
      request: { params: projectIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsProjectResponseSchema },
          },
          description: "Project",
        },
        404: jsonError("Project not found"),
      },
    }),
    async (c) => {
      const project = await store.getProject(c.req.valid("param").projectId);
      if (!project) return c.json({ message: "项目不存在" }, 404);
      return c.json({ project }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/xhs-ops/projects/{projectId}",
      tags: TAGS,
      request: {
        params: projectIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsProjectUpdateSchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsProjectResponseSchema },
          },
          description: "Updated project",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        const project = await store.updateProject(
          c.req.valid("param").projectId,
          c.req.valid("json"),
        );
        if (!project) return c.json({ message: "项目不存在" }, 404);
        return c.json({ project }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/v1/xhs-ops/projects/{projectId}",
      tags: TAGS,
      request: { params: projectIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsProjectResponseSchema },
          },
          description: "Deleted project (accounts and runs cascade)",
        },
        400: jsonError("Invalid deletion"),
        404: jsonError("Project not found"),
        409: jsonError(
          "Project has unfinished tasks or today's execution records",
        ),
        500: jsonError("Project deletion failed"),
      },
    }),
    async (c) => {
      try {
        const project = await store.deleteProject(
          c.req.valid("param").projectId,
        );
        if (!project) return c.json({ message: "项目不存在" }, 404);
        return c.json({ project }, 200);
      } catch (err) {
        const error = mapError(err);
        return c.json({ message: error.message }, error.status);
      }
    },
  );

  // ─── Accounts ──────────────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/projects/{projectId}/accounts/transfer-device",
      tags: TAGS,
      request: {
        params: projectIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsAccountTransferSchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountResponseSchema },
          },
          description: "Transferred device binding",
        },
        ...mutationErrors,
        409: accountConflict(
          "Device busy or offline, a binding conflict, or a takeover target's parameters past a limit (code and issues; overrideReason lifts an overridable one)",
        ),
        ...recovering503,
      },
    }),
    async (c) => {
      const transfer = c.req.valid("json");
      if (await recoveringFor(transfer.fromAccountId, transfer.toAccountId))
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const input = c.req.valid("json");
        const device = await container.deviceControlService
          .getDevice(input.account.deviceId)
          .catch(() => {
            throw new XhsOpsError(409, "设备离线，无法确认空闲状态");
          });
        if (
          !device ||
          Date.now() - device.lastSeen > XHS_OPS_DEFAULT_OFFLINE_AFTER_MS
        ) {
          throw new XhsOpsError(409, "设备离线，无法转移绑定");
        }
        if (device.status !== "idle" || device.currentTaskId) {
          throw new XhsOpsError(409, "设备正在执行任务，无法转移绑定");
        }
        const account = await store.transferDevice(
          c.req.valid("param").projectId,
          input,
        );
        return c.json({ account }, 200);
      } catch (err) {
        const error = mapError(err);
        return c.json(accountErrorBody(err, error.message), error.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/projects/{projectId}/accounts",
      tags: TAGS,
      request: { params: projectIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountListResponseSchema },
          },
          description: "Accounts of the project",
        },
        404: jsonError("Project not found"),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      if (!(await store.getProject(projectId))) {
        return c.json({ message: "项目不存在" }, 404);
      }
      return c.json(
        { accounts: await store.listAccountsByProject(projectId) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/projects/{projectId}/accounts",
      tags: TAGS,
      request: {
        params: projectIdParamSchema,
        body: {
          content: { "application/json": { schema: accountCreateBodySchema } },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountResponseSchema },
          },
          description: "Created account",
        },
        400: jsonError("Body projectId does not match the path"),
        404: jsonError("Project not found"),
        409: jsonError("Device already bound"),
        500: jsonError("Account creation failed"),
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.projectId !== undefined && body.projectId !== projectId) {
        return c.json({ message: "请求体 projectId 与路径不一致" }, 400);
      }
      if (!(await store.getProject(projectId))) {
        return c.json({ message: "项目不存在" }, 404);
      }
      try {
        const account = await store.createAccount({ ...body, projectId });
        return c.json({ account }, 200);
      } catch (err) {
        const error = mapError(err);
        return c.json({ message: error.message }, error.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/accounts/{accountId}",
      tags: TAGS,
      request: { params: accountIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountResponseSchema },
          },
          description: "Account",
        },
        404: jsonError("Account not found"),
      },
    }),
    async (c) => {
      const account = await store.getAccount(c.req.valid("param").accountId);
      if (!account) return c.json({ message: "账号不存在" }, 404);
      return c.json({ account }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/xhs-ops/accounts/{accountId}",
      tags: TAGS,
      request: {
        params: accountIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsAccountUpdateSchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountResponseSchema },
          },
          description: "Updated account",
        },
        400: jsonError("Invalid account update"),
        404: jsonError("Account not found"),
        409: accountConflict(
          "Device binding conflict, unfinished runs, a locked entryMode or 小红书号, or a takeover's parameters past a limit (code and issues; overrideReason lifts an overridable one)",
        ),
        500: jsonError("Account update failed"),
        ...recovering503,
      },
    }),
    async (c) => {
      const { accountId } = c.req.valid("param");
      if (
        takeoverRecovering() &&
        (await movesIdentity(accountId, c.req.valid("json"))) &&
        (await recoveringFor(accountId))
      )
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const account = await store.updateAccount(
          c.req.valid("param").accountId,
          c.req.valid("json"),
        );
        if (!account) return c.json({ message: "账号不存在" }, 404);
        return c.json({ account }, 200);
      } catch (err) {
        const error = mapError(err);
        return c.json(accountErrorBody(err, error.message), error.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/v1/xhs-ops/accounts/{accountId}",
      tags: TAGS,
      request: { params: accountIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountResponseSchema },
          },
          description: "Deleted account",
        },
        ...mutationErrors,
        ...recovering503,
      },
    }),
    async (c) => {
      if (await recoveringFor(c.req.valid("param").accountId))
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const account = await store.deleteAccount(
          c.req.valid("param").accountId,
        );
        if (!account) return c.json({ message: "账号不存在" }, 404);
        return c.json({ account }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  // ─── Runs ──────────────────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/runs",
      tags: TAGS,
      request: { query: xhsOpsRunListQuerySchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsRunListResponseSchema },
          },
          description: "Runs, newest first",
        },
      },
    }),
    async (c) =>
      c.json({ runs: await store.listRuns(c.req.valid("query")) }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/runs",
      tags: TAGS,
      request: {
        body: {
          content: { "application/json": { schema: xhsOpsRunCreateSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: xhsOpsRunResponseSchema } },
          description: "Planned run (status planned)",
        },
        400: jsonError("Account has no device bound"),
        404: jsonError("Project or account not found"),
        409: jsonError("Conflict"),
        500: jsonError("Internal error"),
      },
    }),
    async (c) => {
      try {
        const run = await runService.createRun(c.req.valid("json"));
        return c.json({ run }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/runs/{runId}",
      tags: TAGS,
      request: { params: runIdParamSchema },
      responses: {
        200: {
          content: { "application/json": { schema: xhsOpsRunResponseSchema } },
          description: "Run",
        },
        404: jsonError("Run not found"),
      },
    }),
    async (c) => {
      const run = await store.getRun(c.req.valid("param").runId);
      if (!run) return c.json({ message: "运行记录不存在" }, 404);
      return c.json({ run }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/xhs-ops/runs/{runId}",
      tags: TAGS,
      request: {
        params: runIdParamSchema,
        body: {
          content: { "application/json": { schema: xhsOpsRunUpdateSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: xhsOpsRunResponseSchema } },
          description: "Run with updated notes",
        },
        404: jsonError("Run not found"),
      },
    }),
    async (c) => {
      const { notes } = c.req.valid("json");
      const run = await store.updateRun(
        c.req.valid("param").runId,
        (current) => (notes === undefined ? current : { ...current, notes }),
      );
      if (!run) return c.json({ message: "运行记录不存在" }, 404);
      return c.json({ run }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/runs/{runId}/start",
      tags: TAGS,
      request: { params: runIdParamSchema },
      responses: {
        200: {
          content: { "application/json": { schema: xhsOpsRunResponseSchema } },
          description: "Run started (status running); executes asynchronously",
        },
        400: jsonError("Bad request"),
        404: jsonError("Run not found"),
        409: jsonError("Run is already running or finished"),
        500: jsonError("Internal error"),
      },
    }),
    async (c) => {
      try {
        const run = await runService.startRun(c.req.valid("param").runId);
        return c.json({ run }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/runs/{runId}/cancel",
      tags: TAGS,
      request: { params: runIdParamSchema },
      responses: {
        200: {
          content: { "application/json": { schema: xhsOpsRunResponseSchema } },
          description: "Run cancelled; the phone's current task is cancelled",
        },
        400: jsonError("Bad request"),
        404: jsonError("Run not found"),
        409: jsonError("Run is not running"),
        500: jsonError("Internal error"),
      },
    }),
    async (c) => {
      try {
        const run = await runService.cancelRun(c.req.valid("param").runId);
        return c.json({ run }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  // ─── 老号接管（takeover design §1.2 T1–T9, §9 P0 路由）─────────────────────

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/takeover/authorize",
      tags: TAGS,
      request: {
        params: accountIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsTakeoverAuthorizeBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountResponseSchema },
          },
          description:
            "Card ① ownership statement: the takeover starts and entryMode is locked",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const account = await store.authorizeTakeover(
          c.req.valid("param").accountId,
          c.req.valid("json"),
        );
        return c.json({ account }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/takeover/identity/read",
      tags: TAGS,
      request: { params: accountIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsTakeoverIdentityReadResponseSchema,
            },
          },
          description:
            "Read-only identity read under the exclusive device lock; the result is kept server-side as pendingIdentity",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        return c.json(
          await auditService.readTakeoverIdentity(
            c.req.valid("param").accountId,
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/takeover/identity/confirm",
      tags: TAGS,
      request: {
        params: accountIdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: xhsOpsTakeoverIdentityConfirmBodySchema,
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsTakeoverIdentityConfirmResponseSchema,
            },
          },
          description:
            "Identity locked against the pending read; the event carries no 小红书号",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        return c.json(
          await auditService.confirmTakeoverIdentity(
            c.req.valid("param").accountId,
            c.req.valid("json"),
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/takeover/plan/revert",
      tags: TAGS,
      request: {
        params: accountIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsTakeoverPlanRevertBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsTakeoverPlanRevertResponseSchema,
            },
          },
          description:
            "「撤销方案」: the pre-plan snapshot restored, unstarted change orders cancelled",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        return c.json(
          await store.revertTakeoverPlan(
            c.req.valid("param").accountId,
            c.req.valid("json"),
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/takeover/pause",
      tags: TAGS,
      request: {
        params: accountIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsTakeoverPauseBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountResponseSchema },
          },
          description:
            "「暂停接管」: a manual safety pause; a stronger pause in force stays",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        const account = await store.pauseTakeover(
          c.req.valid("param").accountId,
          { code: "manual", reason: c.req.valid("json").reason },
        );
        return c.json({ account }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/takeover/resume",
      tags: TAGS,
      request: {
        params: accountIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsTakeoverResumeBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsTakeoverResumeResponseSchema,
            },
          },
          description:
            "「恢复」: cooldown codes lift once the cooldown passed; every other code lifts only when the identity gate reports ready (resumed false keeps the pause)",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        return c.json(
          await auditService.resumeTakeover(
            c.req.valid("param").accountId,
            c.req.valid("json"),
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/takeover/device-hold/release",
      tags: TAGS,
      request: {
        params: accountIdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: xhsOpsTakeoverDeviceHoldReleaseBodySchema,
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAccountResponseSchema },
          },
          description:
            "The operator confirmed on the phone that the held task ended; the device is free again",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const account = await store.releaseTakeoverDeviceHold(
          c.req.valid("param").accountId,
          c.req.valid("json"),
        );
        return c.json({ account }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/playbook",
      tags: TAGS,
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsPlaybookResponseSchema },
          },
          description:
            "The rules diagnoses cite, shown as 技能文档 / 本方案规则 / 参考 chips, and the phone-skills bundle their doc excerpts were checked against",
        },
      },
    }),
    async (c) =>
      c.json(
        {
          version: XHS_OPS_PLAYBOOK_VERSION,
          bundleVersion: PHONE_SKILLS_BUNDLE,
          rules: [...XHS_OPS_PLAYBOOK],
        },
        200,
      ),
  );

  // ─── Takeover audits (T3) ────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/audits",
      tags: TAGS,
      request: {
        params: accountIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsAuditStartBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAuditResponseSchema },
          },
          description:
            "Read-only audit started (status running); its three parts run in the background",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const audit = await auditService.startAudit(
          c.req.valid("param").accountId,
          c.req.valid("json"),
        );
        return c.json({ audit }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/accounts/{accountId}/audits",
      tags: TAGS,
      request: { params: accountIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAuditListResponseSchema },
          },
          description: "The account's audits, newest first",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        const { accountId } = c.req.valid("param");
        if (!(await store.getAccount(accountId)))
          return c.json({ message: "账号不存在" }, 404);
        return c.json(
          { audits: await auditService.listAudits(accountId) },
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/audits/{auditId}",
      tags: TAGS,
      request: { params: auditIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAuditResponseSchema },
          },
          description: "One audit; the card polls it while it runs",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        const audit = await auditService.getAudit(c.req.valid("param").auditId);
        return c.json({ audit }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/audits/{auditId}/cancel",
      tags: TAGS,
      request: { params: auditIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsAuditResponseSchema },
          },
          description:
            "「取消盘点」: no further part is dispatched and the running task is stopped by its id",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const audit = await auditService.cancelAudit(
          c.req.valid("param").auditId,
        );
        return c.json({ audit }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/audits/{auditId}/baseline",
      tags: TAGS,
      request: {
        params: auditIdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: xhsOpsAuditBaselineConfirmBodySchema,
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsAuditBaselineResponseSchema,
            },
          },
          description:
            "「数据核对无误，设为基线」; the event carries public fields only (D6)",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const result = await auditService.confirmBaseline(
          c.req.valid("param").auditId,
          c.req.valid("json"),
        );
        return c.json(
          { account: result.account, audit: result.audit, event: result.event },
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  // ─── Takeover diagnoses and plan (T5–T6) ─────────────────────────────────

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/diagnoses",
      tags: TAGS,
      request: {
        params: accountIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsDiagnosisGenerateBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsDiagnosisResponseSchema },
          },
          description:
            "「按意见生成诊断」: the diagnosis at generating; it settles in the background",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const diagnosis = await diagnosisService.generate(
          c.req.valid("param").accountId,
          c.req.valid("json"),
        );
        return c.json({ diagnosis }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/diagnoses/{diagnosisId}",
      tags: TAGS,
      request: { params: diagnosisIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsDiagnosisViewResponseSchema },
          },
          description:
            "One diagnosis, with xhs_ops_account_diagnosed once it settled at ready or failed",
        },
        ...mutationErrors,
      },
    }),
    async (c) => {
      try {
        return c.json(
          await diagnosisService.get(c.req.valid("param").diagnosisId),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/diagnoses/{diagnosisId}/regenerate",
      tags: TAGS,
      request: {
        params: diagnosisIdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: xhsOpsDiagnosisRegenerateBodySchema,
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsDiagnosisResponseSchema },
          },
          description:
            "「按意见重新生成」: a new version on the same audit; decided items are carried over",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const diagnosis = await diagnosisService.regenerate(
          c.req.valid("param").diagnosisId,
          c.req.valid("json"),
        );
        return c.json({ diagnosis }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/diagnoses/{diagnosisId}/decisions",
      tags: TAGS,
      request: {
        params: diagnosisIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsDiagnosisDecisionsBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsDiagnosisResponseSchema },
          },
          description:
            "Card ⑤ adopt / edit / reject / defer per proposal; an edit is re-validated by kind",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const diagnosis = await diagnosisService.decide(
          c.req.valid("param").diagnosisId,
          c.req.valid("json"),
        );
        return c.json({ diagnosis }, 200);
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/diagnoses/{diagnosisId}/confirm",
      tags: TAGS,
      request: {
        params: diagnosisIdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: xhsOpsTakeoverPlanConfirmBodySchema,
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsTakeoverPlanResponseSchema },
          },
          description:
            "「确认优化方案」: L0 in force, adopted public fields drafted as change orders (image fields only on Android 10+)",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const { diagnosisId } = c.req.valid("param");
        const result = await diagnosisService.confirmPlan(
          diagnosisId,
          c.req.valid("json"),
          await diagnosisImageSupport(diagnosisId),
        );
        return c.json(
          {
            account: result.account,
            diagnosis: result.diagnosis,
            changeOrders: result.changeOrders,
            skippedFields: result.skippedFields,
            event: result.event,
          },
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  // ─── Takeover change orders (T8–T9) ──────────────────────────────────────

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/accounts/{accountId}/change-orders",
      tags: TAGS,
      request: { params: accountIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsChangeOrderListResponseSchema,
            },
          },
          description:
            "The account's change orders, newest first; a precheck past 30 minutes is back at draft",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        return c.json(
          {
            orders: await changeOrderService.listChangeOrders(
              c.req.valid("param").accountId,
            ),
          },
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/accounts/{accountId}/change-orders",
      tags: TAGS,
      request: {
        params: accountIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsChangeOrderCreateBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsChangeOrderActionResponseSchema,
            },
          },
          description:
            "A rollback or manual change order at draft; plan drafts come from the plan confirmation",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        return c.json(
          changeOrderAction(
            await changeOrderService.createChangeOrder(
              c.req.valid("param").accountId,
              c.req.valid("json"),
            ),
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/xhs-ops/change-orders/{orderId}",
      tags: TAGS,
      request: { params: orderIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: xhsOpsChangeOrderResponseSchema },
          },
          description:
            "One change order; the card polls it while a phone step runs",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const order = await changeOrderService.getChangeOrder(
          c.req.valid("param").orderId,
        );
        const account = await store.getAccount(order.accountId);
        return c.json(
          { order, event: xhsOpsChangeOrderFinishedEvent({ order, account }) },
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/change-orders/{orderId}/precheck",
      tags: TAGS,
      request: {
        params: orderIdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: xhsOpsChangeOrderPrecheckBodySchema,
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsChangeOrderActionResponseSchema,
            },
          },
          description:
            "「预检」 started (status prechecking): read-only readback with the 号码核对, in the background",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        return c.json(
          changeOrderAction(
            await changeOrderService.precheck(
              c.req.valid("param").orderId,
              c.req.valid("json"),
            ),
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/change-orders/{orderId}/confirm",
      tags: TAGS,
      request: {
        params: orderIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsChangeOrderConfirmBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsChangeOrderActionResponseSchema,
            },
          },
          description:
            "「确认执行」 with the precheck digest and the required acks: the apply runs in the background",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        return c.json(
          changeOrderAction(
            await changeOrderService.confirm(
              c.req.valid("param").orderId,
              c.req.valid("json"),
            ),
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/change-orders/{orderId}/cancel",
      tags: TAGS,
      request: {
        params: orderIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsChangeOrderCancelBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsChangeOrderActionResponseSchema,
            },
          },
          description:
            "「取消」 of a draft or awaiting_confirm order no phone step has touched",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        return c.json(
          changeOrderAction(
            await changeOrderService.cancel(
              c.req.valid("param").orderId,
              c.req.valid("json"),
            ),
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/change-orders/{orderId}/verify",
      tags: TAGS,
      request: {
        params: orderIdParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsChangeOrderVerifyBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsChangeOrderActionResponseSchema,
            },
          },
          description:
            "「补跑核验」 of an interrupted order: verification only, nothing pushed or written",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        return c.json(
          changeOrderAction(
            await changeOrderService.verify(
              c.req.valid("param").orderId,
              c.req.valid("json"),
            ),
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/change-orders/{orderId}/visual-check",
      tags: TAGS,
      request: {
        params: orderIdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: xhsOpsChangeOrderVisualCheckBodySchema,
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsChangeOrderActionResponseSchema,
            },
          },
          description:
            "「图片一致 / 不一致」 for one image field, after verification or after the observation review",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        return c.json(
          changeOrderAction(
            await changeOrderService.visualCheck(
              c.req.valid("param").orderId,
              c.req.valid("json"),
            ),
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/change-orders/{orderId}/manual-check",
      tags: TAGS,
      request: {
        params: orderIdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: xhsOpsChangeOrderManualCheckBodySchema,
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsChangeOrderActionResponseSchema,
            },
          },
          description:
            "「已人工检查」 after the header counts moved: the order enters observation",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        return c.json(
          changeOrderAction(
            await changeOrderService.manualCheck(
              c.req.valid("param").orderId,
              c.req.valid("json"),
            ),
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/xhs-ops/change-orders/{orderId}/observation/review",
      tags: TAGS,
      request: {
        params: orderIdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: xhsOpsObservationReviewBodySchema,
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsChangeOrderActionResponseSchema,
            },
          },
          description:
            "「复查」 once the window ended: a review audit runs in the background and decides the verdict",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        return c.json(
          changeOrderAction(
            await changeOrderService.reviewObservation(
              c.req.valid("param").orderId,
              c.req.valid("json"),
            ),
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/api/v1/xhs-ops/change-orders/{orderId}/fields/{field}/image",
      tags: TAGS,
      request: {
        params: orderImageParamSchema,
        body: {
          content: {
            "application/json": { schema: xhsOpsChangeOrderImageBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: xhsOpsChangeOrderActionResponseSchema,
            },
          },
          description:
            "The user's picture for an image field (png, jpeg or webp, at most 10 MB); the order is a draft again",
        },
        ...takeoverErrors,
      },
    }),
    async (c) => {
      if (takeoverRecovering())
        return c.json({ message: TAKEOVER_RECOVERING_MESSAGE }, 503);
      try {
        const { orderId, field } = c.req.valid("param");
        return c.json(
          changeOrderAction(
            await changeOrderService.uploadImage(
              orderId,
              field,
              c.req.valid("json"),
            ),
          ),
          200,
        );
      } catch (err) {
        const mapped = mapError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );
}
