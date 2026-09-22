import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  createSessionSchema,
  sessionArchiveFilterSchema,
  sessionCheckpointListResponseSchema,
  sessionKindSchema,
  sessionListResponseSchema,
  sessionMessageBranchResponseSchema,
  sessionMessageRollbackResponseSchema,
  sessionOrganizationPatchSchema,
  sessionRecoveryBranchResponseSchema,
  sessionResponseSchema,
  sessionRunStateSchema,
  updateSessionSchema,
} from "@nexu/shared";
import type { ControllerContainer } from "../app/container.js";
import {
  SessionMessageNotFoundError,
  SessionsRuntimeUnavailableError,
} from "../runtime/sessions-runtime.js";
import type { ControllerBindings } from "../types.js";

const querySchema = z.object({
  botId: z.string().optional(),
  channelType: z.string().optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  archived: sessionArchiveFilterSchema.default("exclude"),
  category: z.string().optional(),
  kind: sessionKindSchema.optional(),
  runState: sessionRunStateSchema.optional(),
  pinned: z.enum(["true", "false"]).optional(),
  unread: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const sessionIdParamSchema = z.object({ id: z.string() });
const sessionCheckpointParamSchema = z.object({
  id: z.string(),
  checkpointId: z.string(),
});
const sessionMessageParamSchema = z.object({
  id: z.string(),
  messageId: z.string().min(1),
});
const errorSchema = z.object({ message: z.string() });

export function registerSessionRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/sessions",
      tags: ["Sessions", "Internal"],
      request: {
        body: {
          content: { "application/json": { schema: createSessionSchema } },
        },
      },
      responses: {
        201: {
          content: { "application/json": { schema: sessionResponseSchema } },
          description: "Created or updated session",
        },
      },
    }),
    async (c) =>
      c.json(
        await container.sessionService.createSession(c.req.valid("json")),
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/internal/sessions/{id}",
      tags: ["Sessions", "Internal"],
      request: {
        params: sessionIdParamSchema,
        body: {
          content: { "application/json": { schema: updateSessionSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: sessionResponseSchema } },
          description: "Updated session",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Not found",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await container.sessionService.updateSession(
        id,
        c.req.valid("json"),
      );
      if (!session) return c.json({ message: "Session not found" }, 404);
      return c.json(session, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/sessions",
      tags: ["Sessions"],
      request: { query: querySchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: sessionListResponseSchema },
          },
          description: "Session list",
        },
        503: {
          content: { "application/json": { schema: errorSchema } },
          description: "Session data temporarily unavailable",
        },
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const { pinned, unread, ...filters } = query;
      try {
        return c.json(
          await container.sessionService.listSessions({
            ...filters,
            ...(pinned !== undefined
              ? { pinned: String(pinned) === "true" }
              : {}),
            ...(unread !== undefined
              ? { unread: String(unread) === "true" }
              : {}),
          }),
          200,
        );
      } catch (error) {
        if (error instanceof SessionsRuntimeUnavailableError) {
          return c.json(
            { message: "Session data is temporarily unavailable" },
            503,
          );
        }
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/sessions/{id}",
      tags: ["Sessions"],
      request: { params: sessionIdParamSchema },
      responses: {
        200: {
          content: { "application/json": { schema: sessionResponseSchema } },
          description: "Session details",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Session not found",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await container.sessionService.getSession(id);
      if (session === null) {
        return c.json({ message: "Session not found" }, 404);
      }
      return c.json(session, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/sessions/{id}/reset",
      tags: ["Sessions"],
      request: { params: sessionIdParamSchema },
      responses: {
        200: {
          content: { "application/json": { schema: sessionResponseSchema } },
          description: "Reset session",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Not found",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await container.sessionService.resetSession(id);
      if (!session) return c.json({ message: "Session not found" }, 404);
      return c.json(session, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/sessions/{id}/messages",
      tags: ["Sessions"],
      request: {
        params: sessionIdParamSchema,
        query: z.object({
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                messages: z.array(
                  z.object({
                    id: z.string(),
                    role: z.enum(["user", "assistant", "toolResult"]),
                    content: z.unknown(),
                    timestamp: z.number().nullable(),
                    createdAt: z.string().nullable(),
                    aborted: z.boolean().optional(),
                    failed: z.boolean().optional(),
                    toolName: z.string().optional(),
                    toolCallId: z.string().optional(),
                  }),
                ),
                sessionKey: z.string().nullable(),
              }),
            },
          },
          description: "Chat messages for the session",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Session not found",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      const result = await container.sessionService.getChatHistory(id, limit);
      if (result.sessionKey === null) {
        return c.json({ message: "Session not found" }, 404);
      }
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/sessions/{id}/messages/{messageId}/branch",
      tags: ["Sessions"],
      request: { params: sessionMessageParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: sessionMessageBranchResponseSchema },
          },
          description:
            "Fork before a persisted user message and return its editable draft",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Session or message not found",
        },
        409: {
          content: { "application/json": { schema: errorSchema } },
          description: "Branch rejected while the session is running",
        },
      },
    }),
    async (c) => {
      const { id, messageId } = c.req.valid("param");
      try {
        const result = await container.sessionService.branchAtMessage(
          id,
          messageId,
        );
        if (!result) return c.json({ message: "Session not found" }, 404);
        return c.json(result, 200);
      } catch (error) {
        if (error instanceof SessionMessageNotFoundError) {
          return c.json({ message: error.message }, 404);
        }
        return c.json(
          { message: error instanceof Error ? error.message : String(error) },
          409,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/sessions/{id}/messages/{messageId}/rollback",
      tags: ["Sessions"],
      request: { params: sessionMessageParamSchema },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: sessionMessageRollbackResponseSchema,
            },
          },
          description:
            "Rewind before a persisted user message and return its editable draft",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Session or message not found",
        },
        409: {
          content: { "application/json": { schema: errorSchema } },
          description: "Rollback rejected while the session is running",
        },
      },
    }),
    async (c) => {
      const { id, messageId } = c.req.valid("param");
      try {
        const result = await container.sessionService.rollbackToMessage(
          id,
          messageId,
        );
        if (!result) return c.json({ message: "Session not found" }, 404);
        return c.json(result, 200);
      } catch (error) {
        if (error instanceof SessionMessageNotFoundError) {
          return c.json({ message: error.message }, 404);
        }
        return c.json(
          { message: error instanceof Error ? error.message : String(error) },
          409,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/sessions/{id}/organization",
      tags: ["Sessions"],
      request: {
        params: sessionIdParamSchema,
        body: {
          content: {
            "application/json": { schema: sessionOrganizationPatchSchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: z.object({ ok: z.boolean() }) },
          },
          description: "Updated session organization state",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Not found",
        },
        409: {
          content: { "application/json": { schema: errorSchema } },
          description: "Update rejected by OpenClaw",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const result = await container.sessionService.updateOrganization(
          id,
          c.req.valid("json"),
        );
        if (!result) return c.json({ message: "Session not found" }, 404);
        return c.json(result, 200);
      } catch (err) {
        return c.json(
          { message: err instanceof Error ? err.message : String(err) },
          409,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/sessions/{id}/checkpoints",
      tags: ["Sessions"],
      request: { params: sessionIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: sessionCheckpointListResponseSchema },
          },
          description: "Durable compaction checkpoints for a session",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Not found",
        },
        409: {
          content: { "application/json": { schema: errorSchema } },
          description: "Checkpoint list unavailable",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const result = await container.sessionService.listCheckpoints(id);
        if (!result) return c.json({ message: "Session not found" }, 404);
        return c.json(result, 200);
      } catch (err) {
        return c.json(
          { message: err instanceof Error ? err.message : String(err) },
          409,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/sessions/{id}/checkpoints/{checkpointId}/branch",
      tags: ["Sessions"],
      request: { params: sessionCheckpointParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: sessionRecoveryBranchResponseSchema },
          },
          description: "Non-destructive recovery branch",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Not found",
        },
        409: {
          content: { "application/json": { schema: errorSchema } },
          description: "Recovery branch rejected",
        },
      },
    }),
    async (c) => {
      const { id, checkpointId } = c.req.valid("param");
      try {
        const result = await container.sessionService.branchFromCheckpoint(
          id,
          checkpointId,
        );
        if (!result) return c.json({ message: "Session not found" }, 404);
        return c.json(result, 200);
      } catch (err) {
        return c.json(
          { message: err instanceof Error ? err.message : String(err) },
          409,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/sessions/{id}/archive",
      tags: ["Sessions"],
      request: {
        params: sessionIdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: z.object({ archived: z.boolean().default(true) }),
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: z.object({ ok: z.boolean() }) },
          },
          description: "Archive or unarchive a session",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Not found",
        },
        409: {
          content: { "application/json": { schema: errorSchema } },
          description: "Rejected by OpenClaw (main session or active run)",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { archived } = c.req.valid("json");
      try {
        const result = await container.sessionService.setSessionArchived(
          id,
          archived,
        );
        if (!result) return c.json({ message: "Session not found" }, 404);
        return c.json({ ok: true }, 200);
      } catch (err) {
        return c.json(
          { message: err instanceof Error ? err.message : String(err) },
          409,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/sessions/{id}/fork",
      tags: ["Sessions"],
      request: { params: sessionIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                id: z.string(),
                botId: z.string(),
                sessionKey: z.string(),
                title: z.string(),
              }),
            },
          },
          description: "Forked session (context inherited from parent)",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Not found",
        },
        409: {
          content: { "application/json": { schema: errorSchema } },
          description: "Fork rejected",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const forked = await container.sessionService.forkSession(id);
        if (!forked) return c.json({ message: "Session not found" }, 404);
        return c.json(forked, 200);
      } catch (err) {
        return c.json(
          { message: err instanceof Error ? err.message : String(err) },
          409,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/v1/sessions/{id}",
      tags: ["Sessions"],
      request: { params: sessionIdParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: z.object({ ok: z.boolean() }) },
          },
          description: "Delete session",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      return c.json(
        { ok: await container.sessionService.deleteSession(id) },
        200,
      );
    },
  );
}
