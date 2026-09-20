import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { ControllerContainer } from "../app/container.js";
import { logger } from "../lib/logger.js";
import {
  type ApprovalAuditService,
  approvalAuditEntrySchema,
} from "../services/approval-audit-service.js";
import { openClawModelsListResultSchema } from "../services/openclaw-gateway-service.js";
import type { ControllerBindings } from "../types.js";

const approvalDecisionSchema = z.enum(["allow-once", "allow-always", "deny"]);

const approvalSchema = z.object({
  id: z.string(),
  kind: z.enum(["exec", "plugin"]),
  category: z.enum([
    "controlled-terminal",
    "browser",
    "computer-use",
    "sensitive-tool",
  ]),
  title: z.string(),
  description: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  host: z.string().optional(),
  warning: z.string().optional(),
  riskKinds: z.array(z.string()),
  allowedDecisions: z.array(approvalDecisionSchema),
  agentId: z.string().optional(),
  sessionKey: z.string().optional(),
  createdAtMs: z.number(),
  expiresAtMs: z.number(),
});

const taskStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
]);

const timestampSchema = z.union([z.string(), z.number()]);

const taskSchema = z.object({
  id: z.string(),
  taskId: z.string().optional(),
  kind: z.string().optional(),
  runtime: z.string().optional(),
  status: taskStatusSchema,
  title: z.string().optional(),
  agentId: z.string().optional(),
  sessionKey: z.string().optional(),
  childSessionKey: z.string().optional(),
  ownerKey: z.string().optional(),
  parentTaskId: z.string().optional(),
  runId: z.string().optional(),
  flowId: z.string().optional(),
  sourceId: z.string().optional(),
  createdAt: timestampSchema.optional(),
  updatedAt: timestampSchema.optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
  progressSummary: z.string().optional(),
  terminalSummary: z.string().optional(),
  error: z.string().optional(),
});

const taskLifecycleSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "unknown",
]);

const taskGraphNodeSchema = z.object({
  id: z.string(),
  source: z.enum(["openclaw", "team"]),
  sourceId: z.string(),
  kind: z.string(),
  groupId: z.string(),
  title: z.string(),
  lifecycle: taskLifecycleSchema,
  rawStatus: z.string(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  flowId: z.string().optional(),
  sessionKey: z.string().optional(),
  teamId: z.string().optional(),
  teamName: z.string().optional(),
  cardId: z.string().optional(),
  agentId: z.string().optional(),
  createdAt: timestampSchema.optional(),
  updatedAt: timestampSchema.optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  cancellable: z.boolean(),
});

const taskGraphEdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(["depends_on", "parent_child", "executes"]),
});

const taskGraphSchema = z.object({
  available: z.boolean(),
  partial: z.boolean(),
  truncated: z.boolean(),
  totalNodes: z.number().int().nonnegative(),
  sources: z.object({
    openclaw: z.boolean(),
    team: z.boolean(),
  }),
  nodes: z.array(taskGraphNodeSchema),
  edges: z.array(taskGraphEdgeSchema),
});

const usageTotalsSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  totalCost: z.number(),
  missingCostEntries: z.number(),
});

const providerWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetAt: z.number().optional(),
});

const providerBillingSchema = z
  .object({
    type: z.enum(["balance", "spend", "budget"]),
    label: z.string().optional(),
    amount: z.number().optional(),
    used: z.number().optional(),
    limit: z.number().optional(),
    unit: z.string(),
    period: z.string().optional(),
    resetAt: z.number().optional(),
  })
  .passthrough();

const providerUsageSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  windows: z.array(providerWindowSchema),
  billing: z.array(providerBillingSchema).optional(),
  summary: z.string().optional(),
  plan: z.string().optional(),
  error: z.string().optional(),
});

const modelAuthSchema = z.object({
  status: z.enum(["ready", "needs-attention", "unavailable"]),
  availableModels: z.number(),
  configuredModels: z.number(),
});

const operationsResponseSchema = z.object({
  connected: z.boolean(),
  approvalsAvailable: z.boolean(),
  tasksAvailable: z.boolean(),
  usageAvailable: z.boolean(),
  providerUsageAvailable: z.boolean(),
  modelAuth: modelAuthSchema,
  approvals: z.array(approvalSchema),
  tasks: z.array(taskSchema),
  taskGraph: taskGraphSchema,
  usage: usageTotalsSchema.optional(),
  providers: z.array(providerUsageSchema),
  nextTaskCursor: z.string().optional(),
});

const runtimeApprovalsResponseSchema = z.object({
  connected: z.boolean(),
  available: z.boolean(),
  approvals: z.array(approvalSchema),
});

// ---- Cost usage (Gateway `usage.cost`) ------------------------------------
// Shape verified against a live openclaw 2026.9.4 gateway. Distinct from
// `usage.status`, which reports provider-side quota windows rather than spend.
const costBucketSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  totalCost: z.number(),
  inputCost: z.number(),
  outputCost: z.number(),
  cacheReadCost: z.number(),
  cacheWriteCost: z.number(),
  missingCostEntries: z.number(),
});

const costUsageResponseSchema = z.object({
  connected: z.boolean(),
  available: z.boolean(),
  days: z.number().optional(),
  updatedAt: z.number().optional(),
  totals: costBucketSchema.optional(),
  daily: z.array(costBucketSchema.extend({ date: z.string() })).optional(),
});

const rawCostUsageSchema = z.object({
  updatedAt: z.number(),
  days: z.number(),
  totals: costBucketSchema,
  daily: z.array(costBucketSchema.extend({ date: z.string() })),
});

// ---- Interactive questions (`ask_user`) -----------------------------------
// Mirrors the Gateway's QuestionRecord. `answers` is intentionally the wire
// shape (every value an array, even single-select) so the UI does not have to
// reason about two different envelopes.
const questionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

const questionItemSchema = z.object({
  questionId: z.string(),
  header: z.string(),
  question: z.string(),
  options: z.array(questionOptionSchema),
  multiSelect: z.boolean().optional(),
  isSecret: z.boolean().optional(),
});

const runtimeQuestionSchema = z.object({
  id: z.string(),
  questions: z.array(questionItemSchema),
  sessionKey: z.string().optional(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  createdAtMs: z.number(),
  expiresAtMs: z.number(),
  status: z.enum(["pending", "answered", "cancelled", "expired"]),
});

const runtimeQuestionsResponseSchema = z.object({
  connected: z.boolean(),
  available: z.boolean(),
  questions: z.array(runtimeQuestionSchema),
});

const rawQuestionListSchema = z.object({
  questions: z.array(runtimeQuestionSchema.passthrough()),
});

const recordSchema = z.record(z.unknown());
const rawApprovalSchema = z.object({
  id: z.string(),
  request: recordSchema,
  createdAtMs: z.number(),
  expiresAtMs: z.number(),
});
const rawApprovalListSchema = z.array(rawApprovalSchema);

const rawTaskListSchema = z.object({
  tasks: z.array(taskSchema.passthrough()),
  nextCursor: z.string().optional(),
});

const rawUsageSchema = z.object({
  totals: usageTotalsSchema.passthrough(),
});

const rawProviderUsageSchema = z.object({
  providers: z.array(providerUsageSchema.passthrough()),
});

const runtimeAuditEventSchema = z.object({
  eventId: z.string(),
  sequence: z.number().int().positive(),
  sourceSequence: z.number().int().positive(),
  occurredAt: z.number().int().nonnegative(),
  kind: z.enum(["agent_run", "tool_action"]),
  action: z.enum([
    "agent.run.started",
    "agent.run.finished",
    "tool.action.started",
    "tool.action.finished",
  ]),
  status: z.enum([
    "started",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "blocked",
    "unknown",
  ]),
  errorCode: z.string().optional(),
  actor: z.object({ type: z.enum(["agent", "system"]), id: z.string() }),
  agentId: z.string(),
  sessionKey: z.string().optional(),
  sessionId: z.string().optional(),
  runId: z.string(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  redaction: z.literal("metadata_only"),
});

const rawRuntimeAuditResultSchema = z.object({
  events: z.array(runtimeAuditEventSchema),
  nextCursor: z.string().optional(),
});

const runtimeAuditResponseSchema = z.object({
  connected: z.boolean(),
  historyAvailable: z.boolean(),
  runtimeAuditAvailable: z.boolean(),
  approvalHistory: z.array(approvalAuditEntrySchema),
  events: z.array(runtimeAuditEventSchema),
  nextCursor: z.string().optional(),
});

const deadLetterSchema = z.object({
  queueName: z.string(),
  count: z.number().int().nonnegative(),
  oldestFailedAt: z.number().int().nonnegative().optional(),
});

const rawDeadLetterSchema = deadLetterSchema.extend({
  oldestFailedAt: z.number().int().nonnegative().nullable().optional(),
});

const quarantineSchema = z.object({
  engineId: z.string(),
  owner: z.string().optional(),
  operation: z.string(),
  reason: z.string(),
  failedAt: z.number().int().nonnegative(),
});

const rawHealthRecoverySchema = z
  .object({
    deliveryQueues: z
      .object({ failed: z.array(rawDeadLetterSchema) })
      .optional(),
    contextEngines: z
      .object({ quarantined: z.array(quarantineSchema) })
      .optional(),
  })
  .passthrough();

const checkpointSchema = z.object({
  checkpointId: z.string(),
  sessionKey: z.string(),
  sessionId: z.string(),
  createdAt: z.number(),
  reason: z.enum([
    "manual",
    "auto-threshold",
    "overflow-retry",
    "timeout-retry",
  ]),
  tokensBefore: z.number().optional(),
  tokensAfter: z.number().optional(),
  summary: z.string().optional(),
});

const rawCheckpointListSchema = z.object({
  ok: z.boolean().optional(),
  key: z.string().optional(),
  checkpoints: z.array(checkpointSchema),
});

const rawCheckpointRestoreSchema = z
  .object({
    ok: z.literal(true),
    key: z.string(),
    sessionId: z.string(),
    checkpoint: checkpointSchema.passthrough(),
    entry: z
      .object({
        sessionId: z.string(),
        updatedAt: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

// A restore that lands on a different session, checkpoint, or session id than
// the one that was asked for is a broken runtime contract, not a rejected
// request. Name the failing field so the two are distinguishable in a log.
function findCheckpointRestoreIdentityMismatch(
  data: z.infer<typeof rawCheckpointRestoreSchema>,
  expected: { sessionKey: string; checkpointId: string },
): string | null {
  if (data.key !== expected.sessionKey) return "key";
  if (data.checkpoint.checkpointId !== expected.checkpointId) {
    return "checkpoint.checkpointId";
  }
  if (data.checkpoint.sessionKey !== expected.sessionKey) {
    return "checkpoint.sessionKey";
  }
  if (data.checkpoint.sessionId !== data.sessionId) {
    return "checkpoint.sessionId";
  }
  if (data.entry.sessionId !== data.sessionId) return "entry.sessionId";
  return null;
}

const recoveryResponseSchema = z.object({
  connected: z.boolean(),
  healthAvailable: z.boolean(),
  deadLettersAvailable: z.boolean(),
  deadLetterReplayAvailable: z.literal(false),
  stateIsolationAvailable: z.boolean(),
  quarantineClearAvailable: z.literal(false),
  snapshotsAvailable: z.boolean(),
  deadLetters: z.array(deadLetterSchema),
  quarantined: z.array(quarantineSchema),
  checkpoints: z.array(checkpointSchema),
});

type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
type Approval = z.infer<typeof approvalSchema>;

function approvalCategory(
  request: Record<string, unknown>,
  kind: "exec" | "plugin",
): Approval["category"] {
  if (kind === "exec") return "controlled-terminal";
  const searchable = [
    optionalString(request, "title"),
    optionalString(request, "description"),
    optionalString(request, "pluginId"),
    optionalString(request, "toolName"),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase();
  if (searchable.includes("browser")) return "browser";
  if (
    searchable.includes("computer") ||
    searchable.includes("peekaboo") ||
    searchable.includes("cua")
  ) {
    return "computer-use";
  }
  return "sensitive-tool";
}

function optionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function approvalDecisions(
  request: Record<string, unknown>,
): ApprovalDecision[] {
  const parsed = z
    .array(approvalDecisionSchema)
    .safeParse(request.allowedDecisions);
  return parsed.success ? parsed.data : ["allow-once", "deny"];
}

function approvalRiskKinds(request: Record<string, unknown>): string[] {
  const parsed = recordSchema.safeParse(request.commandAnalysis);
  return parsed.success ? stringArray(parsed.data, "riskKinds") : [];
}

function mapApproval(
  input: z.infer<typeof rawApprovalSchema>,
  kind: "exec" | "plugin",
): Approval {
  const title =
    kind === "exec"
      ? (optionalString(input.request, "commandPreview") ??
        optionalString(input.request, "command") ??
        "Command approval")
      : (optionalString(input.request, "title") ?? "Tool approval");

  return {
    id: input.id,
    kind,
    category: approvalCategory(input.request, kind),
    title,
    ...(optionalString(input.request, "description")
      ? { description: optionalString(input.request, "description") }
      : {}),
    ...(optionalString(input.request, "command")
      ? { command: optionalString(input.request, "command") }
      : {}),
    ...(optionalString(input.request, "cwd")
      ? { cwd: optionalString(input.request, "cwd") }
      : {}),
    ...(optionalString(input.request, "host")
      ? { host: optionalString(input.request, "host") }
      : {}),
    ...(optionalString(input.request, "warningText")
      ? { warning: optionalString(input.request, "warningText") }
      : {}),
    riskKinds: approvalRiskKinds(input.request),
    allowedDecisions: approvalDecisions(input.request),
    ...(optionalString(input.request, "agentId")
      ? { agentId: optionalString(input.request, "agentId") }
      : {}),
    ...(optionalString(input.request, "sessionKey")
      ? { sessionKey: optionalString(input.request, "sessionKey") }
      : {}),
    createdAtMs: input.createdAtMs,
    expiresAtMs: input.expiresAtMs,
  };
}

function parseApprovals(
  result: PromiseSettledResult<unknown>,
  kind: "exec" | "plugin",
): { approvals: Approval[]; available: boolean } {
  if (result.status !== "fulfilled") {
    return { approvals: [], available: false };
  }
  const parsed = rawApprovalListSchema.safeParse(result.value);
  return parsed.success
    ? {
        approvals: parsed.data.map((approval) => mapApproval(approval, kind)),
        available: true,
      }
    : { approvals: [], available: false };
}

function persistPendingApprovalsBestEffort(
  approvalAudit: Pick<ApprovalAuditService, "recordRequested"> | undefined,
  approvals: Approval[],
) {
  if (!approvalAudit) return;
  for (const approval of approvals) {
    void approvalAudit
      .recordRequested({
        approvalId: approval.id,
        source: "openclaw",
        kind: approval.kind,
        title:
          approval.kind === "exec" ? "Command approval" : "Plugin approval",
        ...(approval.agentId ? { agentId: approval.agentId } : {}),
        ...(approval.sessionKey ? { sessionKey: approval.sessionKey } : {}),
        requestedAt: approval.createdAtMs,
        expiresAt: approval.expiresAtMs,
      })
      .catch((error: unknown) => {
        logger.warn(
          {
            approvalId: approval.id,
            kind: approval.kind,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "approval_audit_request_persist_failed",
        );
      });
  }
}

type RuntimeTask = z.infer<typeof taskSchema>;
type TaskGraphNode = z.infer<typeof taskGraphNodeSchema>;
type TaskGraphEdge = z.infer<typeof taskGraphEdgeSchema>;
type TeamBoardSnapshot = {
  teamId: string;
  teamName: string;
  available: boolean;
  cards: Array<{
    id: string;
    title: string;
    status: string;
    agentId?: string | null;
    output?: string | null;
    sessionKey?: string | null;
    parentIds?: string[];
  }>;
};

type LinkedTeamCard = TeamBoardSnapshot["cards"][number] & {
  teamId: string;
  teamName: string;
};

function taskExecutionKeys(task: RuntimeTask): string[] {
  return [task.childSessionKey, task.sessionKey, task.ownerKey].filter(
    (value): value is string => Boolean(value),
  );
}

function openClawTaskLifecycle(
  status: RuntimeTask["status"],
): z.infer<typeof taskLifecycleSchema> {
  if (status === "completed") return "succeeded";
  return status;
}

function teamTaskLifecycle(
  status: string,
): z.infer<typeof taskLifecycleSchema> {
  switch (status) {
    case "running":
      return "running";
    case "review":
      return "waiting";
    case "blocked":
      return "blocked";
    case "done":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "triage":
    case "backlog":
    case "todo":
    case "scheduled":
    case "ready":
      return "queued";
    default:
      return "unknown";
  }
}

function buildTaskGraph(input: {
  tasks: RuntimeTask[];
  openClawAvailable: boolean;
  openClawTruncated: boolean;
  teamBoards: TeamBoardSnapshot[];
  teamSourceAvailable: boolean;
}) {
  const teamCardBySessionKey = new Map<string, LinkedTeamCard>();
  for (const board of input.teamBoards) {
    for (const card of board.cards) {
      if (card.sessionKey) {
        teamCardBySessionKey.set(card.sessionKey, {
          ...card,
          teamId: board.teamId,
          teamName: board.teamName,
        });
      }
    }
  }

  const linkedTeamCardByTaskId = new Map<string, LinkedTeamCard>();
  const nodes: TaskGraphNode[] = input.tasks.map((task) => {
    const linkedCard = taskExecutionKeys(task)
      .map((sessionKey) => teamCardBySessionKey.get(sessionKey))
      .find((card): card is LinkedTeamCard => Boolean(card));
    if (linkedCard) {
      linkedTeamCardByTaskId.set(task.id, linkedCard);
    }
    const executionSessionKey = linkedCard?.sessionKey ?? task.sessionKey;
    return {
      id: `openclaw:${task.id}`,
      source: "openclaw",
      sourceId: task.id,
      kind: task.kind ?? task.runtime ?? "task",
      groupId: linkedCard
        ? `team:${linkedCard.teamId}`
        : `openclaw:${task.flowId ?? task.sessionKey ?? task.ownerKey ?? task.id}`,
      title: task.title ?? task.kind ?? task.runtime ?? "OpenClaw task",
      lifecycle: openClawTaskLifecycle(task.status),
      rawStatus: task.status,
      taskId: task.taskId ?? task.id,
      ...(task.runId ? { runId: task.runId } : {}),
      ...(task.flowId ? { flowId: task.flowId } : {}),
      ...(executionSessionKey ? { sessionKey: executionSessionKey } : {}),
      ...(linkedCard
        ? {
            teamId: linkedCard.teamId,
            teamName: linkedCard.teamName,
            cardId: linkedCard.id,
          }
        : {}),
      ...(task.agentId ? { agentId: task.agentId } : {}),
      ...(task.createdAt !== undefined ? { createdAt: task.createdAt } : {}),
      ...(task.updatedAt !== undefined ? { updatedAt: task.updatedAt } : {}),
      ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
      ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
      ...(task.terminalSummary || task.progressSummary
        ? { output: task.terminalSummary ?? task.progressSummary }
        : {}),
      ...(task.error ? { error: task.error } : {}),
      cancellable: task.status === "queued" || task.status === "running",
    };
  });

  for (const board of input.teamBoards) {
    for (const card of board.cards) {
      nodes.push({
        id: `team:${board.teamId}:${card.id}`,
        source: "team",
        sourceId: card.id,
        kind: "team-task",
        groupId: `team:${board.teamId}`,
        title: card.title,
        lifecycle: teamTaskLifecycle(card.status),
        rawStatus: card.status,
        teamId: board.teamId,
        teamName: board.teamName,
        cardId: card.id,
        ...(card.agentId ? { agentId: card.agentId } : {}),
        ...(card.sessionKey ? { sessionKey: card.sessionKey } : {}),
        ...(card.output ? { output: card.output } : {}),
        cancellable: false,
      });
    }
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: TaskGraphEdge[] = [];
  for (const task of input.tasks) {
    if (!task.parentTaskId) continue;
    const from = `openclaw:${task.parentTaskId}`;
    const to = `openclaw:${task.id}`;
    if (nodeIds.has(from) && nodeIds.has(to)) {
      edges.push({
        id: `parent-child:${from}:${to}`,
        from,
        to,
        kind: "parent_child",
      });
    }
  }
  for (const task of input.tasks) {
    const linkedCard = linkedTeamCardByTaskId.get(task.id);
    if (!linkedCard) continue;
    const from = `team:${linkedCard.teamId}:${linkedCard.id}`;
    const to = `openclaw:${task.id}`;
    if (nodeIds.has(from) && nodeIds.has(to)) {
      edges.push({
        id: `executes:${from}:${to}`,
        from,
        to,
        kind: "executes",
      });
    }
  }
  for (const board of input.teamBoards) {
    for (const card of board.cards) {
      for (const parentId of card.parentIds ?? []) {
        const from = `team:${board.teamId}:${parentId}`;
        const to = `team:${board.teamId}:${card.id}`;
        if (nodeIds.has(from) && nodeIds.has(to)) {
          edges.push({
            id: `depends-on:${from}:${to}`,
            from,
            to,
            kind: "depends_on",
          });
        }
      }
    }
  }

  const teamBoardsAvailable = input.teamBoards.every(
    (board) => board.available,
  );
  const teamAvailable = input.teamSourceAvailable && teamBoardsAvailable;
  return taskGraphSchema.parse({
    available: input.openClawAvailable || teamAvailable,
    partial:
      !input.openClawAvailable || !teamAvailable || input.openClawTruncated,
    truncated: input.openClawTruncated,
    totalNodes: nodes.length,
    sources: {
      openclaw: input.openClawAvailable,
      team: teamAvailable,
    },
    nodes,
    edges,
  });
}

export function registerRuntimeOperationsRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/runtime/operations",
      tags: ["Runtime Operations"],
      request: {
        query: z.object({
          sessionKey: z.string().optional(),
          agentId: z.string().optional(),
        }),
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: operationsResponseSchema },
          },
          description: "Sanitized desktop operation status",
        },
      },
    }),
    async (c) => {
      const { sessionKey, agentId } = c.req.valid("query");
      if (!container.gatewayService.isConnected()) {
        return c.json(
          {
            connected: false,
            approvalsAvailable: false,
            tasksAvailable: false,
            usageAvailable: false,
            providerUsageAvailable: false,
            modelAuth: {
              status: "unavailable" as const,
              availableModels: 0,
              configuredModels: 0,
            },
            approvals: [],
            tasks: [],
            taskGraph: {
              available: false,
              partial: false,
              truncated: false,
              totalNodes: 0,
              sources: { openclaw: false, team: false },
              nodes: [],
              edges: [],
            },
            providers: [],
          },
          200,
        );
      }

      const teams = container.teamService.listTeams();
      const scopedTasksRequest = container.gatewayService.listTasks({
        ...(sessionKey ? { sessionKey } : {}),
        ...(agentId ? { agentId } : {}),
        limit: 100,
      });
      const graphTasksRequest =
        sessionKey || agentId
          ? container.gatewayService.listTasks({ limit: 100 })
          : scopedTasksRequest;
      const [
        execApprovals,
        pluginApprovals,
        tasks,
        graphTasks,
        usage,
        providers,
        modelCatalog,
        teamBoards,
      ] = await Promise.allSettled([
        container.gatewayService.listExecApprovals(),
        container.gatewayService.listPluginApprovals(),
        scopedTasksRequest,
        graphTasksRequest,
        sessionKey
          ? container.gatewayService.getSessionUsage({
              key: sessionKey,
              ...(agentId ? { agentId } : {}),
              includeContextWeight: true,
            })
          : Promise.reject(new Error("session key unavailable")),
        container.gatewayService.getProviderUsage(),
        container.gatewayService.listModels("configured"),
        Promise.all(
          teams.map(async (team) => ({
            teamId: team.id,
            teamName: team.name,
            ...(await container.teamService.getBoard(team.id)),
          })),
        ),
      ]);

      const parsedTasks =
        tasks.status === "fulfilled"
          ? rawTaskListSchema.safeParse(tasks.value)
          : null;
      const parsedGraphTasks =
        graphTasks.status === "fulfilled"
          ? rawTaskListSchema.safeParse(graphTasks.value)
          : null;
      const parsedUsage =
        usage.status === "fulfilled"
          ? rawUsageSchema.safeParse(usage.value)
          : null;
      const parsedProviders =
        providers.status === "fulfilled"
          ? rawProviderUsageSchema.safeParse(providers.value)
          : null;
      const parsedModelCatalog =
        modelCatalog.status === "fulfilled"
          ? openClawModelsListResultSchema.safeParse(modelCatalog.value)
          : null;
      const parsedExecApprovals = parseApprovals(execApprovals, "exec");
      const parsedPluginApprovals = parseApprovals(pluginApprovals, "plugin");
      const pendingApprovals = [
        ...parsedExecApprovals.approvals,
        ...parsedPluginApprovals.approvals,
      ].sort((left, right) => left.expiresAtMs - right.expiresAtMs);
      persistPendingApprovalsBestEffort(
        container.approvalAuditService,
        pendingApprovals,
      );
      const configuredModels = parsedModelCatalog?.success
        ? parsedModelCatalog.data.models
        : [];
      const availableModels = configuredModels.filter(
        (model) => model.available === true,
      );
      const runtimeTasks = parsedTasks?.success ? parsedTasks.data.tasks : [];
      const graphRuntimeTasks = parsedGraphTasks?.success
        ? parsedGraphTasks.data.tasks
        : [];
      const taskGraph = buildTaskGraph({
        tasks: graphRuntimeTasks,
        openClawAvailable: parsedGraphTasks?.success === true,
        openClawTruncated:
          parsedGraphTasks?.success === true &&
          parsedGraphTasks.data.nextCursor !== undefined,
        teamBoards:
          teamBoards.status === "fulfilled"
            ? (teamBoards.value as TeamBoardSnapshot[])
            : [],
        teamSourceAvailable: teamBoards.status === "fulfilled",
      });

      return c.json(
        {
          connected: true,
          approvalsAvailable:
            parsedExecApprovals.available && parsedPluginApprovals.available,
          tasksAvailable: parsedTasks?.success === true,
          usageAvailable: parsedUsage?.success === true,
          providerUsageAvailable: parsedProviders?.success === true,
          modelAuth: {
            status:
              parsedModelCatalog?.success !== true
                ? ("unavailable" as const)
                : availableModels.length > 0
                  ? ("ready" as const)
                  : ("needs-attention" as const),
            availableModels: availableModels.length,
            configuredModels: configuredModels.length,
          },
          approvals: pendingApprovals,
          tasks: runtimeTasks,
          taskGraph,
          ...(parsedUsage?.success ? { usage: parsedUsage.data.totals } : {}),
          providers: parsedProviders?.success
            ? parsedProviders.data.providers
            : [],
          ...(parsedTasks?.success && parsedTasks.data.nextCursor
            ? { nextTaskCursor: parsedTasks.data.nextCursor }
            : {}),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/runtime/cost",
      tags: ["Runtime Operations"],
      request: {
        query: z.object({
          days: z.coerce.number().int().min(1).max(365).optional(),
        }),
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: costUsageResponseSchema },
          },
          description: "Token and cost rollup from the OpenClaw usage ledger",
        },
      },
    }),
    async (c) => {
      if (!container.gatewayService.isConnected()) {
        return c.json({ connected: false, available: false }, 200);
      }
      const { days } = c.req.valid("query");
      try {
        const raw = await container.gatewayService.getCostUsage(
          days === undefined ? undefined : { days },
        );
        const parsed = rawCostUsageSchema.safeParse(raw);
        if (!parsed.success) {
          return c.json({ connected: true, available: false }, 200);
        }
        return c.json(
          { connected: true, available: true, ...parsed.data },
          200,
        );
      } catch {
        return c.json({ connected: true, available: false }, 200);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/runtime/questions",
      tags: ["Runtime Operations"],
      responses: {
        200: {
          content: {
            "application/json": { schema: runtimeQuestionsResponseSchema },
          },
          description: "Pending interactive agent questions",
        },
      },
    }),
    async (c) => {
      if (!container.gatewayService.isConnected()) {
        return c.json(
          { connected: false, available: false, questions: [] },
          200,
        );
      }

      try {
        const raw = await container.gatewayService.listQuestions();
        const parsed = rawQuestionListSchema.safeParse(raw);
        if (!parsed.success) {
          return c.json(
            { connected: true, available: false, questions: [] },
            200,
          );
        }
        // Only pending records are actionable; resolved ones are kept by the
        // Gateway briefly so other surfaces can show the answer summary.
        const questions = parsed.data.questions
          .filter((question) => question.status === "pending")
          .sort((left, right) => left.expiresAtMs - right.expiresAtMs);
        return c.json({ connected: true, available: true, questions }, 200);
      } catch {
        return c.json(
          { connected: true, available: false, questions: [] },
          200,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/runtime/questions/{questionId}/resolve",
      tags: ["Runtime Operations"],
      request: {
        params: z.object({ questionId: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                // Omit `answers` (or send `skip: true`) to decline the prompt.
                answers: z.record(z.string(), z.array(z.string())).optional(),
                skip: z.boolean().optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: z.object({ ok: z.literal(true) }) },
          },
          description: "Question answered or declined",
        },
        409: {
          content: {
            "application/json": { schema: z.object({ message: z.string() }) },
          },
          description: "Runtime unavailable, or the question already resolved",
        },
      },
    }),
    async (c) => {
      if (!container.gatewayService.isConnected()) {
        throw new HTTPException(409, {
          message: "OpenClaw gateway is not connected",
        });
      }
      const { questionId } = c.req.valid("param");
      const body = c.req.valid("json");
      try {
        if (body.skip === true || body.answers === undefined) {
          await container.gatewayService.cancelQuestion({ id: questionId });
        } else {
          await container.gatewayService.answerQuestion({
            id: questionId,
            answers: body.answers,
          });
        }
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        throw new HTTPException(409, {
          message:
            error instanceof Error
              ? error.message
              : "Failed to resolve the question",
        });
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/runtime/approvals",
      tags: ["Runtime Operations"],
      responses: {
        200: {
          content: {
            "application/json": { schema: runtimeApprovalsResponseSchema },
          },
          description: "Pending sanitized runtime approvals",
        },
      },
    }),
    async (c) => {
      if (!container.gatewayService.isConnected()) {
        return c.json(
          { connected: false, available: false, approvals: [] },
          200,
        );
      }

      const [execApprovals, pluginApprovals] = await Promise.allSettled([
        container.gatewayService.listExecApprovals(),
        container.gatewayService.listPluginApprovals(),
      ]);
      const parsedExecApprovals = parseApprovals(execApprovals, "exec");
      const parsedPluginApprovals = parseApprovals(pluginApprovals, "plugin");
      const approvals = [
        ...parsedExecApprovals.approvals,
        ...parsedPluginApprovals.approvals,
      ].sort((left, right) => left.expiresAtMs - right.expiresAtMs);
      persistPendingApprovalsBestEffort(
        container.approvalAuditService,
        approvals,
      );

      return c.json(
        {
          connected: true,
          available:
            parsedExecApprovals.available && parsedPluginApprovals.available,
          approvals,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/runtime/approvals/{approvalId}/resolve",
      tags: ["Runtime Operations"],
      request: {
        params: z.object({ approvalId: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                kind: z.enum(["exec", "plugin"]),
                decision: approvalDecisionSchema,
              }),
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: z.object({ ok: z.literal(true) }) },
          },
          description: "Approval resolved",
        },
        409: {
          content: {
            "application/json": { schema: z.object({ message: z.string() }) },
          },
          description: "Runtime unavailable or approval expired",
        },
      },
    }),
    async (c) => {
      if (!container.gatewayService.isConnected()) {
        throw new HTTPException(409, {
          message: "OpenClaw gateway is not connected",
        });
      }
      const { approvalId } = c.req.valid("param");
      const body = c.req.valid("json");
      try {
        await container.gatewayService.resolveApproval({
          id: approvalId,
          kind: body.kind,
          decision: body.decision,
        });
      } catch (error) {
        logger.warn(
          {
            approvalId,
            kind: body.kind,
            decision: body.decision,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "approval_resolve_failed",
        );
        throw new HTTPException(409, {
          message: "Approval expired or could not be resolved",
        });
      }
      try {
        const reviewer = await container.configStore
          .getLocalProfile()
          .then((profile) => profile.name)
          .catch(() => undefined);
        await container.approvalAuditService.recordResolved({
          approvalId,
          source: "openclaw",
          kind: body.kind,
          status: body.decision === "deny" ? "denied" : "approved",
          decision: body.decision,
          reviewer,
        });
      } catch (error) {
        logger.warn(
          {
            approvalId,
            kind: body.kind,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "approval_audit_resolution_persist_failed",
        );
      }
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/runtime/audit",
      tags: ["Runtime Operations"],
      request: {
        query: z.object({
          sessionKey: z.string().optional(),
          agentId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          cursor: z.string().optional(),
        }),
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: runtimeAuditResponseSchema },
          },
          description:
            "Persistent approval history and metadata-only runtime audit",
        },
      },
    }),
    async (c) => {
      const { sessionKey, agentId, limit, cursor } = c.req.valid("query");
      const connected = container.gatewayService.isConnected();
      const [history, runtimeAudit] = await Promise.allSettled([
        container.approvalAuditService.list({ limit }),
        connected
          ? container.gatewayService.listAudit({
              ...(sessionKey ? { sessionKey } : {}),
              ...(agentId ? { agentId } : {}),
              ...(cursor ? { cursor } : {}),
              limit,
            })
          : Promise.reject(new Error("gateway disconnected")),
      ]);
      const parsedRuntimeAudit =
        runtimeAudit.status === "fulfilled"
          ? rawRuntimeAuditResultSchema.safeParse(runtimeAudit.value)
          : null;
      return c.json(
        {
          connected,
          historyAvailable: history.status === "fulfilled",
          runtimeAuditAvailable: parsedRuntimeAudit?.success === true,
          approvalHistory: history.status === "fulfilled" ? history.value : [],
          events: parsedRuntimeAudit?.success
            ? parsedRuntimeAudit.data.events
            : [],
          ...(parsedRuntimeAudit?.success && parsedRuntimeAudit.data.nextCursor
            ? { nextCursor: parsedRuntimeAudit.data.nextCursor }
            : {}),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/runtime/recovery",
      tags: ["Runtime Operations"],
      request: {
        query: z.object({
          sessionKey: z.string().optional(),
          agentId: z.string().optional(),
        }),
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: recoveryResponseSchema },
          },
          description:
            "Persistent delivery, isolation, and snapshot recovery state",
        },
      },
    }),
    async (c) => {
      const { sessionKey, agentId } = c.req.valid("query");
      if (!container.gatewayService.isConnected()) {
        return c.json(
          {
            connected: false,
            healthAvailable: false,
            deadLettersAvailable: false,
            deadLetterReplayAvailable: false as const,
            stateIsolationAvailable: false,
            quarantineClearAvailable: false as const,
            snapshotsAvailable: false,
            deadLetters: [],
            quarantined: [],
            checkpoints: [],
          },
          200,
        );
      }

      const [health, checkpoints] = await Promise.allSettled([
        container.gatewayService.getGatewayHealthSnapshot({
          timeoutMs: 8_000,
          probe: false,
        }),
        sessionKey
          ? container.gatewayService.sessionsCompactionList({
              key: sessionKey,
              ...(agentId ? { agentId } : {}),
            })
          : Promise.reject(new Error("session key unavailable")),
      ]);
      const parsedHealth =
        health.status === "fulfilled"
          ? rawHealthRecoverySchema.safeParse(health.value)
          : null;
      const parsedCheckpoints =
        checkpoints.status === "fulfilled"
          ? rawCheckpointListSchema.safeParse(checkpoints.value)
          : null;
      const deadLettersAvailable =
        parsedHealth?.success === true &&
        parsedHealth.data.deliveryQueues !== undefined;
      const stateIsolationAvailable =
        parsedHealth?.success === true &&
        parsedHealth.data.contextEngines !== undefined;
      return c.json(
        {
          connected: true,
          healthAvailable: parsedHealth?.success === true,
          deadLettersAvailable,
          deadLetterReplayAvailable: false as const,
          stateIsolationAvailable,
          quarantineClearAvailable: false as const,
          snapshotsAvailable: parsedCheckpoints?.success === true,
          deadLetters: parsedHealth?.success
            ? (parsedHealth.data.deliveryQueues?.failed ?? []).map(
                (deadLetter) => ({
                  queueName: deadLetter.queueName,
                  count: deadLetter.count,
                  ...(deadLetter.oldestFailedAt != null
                    ? { oldestFailedAt: deadLetter.oldestFailedAt }
                    : {}),
                }),
              )
            : [],
          quarantined: parsedHealth?.success
            ? (parsedHealth.data.contextEngines?.quarantined ?? [])
            : [],
          checkpoints: parsedCheckpoints?.success
            ? parsedCheckpoints.data.checkpoints
            : [],
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/runtime/recovery/checkpoints/{checkpointId}/restore",
      tags: ["Runtime Operations"],
      request: {
        params: z.object({ checkpointId: z.string().min(1) }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                sessionKey: z.string().min(1),
                agentId: z.string().optional(),
                confirm: z.literal(true),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                ok: z.literal(true),
                key: z.string(),
                sessionId: z.string(),
                checkpoint: checkpointSchema,
                entry: z.object({
                  sessionId: z.string(),
                  updatedAt: z.number(),
                }),
              }),
            },
          },
          description: "Session restored to the selected durable checkpoint",
        },
        409: {
          content: {
            "application/json": { schema: z.object({ message: z.string() }) },
          },
          description: "Runtime unavailable, session active, or restore failed",
        },
      },
    }),
    async (c) => {
      if (!container.gatewayService.isConnected()) {
        throw new HTTPException(409, {
          message: "OpenClaw gateway is not connected",
        });
      }
      const { checkpointId } = c.req.valid("param");
      const { sessionKey, agentId } = c.req.valid("json");
      if (container.sessionRunRegistry.isBusy(sessionKey)) {
        throw new HTTPException(409, {
          message: "Cannot restore a session while a run is active",
        });
      }

      let restored: unknown;
      try {
        restored = await container.gatewayService.sessionsCompactionRestore({
          key: sessionKey,
          ...(agentId ? { agentId } : {}),
          checkpointId,
        });
      } catch (error) {
        logger.warn(
          {
            checkpointId,
            sessionKey,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "checkpoint_restore_gateway_call_failed",
        );
        throw new HTTPException(409, {
          message: "Checkpoint restore failed",
        });
      }

      const parsed = rawCheckpointRestoreSchema.safeParse(restored);
      const mismatch = parsed.success
        ? findCheckpointRestoreIdentityMismatch(parsed.data, {
            sessionKey,
            checkpointId,
          })
        : "unparseable-response";
      if (!parsed.success || mismatch) {
        logger.warn(
          { checkpointId, sessionKey, reason: mismatch },
          "checkpoint_restore_identity_mismatch",
        );
        throw new HTTPException(409, {
          message: "Checkpoint restore failed",
        });
      }

      return c.json(
        {
          ok: true as const,
          key: parsed.data.key,
          sessionId: parsed.data.sessionId,
          checkpoint: checkpointSchema.parse(parsed.data.checkpoint),
          entry: {
            sessionId: parsed.data.entry.sessionId,
            updatedAt: parsed.data.entry.updatedAt,
          },
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/runtime/tasks/{taskId}/cancel",
      tags: ["Runtime Operations"],
      request: {
        params: z.object({ taskId: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({ reason: z.string().max(500).optional() }),
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                found: z.boolean(),
                cancelled: z.boolean(),
                reason: z.string().optional(),
              }),
            },
          },
          description: "Task cancellation result",
        },
        409: {
          content: {
            "application/json": { schema: z.object({ message: z.string() }) },
          },
          description: "Runtime unavailable",
        },
      },
    }),
    async (c) => {
      if (!container.gatewayService.isConnected()) {
        throw new HTTPException(409, {
          message: "OpenClaw gateway is not connected",
        });
      }
      const { taskId } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const raw = await container.gatewayService.cancelTask({
        taskId,
        ...(reason ? { reason } : {}),
      });
      const parsed = z
        .object({
          found: z.boolean(),
          cancelled: z.boolean(),
          reason: z.string().optional(),
        })
        .safeParse(raw);
      if (!parsed.success) {
        throw new HTTPException(409, { message: "Task cancellation failed" });
      }
      return c.json(parsed.data, 200);
    },
  );
}
