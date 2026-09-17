import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  xhsOpsAccountCreateSchema,
  xhsOpsAccountIdentityResponseSchema,
  xhsOpsAccountListResponseSchema,
  xhsOpsAccountResponseSchema,
  xhsOpsAccountTransferSchema,
  xhsOpsAccountUpdateSchema,
  xhsOpsCommentGenerateBodySchema,
  xhsOpsCommentGenerateResponseSchema,
  xhsOpsCommentListQuerySchema,
  xhsOpsCommentListResponseSchema,
  xhsOpsCommentQuotaResponseSchema,
  xhsOpsCommentResponseSchema,
  xhsOpsCommentReviewBodySchema,
  xhsOpsDeviceBindingListResponseSchema,
  xhsOpsPersonaGenerateBodySchema,
  xhsOpsPersonaGenerateResponseSchema,
  xhsOpsPersonasConfirmBodySchema,
  xhsOpsPlanSuggestResponseSchema,
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
} from "@nexu/shared";
import type { ControllerContainer } from "../app/container.js";
import { logger } from "../lib/logger.js";
import { ImageGenerationFailedError } from "../services/media-generation-service.js";
import {
  generateXhsOpsPersonas,
  generateXhsOpsProfile,
} from "../services/xhs-ops-persona-service.js";
import {
  XHS_OPS_DEFAULT_OFFLINE_AFTER_MS,
  XhsOpsError,
} from "../services/xhs-ops-run-service.js";
import type { ControllerBindings } from "../types.js";

const TAGS = ["XHS Ops"];
const projectIdParamSchema = z.object({ projectId: z.string() });
const accountIdParamSchema = z.object({ accountId: z.string() });
const runIdParamSchema = z.object({ runId: z.string() });
const errorSchema = z.object({ message: z.string() });

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
  } = container;
  const mutationErrors = {
    400: jsonError("Invalid request"),
    404: jsonError("Not found"),
    409: jsonError("Conflict"),
    500: jsonError("Failed"),
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
      },
    }),
    async (c) => {
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
      },
    }),
    async (c) => {
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
        return c.json({ message }, status);
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
      return c.json({ plans: await runService.suggestPlans(projectId) }, 200);
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
      },
    }),
    async (c) => {
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
        return c.json({ message: error.message }, error.status);
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
        409: jsonError("Device binding conflict or unfinished runs"),
        500: jsonError("Account update failed"),
      },
    }),
    async (c) => {
      try {
        const account = await store.updateAccount(
          c.req.valid("param").accountId,
          c.req.valid("json"),
        );
        if (!account) return c.json({ message: "账号不存在" }, 404);
        return c.json({ account }, 200);
      } catch (err) {
        const error = mapError(err);
        return c.json({ message: error.message }, error.status);
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
      },
    }),
    async (c) => {
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
}
