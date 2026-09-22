import type { SessionResponse } from "@nexu/shared";

/** Read through the gateway so OpenClaw retains ownership of its SQLite schema. */
export interface SessionsGatewayReader {
  listStoredSessions(): Promise<{ sessions?: unknown[] }>;
  getStoredChatHistory(
    sessionKey: string,
    limit?: number,
    sessionId?: string,
    offset?: number,
  ): Promise<{
    messages?: unknown[];
    totalMessages?: number;
    hasMore?: boolean;
    nextOffset?: number;
  }>;
  sessionsPatch(params: {
    key: string;
    agentId?: string;
    label?: string | null;
  }): Promise<unknown>;
  sessionsReset(params: {
    key: string;
    agentId?: string;
    reason?: "new" | "reset";
  }): Promise<unknown>;
  sessionsDelete(params: { key: string; agentId?: string }): Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  const millis =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15
    ? millis
    : undefined;
}

export function sessionFromGatewayRow(value: unknown): SessionResponse | null {
  const row = asRecord(value);
  const sessionKey = stringValue(row.key);
  const sessionId = stringValue(row.sessionId);
  const botId = sessionKey?.match(/^agent:([^:]+):/i)?.[1];
  const origin = asRecord(row.origin);
  if (
    !sessionKey ||
    !sessionId ||
    !botId ||
    botId === "main" ||
    sessionKey.includes(":subagent:") ||
    sessionKey.includes(":openai:") ||
    origin.provider === "heartbeat"
  ) {
    return null;
  }

  const updatedAt = timestamp(row.updatedAt) ?? timestamp(row.createdAt) ?? 0;
  const archivedAt = timestamp(row.archivedAt);
  const delivery = asRecord(row.deliveryContext);
  const generatedTitle =
    stringValue(row.derivedTitle) ??
    stringValue(row.displayName) ??
    stringValue(row.subject);
  // Generated previews may truncate an injected directive before its closing
  // bracket. Do not show that partial instruction as a conversation title.
  const safeGeneratedTitle =
    generatedTitle && !/^\[(?:路由提示：|请使用「)/u.test(generatedTitle.trim())
      ? generatedTitle
      : "New conversation";
  const session: SessionResponse = {
    // Keep the existing opaque route ID across the storage-format upgrade.
    id: `${sessionId}.jsonl`,
    botId,
    sessionKey,
    channelType:
      stringValue(row.channel) ?? stringValue(origin.provider) ?? "webchat",
    channelId: stringValue(delivery.to) ?? null,
    title: stringValue(row.label) ?? safeGeneratedTitle,
    status: "active",
    messageCount:
      typeof row.messageCount === "number" ? Math.max(0, row.messageCount) : 0,
    lastMessageAt: new Date(
      timestamp(row.lastInteractionAt) ?? updatedAt,
    ).toISOString(),
    metadata: null,
    createdAt: new Date(timestamp(row.createdAt) ?? updatedAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    category: stringValue(row.category) ?? null,
    pinned: row.pinned === true || timestamp(row.pinnedAt) !== undefined,
    unread: row.unread === true,
    archived: row.archived === true || archivedAt !== undefined,
    archivedAt:
      archivedAt === undefined ? null : new Date(archivedAt).toISOString(),
    checkpointCount:
      typeof row.compactionCheckpointCount === "number"
        ? Math.max(0, Math.floor(row.compactionCheckpointCount))
        : 0,
    runState:
      row.hasActiveRun === true || row.status === "running"
        ? "running"
        : row.abortedLastRun === true ||
            row.status === "failed" ||
            row.status === "killed" ||
            row.status === "timeout"
          ? "failed"
          : "idle",
  };
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "contextTokens",
    "estimatedCostUsd",
  ] as const) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      if (key === "contextTokens" && value === 0) continue;
      session[key] = value;
    }
  }
  if (typeof row.totalTokensFresh === "boolean") {
    session.totalTokensFresh = row.totalTokensFresh;
  }
  if (typeof row.modelProvider === "string")
    session.modelProvider = row.modelProvider;
  if (typeof row.model === "string") session.model = row.model;
  return session;
}

/** Adapt public chat.history messages to the existing transcript normalizer. */
export function gatewayHistoryTranscript(messages: unknown[]): string {
  let previousId: string | null = null;
  return messages
    .map((value, index) => {
      const message = asRecord(value);
      const meta = asRecord(message.__openclaw);
      const id =
        stringValue(meta.id) ??
        stringValue(message.id) ??
        `gateway-message-${index}`;
      const time =
        timestamp(message.timestamp) ?? timestamp(meta.recordTimestampMs);
      const event = {
        type: "message",
        id,
        parentId: stringValue(meta.parentId) ?? previousId,
        timestamp:
          time === undefined ? undefined : new Date(time).toISOString(),
        message: { ...message, timestamp: time },
      };
      previousId = id;
      return JSON.stringify(event);
    })
    .join("\n");
}
