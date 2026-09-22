import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  CreateSessionInput,
  SessionArchiveFilter,
  SessionResponse,
  SessionRunState,
  UpdateSessionInput,
} from "@nexu/shared";
import type { ControllerEnv } from "../app/env.js";
import { logger } from "../lib/logger.js";
import { ensureMediaCached, mediaCacheDir } from "../lib/media-cache.js";
import { proxyFetch } from "../lib/proxy-fetch.js";
import {
  type SessionsGatewayReader,
  gatewayHistoryTranscript,
  sessionFromGatewayRow,
} from "./gateway-session-reader.js";

/**
 * Agent names that are built into OpenClaw and must not appear as Nexu bots.
 * The "main" agent is the OpenClaw default; add others here if they emerge.
 */
const OPENCLAW_RESERVED_AGENT_NAMES = new Set(["main"]);

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  timestamp: number | null;
  createdAt: string | null;
  /** Incomplete assistant output preserved when its run was interrupted. */
  aborted?: boolean;
  /** The assistant turn ended with OpenClaw's explicit error stop reason. */
  failed?: boolean;
  /** Present on toolResult messages — name of the tool that produced the result. */
  toolName?: string;
  /** Present on toolResult messages — correlates with the assistant toolCall block id. */
  toolCallId?: string;
};

type SessionMetadata = {
  title?: string;
  channelType?: string | null;
  channelId?: string | null;
  status?: string;
  messageCount?: number;
  lastMessageAt?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
};

type SessionMetadataRecord = Record<string, unknown>;
type NormalizedTextPart = {
  type: "text" | "replyContext";
  text: string;
};
type SanitizedUserMessageText = {
  text: string;
  replyContext: string | null;
};
type SessionHints = {
  senderName?: string;
  groupName?: string;
  channelType?: string;
  metadata?: SessionMetadataRecord;
  feishuMessageId?: string;
  qqbotPeerId?: string;
  qqbotGroupOpenid?: string;
  qqbotMessageType?: "c2c" | "group";
};
type SessionsIndexEntry = {
  sessionId?: string;
  sessionFile?: string;
  /** Set by OpenClaw >=2026.7.1 sessions.patch { archived: true }. */
  archivedAt?: number;
  category?: string;
  pinnedAt?: number;
  lastReadAt?: number;
  markedUnreadAt?: number;
  lastActivityAt?: number;
  lastInteractionAt?: number;
  abortedLastRun?: boolean;
  status?: "running" | "done" | "failed" | "killed" | "timeout";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  contextTokens?: number;
  estimatedCostUsd?: number;
  modelProvider?: string;
  model?: string;
  compactionCheckpoints?: Array<{ checkpointId?: string }>;
  lastChannel?: string;
  // Explicit or generated session names maintained by OpenClaw >=2026.7.1
  // (deriveSessionTitle precedence: label > displayName > subject). The
  // utility-model title generator persists into displayName.
  label?: string;
  displayName?: string;
  subject?: string;
  origin?: {
    provider?: string;
    label?: string;
  };
};
type OpenAiUserSessionContext = {
  channel?: string;
  accountid?: string;
  chattype?: string;
  peerid?: string;
  conversationid?: string;
  sendername?: string;
  groupsubject?: string;
};
type ControllerConfigRecord = {
  channels?: Array<{
    id?: string;
    botId?: string;
    channelType?: string;
    accountId?: string;
  }>;
  secrets?: Record<string, string>;
};

type QqbotKnownUser = {
  openid: string;
  type: "c2c" | "group";
  nickname?: string;
  groupOpenid?: string;
  accountId?: string;
};

const UUID_LIKE_TITLE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Controller-injected message directives (chat-service.ts: EXPERT_ROUTING_HINT
// / TEAM_LEAD_HINT / skill directive). Mirrors the web display-layer strip in
// apps/web/src/lib/chat/chat-message-extract.ts — keep the patterns in sync.
const INJECTED_DIRECTIVE_PATTERNS: readonly RegExp[] = [
  /^\[请使用「[^」]*」技能完成本次请求\]\s*/u,
  /^\[路由提示：[^\]]+\]\s*/u,
];
const QQBOT_OPEN_ID_PATTERN = /^[0-9a-f]{32}$/i;
const QQBOT_TARGET_PATTERN = /^qqbot:(c2c|group):([0-9a-f-]+)$/i;
// Persisted titles that are just the raw qqbot open id, optionally with the
// " · qqbot" channel suffix older builds appended.
const QQBOT_OPAQUE_TITLE_PATTERN = /^[0-9a-f]{32}(?: · qqbot)?$/i;
const FEISHU_MENTION_TAGS_SYSTEM_LINE =
  /\n*\[System: The content may include mention tags in the form <at user_id="[^"]+">[^<]+<\/at>\. Treat these as real mentions of Feishu entities \(users or bots\)\.\]\s*$/u;
const FEISHU_SELF_MENTION_SYSTEM_LINE =
  /\n*\[System: If user_id is "[^"]+", that mention refers to you\.\]\s*$/u;

/**
 * Text patterns identifying user-role messages synthesized by the OpenClaw
 * runtime itself rather than sent by a real user.  They are in-context
 * control prompts aimed at the model (e.g. triggering a memory-flush write
 * pass before compaction) and should not appear in the visible transcript.
 *
 * Add new patterns conservatively — the stricter the match, the lower the
 * risk of hiding a genuine user message that happens to paraphrase one of
 * these prompts.
 */
const SynthesizedUserMessagePatterns: readonly RegExp[] = [
  /^Pre-compaction memory flush\. Store durable memories now/u,
];

/**
 * Tool names whose toolResult transcript records are surfaced through the
 * chat-history API.  These results carry renderable payloads (A2UI JSONL)
 * that the web frontend consumes; every other tool result stays internal so
 * the history payload remains bounded.
 */
const SurfacedToolResultNames = new Set([
  "render_a2ui",
  "render_skill_confirmation",
  // Expert install card (in-chat auto-route).
  "propose_expert_install",
  // Team run cards (chat-first team operations) — the tool result carries
  // the TeamRunCard A2UI payload the web chat renders inline.
  "team_run_auto",
  "team_run_workflow",
  "expert_run_auto",
  // Canvas op batch (S8 chat-drives-canvas) — the tool result carries the
  // fenced ```canvas-op``` payload the web chat turns into a confirm card.
  "canvas_op",
]);

/**
 * Placeholder text OpenClaw stores for a chat.send user turn that carried
 * media but no caption.  Hidden whenever the media itself is surfaced.
 */
const MEDIA_ONLY_PLACEHOLDER_TEXT = "[User sent media without caption]";

/** OpenClaw appends this internal delivery marker to media captions. */
const USER_MEDIA_ATTACHMENT_MARKER_PATTERN =
  /^\[media attached:\s*[^\]]+\]\s*$/gimu;

/**
 * Prefix of user-role messages OpenClaw synthesizes to route content from
 * another session or internal tool (e.g. background image_generate
 * completions).  The envelope text is runtime-internal; only the media
 * payload should be shown to the user.
 */
const INTER_SESSION_MESSAGE_PREFIX = "[Inter-session message]";

/**
 * Matches `MEDIA:<path>` directive lines OpenClaw appends to assistant replies.
 * Tolerates the space the skill scripts actually emit (`MEDIA: <path>`) and a
 * full-width colon, which models sometimes substitute when replying in Chinese.
 */
const ASSISTANT_MEDIA_MARKER_PATTERN = /^MEDIA[:：]\s*(\S[^\n]*)$/gmu;

/**
 * OpenClaw injects this literal user-role message into a bot's currently
 * active session to poll for proactive work, instead of using a dedicated
 * session (unlike the workspace-bootstrap heartbeat, which nexu already
 * hides at the session-file level — see heartbeatFileNames above). It has no
 * `origin` marker at the individual-message level, so it must be matched by
 * literal content.
 */
const HEARTBEAT_POLL_MESSAGE = "[OpenClaw heartbeat poll]";

/** Trivial heartbeat ack the agent sends when there's nothing to report. */
const HEARTBEAT_OK_REPLY = "HEARTBEAT_OK";

function fileSystemErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isMissingPathError(error: unknown): boolean {
  return fileSystemErrorCode(error) === "ENOENT";
}

export class SessionsRuntimeUnavailableError extends Error {
  constructor() {
    super("Session data is temporarily unavailable");
    this.name = "SessionsRuntimeUnavailableError";
  }
}

export class SessionMessageNotFoundError extends Error {
  constructor() {
    super("Message not found in session");
    this.name = "SessionMessageNotFoundError";
  }
}

export class SessionTranscriptLockedError extends Error {
  constructor() {
    super("session file locked by an active OpenClaw writer");
    this.name = "SessionTranscriptLockedError";
  }
}

async function withSessionWriteLock<T>(
  filePath: string,
  action: (normalizedFilePath: string) => Promise<T>,
): Promise<T> {
  const normalizedFilePath = await realpath(filePath);
  const lockPath = `${normalizedFilePath}.lock`;
  const payload = `${JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    maxHoldMs: 30_000,
    ownerId: crypto.randomUUID(),
  })}\n`;
  let lockHandle: Awaited<ReturnType<typeof open>>;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (fileSystemErrorCode(error) === "EEXIST") {
      throw new SessionTranscriptLockedError();
    }
    throw error;
  }

  try {
    await lockHandle.writeFile(payload, "utf8");
    return await action(normalizedFilePath);
  } finally {
    try {
      await lockHandle.close();
    } catch (error) {
      logger.warn(
        { errorCode: fileSystemErrorCode(error) },
        "sessions-runtime: session write lock close failed",
      );
    }
    try {
      const currentPayload = await readFile(lockPath, "utf8");
      if (currentPayload === payload) {
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        logger.warn(
          { errorCode: fileSystemErrorCode(error) },
          "sessions-runtime: session write lock cleanup failed",
        );
      }
    }
  }
}

function throwSessionsRuntimeUnavailable(
  operation: string,
  error: unknown,
): never {
  if (error instanceof SessionsRuntimeUnavailableError) {
    throw error;
  }
  logger.error(
    { operation, errorCode: fileSystemErrorCode(error) },
    "sessions-runtime: session data scan failed",
  );
  throw new SessionsRuntimeUnavailableError();
}

type TranscriptTreeNode = {
  id: string;
  parentId: string | null;
  rowIndex: number;
  transparent: boolean;
};

type TranscriptRow = {
  line: string;
  record: Record<string, unknown> | null;
};

const CANONICAL_TRANSCRIPT_ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);

function readTranscriptRecord(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readNonEmptyTranscriptId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNullableTranscriptId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readNonEmptyTranscriptId(value) ?? undefined;
}

function resolveTranscriptLeafReference(
  id: string | null,
  nodes: Map<string, TranscriptTreeNode>,
): string | null {
  let currentId = id;
  const seen = new Set<string>();
  while (currentId !== null) {
    if (seen.has(currentId)) return currentId;
    seen.add(currentId);
    const node = nodes.get(currentId);
    if (!node?.transparent) return currentId;
    currentId = node.parentId;
  }
  return null;
}

/**
 * OpenClaw persists branch navigation as append-only `leaf` controls. Once a
 * valid control exists, only the selected parent chain is active; transcripts
 * without controls keep the historical flat-reader behavior.
 */
function selectActiveTranscriptLines(raw: string): string[] {
  const rows: TranscriptRow[] = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ line, record: readTranscriptRecord(line) }));
  const nodes = new Map<string, TranscriptTreeNode>();
  const invalidLeafControlIds = new Set<string>();
  let leafId: string | null = null;
  let appendParentId: string | null = null;
  let hasValidLeafControl = false;

  for (const [rowIndex, row] of rows.entries()) {
    const record = row.record;
    if (!record) continue;
    const id = readNonEmptyTranscriptId(record.id);
    if (!id) continue;

    if (record.type === "leaf") {
      const parentId = Object.hasOwn(record, "parentId")
        ? readNullableTranscriptId(record.parentId)
        : undefined;
      const targetId = Object.hasOwn(record, "targetId")
        ? readNullableTranscriptId(record.targetId)
        : undefined;
      const requestedAppendParentId = Object.hasOwn(record, "appendParentId")
        ? readNullableTranscriptId(record.appendParentId)
        : targetId;
      const validAppendMode =
        record.appendMode === undefined || record.appendMode === "side";
      if (
        parentId === undefined ||
        targetId === undefined ||
        requestedAppendParentId === undefined ||
        !validAppendMode
      ) {
        invalidLeafControlIds.add(id);
        continue;
      }
      const isKnownReference = (referenceId: string | null): boolean =>
        referenceId === null ||
        (nodes.has(referenceId) && !invalidLeafControlIds.has(referenceId));
      if (
        !isKnownReference(targetId) ||
        !isKnownReference(requestedAppendParentId)
      ) {
        invalidLeafControlIds.add(id);
        continue;
      }
      const resolvedTargetId = resolveTranscriptLeafReference(targetId, nodes);
      nodes.set(id, {
        id,
        parentId: resolvedTargetId,
        rowIndex,
        transparent: true,
      });
      leafId = resolvedTargetId;
      appendParentId = resolveTranscriptLeafReference(
        requestedAppendParentId,
        nodes,
      );
      hasValidLeafControl = true;
      continue;
    }

    const isCanonicalEntry =
      typeof record.type === "string" &&
      CANONICAL_TRANSCRIPT_ENTRY_TYPES.has(record.type);
    if (!isCanonicalEntry) {
      if (Object.hasOwn(record, "parentId")) {
        const opaqueParentId = readNullableTranscriptId(record.parentId);
        if (opaqueParentId !== undefined) {
          nodes.set(id, {
            id,
            parentId: resolveTranscriptLeafReference(opaqueParentId, nodes),
            rowIndex,
            transparent: true,
          });
          appendParentId = id;
        }
      }
      continue;
    }

    let parentId: string | null;
    if (Object.hasOwn(record, "parentId")) {
      const parsedParentId = readNullableTranscriptId(record.parentId);
      if (parsedParentId === undefined) continue;
      parentId = resolveTranscriptLeafReference(parsedParentId, nodes);
    } else {
      parentId = leafId;
    }
    if (
      record.appendMode !== "side" &&
      parentId === appendParentId &&
      leafId !== appendParentId
    ) {
      parentId = leafId;
    }
    nodes.set(id, {
      id,
      parentId,
      rowIndex,
      transparent: false,
    });
    appendParentId = id;
    if (record.appendMode !== "side") {
      leafId = id;
    }
  }

  if (!hasValidLeafControl) return rows.map((row) => row.line);

  const selectedNodesByRow = new Map<number, TranscriptTreeNode>();
  const seen = new Set<string>();
  let currentId = leafId;
  while (currentId !== null && !seen.has(currentId)) {
    seen.add(currentId);
    const node = nodes.get(currentId);
    if (!node) break;
    if (!node.transparent) selectedNodesByRow.set(node.rowIndex, node);
    currentId = node.parentId;
  }
  return rows
    .map((row, rowIndex) => {
      const node = selectedNodesByRow.get(rowIndex);
      if (!node || !row.record) return null;
      return row.record.parentId === node.parentId
        ? row.line
        : JSON.stringify({ ...row.record, parentId: node.parentId });
    })
    .filter((line): line is string => line !== null);
}

function inspectTranscriptForMessage(
  raw: string,
  messageId: string,
): {
  found: boolean;
  rawTailId: string | null;
} {
  let found = false;
  let rawTailId: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const record = readTranscriptRecord(line);
    if (!record) continue;
    const id = readNonEmptyTranscriptId(record.id);
    if (!id || record.type === "session") continue;
    if (
      (typeof record.type === "string" &&
        CANONICAL_TRANSCRIPT_ENTRY_TYPES.has(record.type)) ||
      (Object.hasOwn(record, "parentId") &&
        readNullableTranscriptId(record.parentId) !== undefined)
    ) {
      rawTailId = id;
    }
    if (record.type === "message" && id === messageId) {
      found = true;
    }
  }
  return { found, rawTailId };
}

/** Plain concatenated text of a message content (string or text-block list). */
function rawMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = block as { type?: string; text?: string } | null;
        return b?.type === "text" ? (b.text ?? "") : "";
      })
      .join("");
  }
  return "";
}

/** True when a heartbeat reply is just the no-op ack, not a proactive message. */
function isTrivialHeartbeatReply(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim() === HEARTBEAT_OK_REPLY;
  }
  if (Array.isArray(content) && content.length === 1) {
    const block = content[0] as { type?: string; text?: string } | null;
    return block?.type === "text" && block.text?.trim() === HEARTBEAT_OK_REPLY;
  }
  return false;
}

const MEDIA_EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
};

function mimeTypeForMediaPath(filePath: string, hint?: string): string {
  if (hint?.trim()) return hint;
  return (
    MEDIA_EXTENSION_MIME[path.extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

/** URL the web app uses to fetch a transcript-referenced media file. */
function mediaFileUrl(filePath: string): string {
  return `/api/v1/media/state-file?path=${encodeURIComponent(filePath)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sessionMetadataPath(filePath: string): string {
  return filePath.replace(/\.jsonl$/, ".meta.json");
}

function abbreviateOpaqueId(value: string): string {
  return value.slice(0, 8).toUpperCase();
}

function extractQqbotOpaqueId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const targetMatch = trimmed.match(QQBOT_TARGET_PATTERN);
  if (targetMatch?.[2]) {
    return targetMatch[2];
  }

  return QQBOT_OPEN_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

function normalizeQqbotDisplayName(
  value: string | undefined,
  kind: "user" | "group",
): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const targetMatch = trimmed.match(QQBOT_TARGET_PATTERN);
  if (targetMatch) {
    const targetKind =
      targetMatch[1]?.toLowerCase() === "group" ? "group" : "user";
    const opaqueId = targetMatch[2] ?? trimmed;
    return `QQ ${targetKind === "group" ? "group" : "user"} ${abbreviateOpaqueId(opaqueId)}`;
  }

  if (QQBOT_OPEN_ID_PATTERN.test(trimmed)) {
    return `QQ ${kind === "group" ? "group" : "user"} ${abbreviateOpaqueId(trimmed)}`;
  }

  return trimmed;
}

export class SessionsRuntime {
  private readonly feishuTokenCache = new Map<
    string,
    { token: string; expiresAt: number }
  >();
  private qqbotKnownUsersCache: {
    filePath: string;
    mtimeMs: number;
    users: QqbotKnownUser[];
  } | null = null;

  private _sessionsCache: SessionResponse[] | null = null;
  private _sessionsCacheMtime = 0;
  private readonly gatewayHistoryStats = new Map<
    string,
    { messageCount: number; lastMessageAt: string | null; title?: string }
  >();
  private readonly gatewayUntitledSessionIds = new Set<string>();
  private static SESSIONS_CACHE_TTL_MS = 2000;

  /** Media paths queued for mirroring into the durable cache. */
  private readonly mediaCacheQueue = new Set<string>();
  /** Media paths already mirrored (or attempted) — skip on later reads. */
  private readonly mediaCacheAttempted = new Set<string>();

  constructor(
    private readonly env: ControllerEnv,
    private readonly gateway?: SessionsGatewayReader,
  ) {}

  usesGatewayPersistence(): boolean {
    return this.gateway !== undefined;
  }

  /** Root of OpenClaw's TTL-cleaned transient media directory. */
  private mediaRootDir(): string {
    return path.resolve(this.env.openclawStateDir, "media");
  }

  /**
   * Queue a transcript-referenced media file for durable caching.  Only
   * paths inside OpenClaw's media root are eligible — the media route
   * refuses to serve anything else, so caching it would be wasted (and a
   * model-authored path outside the root must never become servable).
   */
  private queueMediaCache(absolutePath: string): void {
    if (this.mediaCacheAttempted.has(absolutePath)) return;
    const relative = path.relative(
      this.mediaRootDir(),
      path.resolve(absolutePath),
    );
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return;
    }
    this.mediaCacheQueue.add(absolutePath);
  }

  /** Best-effort mirror of queued media files into the durable cache. */
  private async flushMediaCacheQueue(): Promise<void> {
    if (this.mediaCacheQueue.size === 0) return;
    const queued = [...this.mediaCacheQueue];
    this.mediaCacheQueue.clear();
    const cacheDir = mediaCacheDir(this.env.nexuHomeDir);
    for (const absolutePath of queued) {
      this.mediaCacheAttempted.add(absolutePath);
      try {
        await ensureMediaCached(cacheDir, absolutePath, this.mediaRootDir());
      } catch (err) {
        logger.warn(
          {
            absolutePath,
            error: err instanceof Error ? err.message : String(err),
          },
          "sessions-runtime: media cache mirror failed",
        );
      }
    }
  }

  /**
   * Rewrite absolute OpenClaw media paths embedded in surfaced tool-result
   * text (A2UI JSONL — e.g. Image.source from render_a2ui) into controller
   * media URLs the browser can load, queuing each file for durable caching.
   * Paths outside the media root are left untouched.
   */
  private rewriteToolResultMediaPaths(content: unknown): unknown {
    if (!Array.isArray(content)) return content;
    const pathPattern = new RegExp(
      `${escapeRegExp(this.mediaRootDir() + path.sep)}[^"\\s]+`,
      "g",
    );
    return content.map((part) => {
      const block = part as Record<string, unknown> | null;
      if (block?.type !== "text" || typeof block.text !== "string") {
        return part;
      }
      const text = block.text.replace(pathPattern, (match) => {
        this.queueMediaCache(match);
        return mediaFileUrl(match);
      });
      return text === block.text ? part : { ...block, text };
    });
  }

  async listSessions(
    forceRefresh = false,
    archived: SessionArchiveFilter = "exclude",
  ): Promise<SessionResponse[]> {
    // Check if cache is still valid
    if (!forceRefresh && this._sessionsCache !== null) {
      const elapsed = Date.now() - this._sessionsCacheMtime;
      if (elapsed < SessionsRuntime.SESSIONS_CACHE_TTL_MS) {
        return this.filterArchivedSessions(this._sessionsCache, archived);
      }
    }

    // Run the full scan
    const agentsDir = path.join(this.env.openclawStateDir, "agents");
    const sessions = this.gateway
      ? await this.listGatewaySessions()
      : await this._listSessionsUncached(agentsDir);

    // Update cache
    this._sessionsCache = sessions;
    this._sessionsCacheMtime = Date.now();

    return this.filterArchivedSessions(sessions, archived);
  }

  private filterArchivedSessions(
    sessions: SessionResponse[],
    archived: SessionArchiveFilter,
  ): SessionResponse[] {
    if (archived === "include") return sessions;
    if (archived === "only") {
      return sessions.filter((session) => session.archived === true);
    }
    return sessions.filter((session) => session.archived !== true);
  }

  invalidateSessionsCache(): void {
    this._sessionsCache = null;
    this._sessionsCacheMtime = 0;
  }

  private async listGatewaySessions(): Promise<SessionResponse[]> {
    if (!this.gateway) return [];
    try {
      const response = await this.gateway.listStoredSessions();
      const sessions: SessionResponse[] = [];
      for (const row of response.sessions ?? []) {
        const session = sessionFromGatewayRow(row);
        if (!session) continue;
        const hasExplicitLabel =
          typeof row === "object" &&
          row !== null &&
          "label" in row &&
          typeof row.label === "string" &&
          row.label.trim().length > 0;
        if (!hasExplicitLabel && session.title === "New conversation") {
          this.gatewayUntitledSessionIds.add(session.id);
        } else {
          this.gatewayUntitledSessionIds.delete(session.id);
        }
        const filePath = path.join(
          this.env.openclawStateDir,
          "agents",
          session.botId,
          "sessions",
          path.basename(session.id),
        );
        const extra = await this.readSessionMetadata(filePath);
        sessions.push({
          ...session,
          ...(this.gatewayHistoryStats.get(session.id) ?? {}),
          title:
            extra.title ??
            (this.gatewayUntitledSessionIds.has(session.id)
              ? (this.gatewayHistoryStats.get(session.id)?.title ??
                session.title)
              : session.title),
          channelType: extra.channelType ?? session.channelType,
          channelId: extra.channelId ?? session.channelId,
          status: extra.status ?? session.status,
          createdAt: extra.createdAt ?? session.createdAt,
          updatedAt: extra.updatedAt ?? session.updatedAt,
          metadata: { ...(extra.metadata ?? {}), source: "openclaw-gateway" },
        });
      }
      const compatSessions = await this._listSessionsUncached(
        path.join(this.env.openclawStateDir, "agents"),
        true,
      );
      const gatewayKeys = new Set(
        sessions.map((session) => `${session.botId}:${session.sessionKey}`),
      );
      sessions.push(
        ...compatSessions.filter(
          (session) =>
            !gatewayKeys.has(`${session.botId}:${session.sessionKey}`),
        ),
      );
      return sessions.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    } catch (error) {
      throwSessionsRuntimeUnavailable("read-gateway-sessions", error);
    }
  }

  private async readGatewayMessages(
    sessionKey: string,
    limit: number,
    channelType?: string | null,
    sessionId?: string,
  ): Promise<ChatMessage[]> {
    if (!this.gateway) return [];
    try {
      let result = sessionId
        ? await this.gateway.getStoredChatHistory(sessionKey, limit, sessionId)
        : await this.gateway.getStoredChatHistory(sessionKey, limit);
      let rawMessages = result.messages ?? [];
      let totalMessages = result.totalMessages;
      let messages = await this.parseTranscriptMessages(
        gatewayHistoryTranscript(rawMessages),
        limit,
        channelType,
      );
      let offset = 0;
      let pagesRead = 1;
      // Gateway pages count raw rows, while Nexu hides system/tool-only
      // messages. Read older pages until the requested visible tail is full.
      while (messages.length < limit && result.hasMore) {
        const nextOffset = result.nextOffset;
        if (
          typeof nextOffset !== "number" ||
          !Number.isSafeInteger(nextOffset) ||
          nextOffset <= offset ||
          pagesRead >= 200
        ) {
          throw new Error("OpenClaw history pagination did not advance");
        }
        offset = nextOffset;
        result = await this.gateway.getStoredChatHistory(
          sessionKey,
          limit,
          sessionId,
          offset,
        );
        pagesRead += 1;
        rawMessages = [...(result.messages ?? []), ...rawMessages];
        if (typeof result.totalMessages === "number") {
          totalMessages = result.totalMessages;
        }
        messages = await this.parseTranscriptMessages(
          gatewayHistoryTranscript(rawMessages),
          limit,
          channelType,
        );
      }
      const cachedSession = this._sessionsCache?.find(
        (session) =>
          session.sessionKey === sessionKey &&
          (!sessionId || session.id === `${sessionId}.jsonl`),
      );
      let fallbackTitle: string | undefined;
      if (
        cachedSession &&
        this.gatewayUntitledSessionIds.has(cachedSession.id)
      ) {
        let text = rawMessageText(
          messages.find((message) => message.role === "user")?.content,
        );
        for (const pattern of INJECTED_DIRECTIVE_PATTERNS)
          text = text.replace(pattern, "");
        const excerpt = text.replace(/\s+/g, " ").trim();
        if (excerpt)
          fallbackTitle =
            excerpt.length > 60 ? `${excerpt.slice(0, 59)}…` : excerpt;
      }
      const stats = {
        messageCount:
          typeof totalMessages === "number"
            ? totalMessages
            : Math.max(
                messages.length,
                cachedSession
                  ? (this.gatewayHistoryStats.get(cachedSession.id)
                      ?.messageCount ?? 0)
                  : 0,
              ),
        lastMessageAt: messages.at(-1)?.createdAt ?? null,
        ...(fallbackTitle ? { title: fallbackTitle } : {}),
      };
      if (cachedSession) {
        this.gatewayHistoryStats.set(cachedSession.id, stats);
        Object.assign(cachedSession, stats);
      }
      return messages;
    } catch (error) {
      throwSessionsRuntimeUnavailable("read-gateway-history", error);
    }
  }

  private async _listSessionsUncached(
    agentsDir: string,
    compatOnly = false,
  ): Promise<SessionResponse[]> {
    const qqbotKnownUsers = await this.readQqbotKnownUsers();

    try {
      const agentEntries = await readdir(agentsDir, { withFileTypes: true });
      const sessions: SessionResponse[] = [];

      for (const agentEntry of agentEntries) {
        if (!agentEntry.isDirectory()) {
          continue;
        }

        // Skip OpenClaw built-in agents — they are not Nexu bots and their
        // sessions (e.g. from openclaw-control-ui) must not appear in the
        // Nexu session list.
        if (OPENCLAW_RESERVED_AGENT_NAMES.has(agentEntry.name)) {
          continue;
        }

        const sessionsDir = path.join(agentsDir, agentEntry.name, "sessions");
        const sessionsIndex = await this.readSessionsIndex(sessionsDir);

        // Build the set of JSONL filenames that are currently referenced by
        // sessions.json.  Any JSONL file NOT in this set is an "orphaned"
        // compacted session (a previous main session that was superseded by
        // context compaction) — we exclude it from the list so the UI only
        // shows the current active session for each conversation thread.
        //
        // Also collect filenames that belong to sub-agent sessions (sessionKey
        // contains ":subagent:").  Sub-agent sessions are spawned internally
        // by the main agent to offload work (e.g. a WeChat bot delegating to
        // a task sub-agent); they are not user-initiated conversations and
        // should not appear in the conversation list.
        const activeFileNames = new Set<string>();
        const subagentFileNames = new Set<string>();
        const heartbeatFileNames = new Set<string>();
        const fileNameToIndexKey = new Map<string, string>();
        for (const [indexKey, entry] of Object.entries(sessionsIndex)) {
          let fileName: string | null = null;
          if (
            typeof entry.sessionFile === "string" &&
            entry.sessionFile.trim()
          ) {
            fileName = path.basename(entry.sessionFile);
          } else if (
            typeof entry.sessionId === "string" &&
            entry.sessionId.trim()
          ) {
            fileName = `${entry.sessionId}.jsonl`;
          }
          if (!fileName) {
            continue;
          }
          fileNameToIndexKey.set(fileName, indexKey);
          activeFileNames.add(fileName);
          // ":openai:" sessions are gateway /v1/chat/completions turns run AS
          // the agent (e.g. the team planner's planning turn) — internal
          // machinery, not user conversations, same as subagent lanes.
          if (
            indexKey.includes(":subagent:") ||
            indexKey.includes(":openai:")
          ) {
            subagentFileNames.add(fileName);
          }
          // Skip heartbeat sessions — OpenClaw sends a "heartbeat" message
          // to bootstrap a brand-new agent workspace; this is an internal
          // mechanism, not a user conversation, and must not appear in the
          // sidebar session list.
          if (entry.origin?.provider === "heartbeat") {
            heartbeatFileNames.add(fileName);
          }
        }

        let files: Dirent[];
        try {
          files = await readdir(sessionsDir, { withFileTypes: true });
        } catch (error) {
          if (isMissingPathError(error)) {
            continue;
          }
          throwSessionsRuntimeUnavailable(
            "read-agent-sessions-directory",
            error,
          );
        }

        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".jsonl")) {
            continue;
          }
          // These transcripts are written by Nexu's DingTalk compatibility
          // proxy, not OpenClaw. Keep only that owned JSONL surface alongside
          // the gateway index; importing old runtime JSONL would duplicate
          // migrated or compacted SQLite conversations.
          if (compatOnly && !/^compat-[A-Za-z0-9_-]+\.jsonl$/.test(file.name)) {
            continue;
          }

          // Skip orphaned compacted sessions — they are not in sessions.json
          // and their history is merged transparently by getFullMainChatHistory.
          if (
            !compatOnly &&
            activeFileNames.size > 0 &&
            !activeFileNames.has(file.name)
          ) {
            continue;
          }

          // Skip sub-agent sessions — they are internal delegations (main
          // agent spawning a task sub-agent to offload work), not
          // user-initiated conversations.  They must not appear in the
          // sidebar conversation list.
          if (subagentFileNames.has(file.name)) {
            continue;
          }
          // Skip heartbeat sessions — OpenClaw's internal workspace bootstrap
          // mechanism, not a real user conversation.
          if (heartbeatFileNames.has(file.name)) {
            continue;
          }

          const filePath = path.join(sessionsDir, file.name);
          const metadata = await stat(filePath);
          let extra = await this.readSessionMetadata(filePath);
          if (compatOnly && extra.channelType !== "dingtalk") continue;
          const sessionKey =
            fileNameToIndexKey.get(file.name) ??
            file.name.replace(/\.jsonl$/, "");

          const indexEntry = this.findSessionIndexEntry(
            sessionsIndex,
            filePath,
            sessionKey,
          )?.[1];

          // Read the first user message metadata block and backfill exact
          // Feishu chat targets for existing sessions without touching
          // OpenClaw's transcript writer.
          const transcriptHints = await this.inferSessionHints(filePath);
          const indexHints = this.inferSessionHintsFromIndex(
            sessionsIndex,
            filePath,
            sessionKey,
          );
          const hints: SessionHints = {
            senderName: transcriptHints.senderName ?? indexHints.senderName,
            groupName: transcriptHints.groupName ?? indexHints.groupName,
            channelType: transcriptHints.channelType ?? indexHints.channelType,
            metadata: transcriptHints.metadata ?? indexHints.metadata,
            feishuMessageId:
              transcriptHints.feishuMessageId ?? indexHints.feishuMessageId,
          };
          const resolvedHintMetadata = await this.resolveExactChatMetadata(
            agentEntry.name,
            extra.metadata,
            hints,
          );

          let { title, channelType } = extra;
          if (!channelType && hints.channelType) {
            channelType = hints.channelType;
          }
          const qqbotDisplayNames =
            channelType === "qqbot"
              ? this.resolveQqbotDisplayNames(hints, qqbotKnownUsers)
              : null;
          const normalizedGroupName =
            channelType === "qqbot"
              ? normalizeQqbotDisplayName(
                  qqbotDisplayNames?.groupName ?? hints.groupName,
                  "group",
                )
              : channelType === "openclaw-weixin"
                ? undefined
                : hints.groupName;
          const normalizedSenderName =
            channelType === "qqbot"
              ? normalizeQqbotDisplayName(
                  qqbotDisplayNames?.senderName ?? hints.senderName,
                  "user",
                )
              : channelType === "openclaw-weixin"
                ? // WeChat protocol exposes only an opaque @im.wechat id;
                  // skip the per-sender title and fall through to the
                  // generic "WeChat ClawBot" fallback below.
                  undefined
                : hints.senderName;
          if (this.shouldReplaceInferredTitle(title, sessionKey)) {
            if (normalizedGroupName) {
              title =
                channelType &&
                channelType !== "openclaw-weixin" &&
                channelType !== "qqbot"
                  ? `${normalizedGroupName} · ${channelType}`
                  : normalizedGroupName;
            } else if (normalizedSenderName) {
              title =
                channelType === "openclaw-weixin" || channelType === "qqbot"
                  ? normalizedSenderName
                  : channelType
                    ? `${normalizedSenderName} · ${channelType}`
                    : normalizedSenderName;
            }
          }
          if (
            this.shouldReplaceInferredTitle(title, sessionKey) &&
            channelType === "openclaw-weixin"
          ) {
            title = "WeChat ClawBot";
          }
          const { metadata: mergedMetadata, changed: metadataBackfilled } =
            this.mergeSessionMetadata(extra.metadata, resolvedHintMetadata);
          const titleInferred =
            title !== extra.title && typeof title === "string";
          const channelTypeInferred =
            channelType !== extra.channelType &&
            typeof channelType === "string";
          if (metadataBackfilled || titleInferred || channelTypeInferred) {
            extra = {
              ...extra,
              title,
              channelType,
              metadata: mergedMetadata,
            };
            await this.writeSessionMetadata(filePath, extra);
          }

          // Read actual messages from .jsonl to get accurate count and
          // last-message timestamp (OpenClaw writes directly to .jsonl and
          // never updates .meta.json counters).
          const messages = await this.readMessages(
            filePath,
            Number.POSITIVE_INFINITY,
            channelType,
          );
          const lastMsg = messages.at(-1);
          let latestAssistantMessage: ChatMessage | undefined;
          for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (message?.role === "assistant") {
              latestAssistantMessage = message;
              break;
            }
          }
          const runState: SessionRunState =
            indexEntry?.status === "running"
              ? "running"
              : indexEntry?.status === "failed" ||
                  indexEntry?.status === "killed" ||
                  indexEntry?.status === "timeout" ||
                  indexEntry?.abortedLastRun === true ||
                  latestAssistantMessage?.failed === true
                ? "failed"
                : "idle";
          const lastActivityAt = Math.max(
            indexEntry?.lastInteractionAt ?? 0,
            indexEntry?.lastActivityAt ?? 0,
          );
          const unread =
            indexEntry?.markedUnreadAt !== undefined ||
            (indexEntry?.lastReadAt !== undefined &&
              lastActivityAt > indexEntry.lastReadAt);

          // Hint-less sessions (webchat/dashboard): prefer OpenClaw's
          // generated/explicit session name from sessions.json. Read live on
          // every list (not persisted to .meta.json) so later regeneration or
          // gateway-side renames flow through.
          if (this.shouldReplaceInferredTitle(title, sessionKey)) {
            const indexName = this.readIndexSessionName(
              sessionsIndex,
              filePath,
              sessionKey,
            );
            if (
              indexName &&
              !this.shouldReplaceInferredTitle(indexName, sessionKey)
            ) {
              title = indexName;
            }
          }

          // Last-resort readable title: first user message excerpt. Keeps the
          // list free of raw "agent:<uuid>:…" keys even before OpenClaw's
          // generated title lands (or when no utility/primary model responded).
          if (this.shouldReplaceInferredTitle(title, sessionKey)) {
            const firstUserMessage = messages.find(
              (message) => message.role === "user",
            );
            let firstUserText = rawMessageText(firstUserMessage?.content);
            for (const pattern of INJECTED_DIRECTIVE_PATTERNS) {
              firstUserText = firstUserText.replace(pattern, "");
            }
            const excerpt = firstUserText.replace(/\s+/g, " ").trim();
            if (excerpt) {
              title =
                excerpt.length > 60 ? `${excerpt.slice(0, 59)}…` : excerpt;
            }
          }

          sessions.push({
            id: file.name,
            botId: agentEntry.name,
            sessionKey,
            channelType: channelType ?? null,
            channelId: extra.channelId ?? null,
            title: title ?? sessionKey,
            status: extra.status ?? "active",
            messageCount: messages.length,
            lastMessageAt: lastMsg?.createdAt ?? metadata.mtime.toISOString(),
            metadata: {
              ...this.buildPublicMetadata(filePath, extra.metadata),
              ...(compatOnly ? { source: "nexu-compat" } : {}),
            },
            createdAt: extra.createdAt ?? metadata.birthtime.toISOString(),
            updatedAt: extra.updatedAt ?? metadata.mtime.toISOString(),
            category: indexEntry?.category ?? null,
            pinned: indexEntry?.pinnedAt !== undefined,
            unread,
            archived: indexEntry?.archivedAt !== undefined,
            archivedAt:
              indexEntry?.archivedAt !== undefined
                ? new Date(indexEntry.archivedAt).toISOString()
                : null,
            checkpointCount: indexEntry?.compactionCheckpoints?.length ?? 0,
            runState,
            ...(indexEntry?.inputTokens !== undefined
              ? { inputTokens: indexEntry.inputTokens }
              : {}),
            ...(indexEntry?.outputTokens !== undefined
              ? { outputTokens: indexEntry.outputTokens }
              : {}),
            ...(indexEntry?.totalTokens !== undefined
              ? { totalTokens: indexEntry.totalTokens }
              : {}),
            ...(indexEntry?.totalTokensFresh !== undefined
              ? { totalTokensFresh: indexEntry.totalTokensFresh }
              : {}),
            ...(indexEntry?.contextTokens !== undefined
              ? { contextTokens: indexEntry.contextTokens }
              : {}),
            ...(indexEntry?.estimatedCostUsd !== undefined
              ? { estimatedCostUsd: indexEntry.estimatedCostUsd }
              : {}),
            ...(indexEntry?.modelProvider
              ? { modelProvider: indexEntry.modelProvider }
              : {}),
            ...(indexEntry?.model ? { model: indexEntry.model } : {}),
          });
        }
      }

      return sessions.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    } catch (error) {
      if (isMissingPathError(error)) {
        return [];
      }
      throwSessionsRuntimeUnavailable("scan-session-data", error);
    }
  }

  /**
   * Ensure a gateway-created session's transcript file exists so it shows up
   * in listSessions immediately (OpenClaw creates the .jsonl lazily on first
   * message). Writes a minimal .meta.json alongside. Returns the session id
   * (file name) or null when the gateway did not assign a session file.
   */
  async materializeSessionFile(
    sessionFile: string | undefined,
    title: string,
  ): Promise<string | null> {
    if (!sessionFile) {
      return null;
    }
    const filePath = path.resolve(sessionFile);
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      await stat(filePath);
    } catch {
      await writeFile(filePath, "", "utf8");
    }
    const now = new Date().toISOString();
    const existing = await this.readSessionMetadata(filePath);
    await this.writeSessionMetadata(filePath, {
      ...existing,
      title: existing.title ?? title,
      channelType: existing.channelType ?? "webchat",
      status: existing.status ?? "active",
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    });
    return path.basename(filePath);
  }

  async createOrUpdateSession(
    input: CreateSessionInput,
  ): Promise<SessionResponse> {
    const filePath = this.getSessionFilePath(input.botId, input.sessionKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      await stat(filePath);
    } catch {
      await writeFile(filePath, "", "utf8");
    }

    const now = new Date().toISOString();
    const existing = await this.readSessionMetadata(filePath);
    await this.writeSessionMetadata(filePath, {
      ...existing,
      title: input.title,
      channelType: input.channelType ?? null,
      channelId: input.channelId ?? null,
      status: input.status ?? existing.status ?? "active",
      messageCount: input.messageCount ?? existing.messageCount ?? 0,
      lastMessageAt: input.lastMessageAt ?? existing.lastMessageAt ?? now,
      metadata: input.metadata ?? existing.metadata ?? null,
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    });

    return {
      id: `${input.sessionKey}.jsonl`,
      botId: input.botId,
      sessionKey: input.sessionKey,
      title: input.title,
      channelType: input.channelType ?? null,
      channelId: input.channelId ?? null,
      status: input.status ?? existing.status ?? "active",
      messageCount: input.messageCount ?? existing.messageCount ?? 0,
      lastMessageAt: input.lastMessageAt ?? existing.lastMessageAt ?? now,
      metadata: input.metadata ?? existing.metadata ?? null,
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    };
  }

  async updateSession(
    id: string,
    input: UpdateSessionInput,
  ): Promise<SessionResponse | null> {
    const session = await this.getSession(id);
    if (!session) {
      return null;
    }
    if (this.gateway && session.metadata?.source !== "nexu-compat") {
      if (input.title !== undefined) {
        await this.gateway.sessionsPatch({
          key: session.sessionKey,
          agentId: session.botId,
          label: input.title,
        });
      }
      const filePath = path.join(
        this.env.openclawStateDir,
        "agents",
        session.botId,
        "sessions",
        path.basename(session.id),
      );
      const existing = await this.readSessionMetadata(filePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await this.writeSessionMetadata(filePath, {
        ...existing,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.messageCount !== undefined
          ? { messageCount: input.messageCount }
          : {}),
        ...(input.lastMessageAt !== undefined
          ? { lastMessageAt: input.lastMessageAt }
          : {}),
        createdAt: existing.createdAt ?? session.createdAt,
        updatedAt: new Date().toISOString(),
      });
      this.invalidateSessionsCache();
      return this.getSession(id);
    }
    const filePath = await this.resolveSessionFilePath(
      session.botId,
      session.sessionKey,
    );
    const existing = await this.readSessionMetadata(filePath);
    const now = new Date().toISOString();
    await this.writeSessionMetadata(filePath, {
      ...existing,
      title: input.title ?? existing.title ?? session.title,
      status: input.status ?? existing.status ?? session.status,
      messageCount:
        input.messageCount ?? existing.messageCount ?? session.messageCount,
      lastMessageAt:
        input.lastMessageAt ?? existing.lastMessageAt ?? session.lastMessageAt,
      metadata: input.metadata ?? existing.metadata ?? session.metadata,
      channelType: existing.channelType ?? session.channelType,
      channelId: existing.channelId ?? session.channelId,
      createdAt: existing.createdAt ?? session.createdAt,
      updatedAt: now,
    });
    this.invalidateSessionsCache();
    return this.getSession(id);
  }

  async resetSession(id: string): Promise<SessionResponse | null> {
    const session = await this.getSession(id);
    if (!session) {
      return null;
    }
    if (this.gateway && session.metadata?.source !== "nexu-compat") {
      await this.gateway.sessionsReset({
        key: session.sessionKey,
        agentId: session.botId,
        reason: "reset",
      });
      this.gatewayHistoryStats.delete(session.id);
      this.invalidateSessionsCache();
      return this.getSessionBySessionKey(session.botId, session.sessionKey);
    }
    const filePath = await this.resolveSessionFilePath(
      session.botId,
      session.sessionKey,
    );
    await truncate(filePath, 0);
    const now = new Date().toISOString();
    const existing = await this.readSessionMetadata(filePath);
    await this.writeSessionMetadata(filePath, {
      ...existing,
      messageCount: 0,
      lastMessageAt: null,
      updatedAt: now,
    });
    this.invalidateSessionsCache();
    return this.getSession(id);
  }

  async deleteSession(id: string): Promise<boolean> {
    const session = await this.getSession(id);
    if (!session) {
      return false;
    }
    if (this.gateway && session.metadata?.source !== "nexu-compat") {
      await this.gateway.sessionsDelete({
        key: session.sessionKey,
        agentId: session.botId,
      });
      this.gatewayHistoryStats.delete(session.id);
      this.invalidateSessionsCache();
      return true;
    }

    // Resolve the actual file path — OpenClaw stores sessions as
    // UUID-named files (e.g. {uuid}.jsonl) and maps sessionKey → UUID
    // in sessions.json.  The legacy getSessionFilePath() constructs a
    // key-based path that usually does NOT exist on disk.
    const resolvedPath = await this.resolveSessionFilePath(
      session.botId,
      session.sessionKey,
    );

    // Delete all session-related files (JSONL transcript, metadata,
    // trajectory, trajectory-path).
    const base = resolvedPath.replace(/\.jsonl$/, "");
    await rm(`${base}.jsonl`, { force: true });
    await rm(`${base}.meta.json`, { force: true });
    await rm(`${base}.trajectory.jsonl`, { force: true });
    await rm(`${base}.trajectory-path.json`, { force: true });

    // Remove the entry from OpenClaw's sessions.json index so the
    // session does not reappear after a restart.
    await this.removeSessionIndexEntry(session.botId, session.sessionKey);

    this.invalidateSessionsCache();
    return true;
  }

  async getChatHistory(
    id: string,
    limit?: number,
  ): Promise<{ messages: ChatMessage[]; sessionKey: string | null }> {
    const session = await this.getSession(id);
    if (!session) {
      return { messages: [], sessionKey: null };
    }
    if (this.gateway && session.metadata?.source !== "nexu-compat") {
      return {
        messages: await this.readGatewayMessages(
          session.sessionKey,
          limit ?? 200,
          session.channelType,
        ),
        sessionKey: session.sessionKey,
      };
    }
    const filePath = await this.resolveSessionFilePath(
      session.botId,
      session.sessionKey,
    );
    return {
      messages: await this.readMessages(
        filePath,
        limit ?? 200,
        session.channelType,
      ),
      sessionKey: session.sessionKey,
    };
  }

  async sessionContainsMessage(params: {
    botId: string;
    sessionKey: string;
    messageId: string;
  }): Promise<boolean> {
    const filePath = await this.resolveManagedSessionFilePath(params);
    try {
      const raw = await readFile(filePath, "utf8");
      return inspectTranscriptForMessage(raw, params.messageId).found;
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
  }

  async sessionContainsActiveMessage(params: {
    botId: string;
    sessionKey: string;
    messageId: string;
  }): Promise<boolean> {
    const filePath = await this.resolveManagedSessionFilePath(params);
    try {
      const raw = await readFile(filePath, "utf8");
      const activeTranscript = selectActiveTranscriptLines(raw).join("\n");
      return inspectTranscriptForMessage(activeTranscript, params.messageId)
        .found;
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
  }

  /**
   * Select a persisted message as the active transcript leaf without deleting
   * later rows. OpenClaw will attach the next message to this selected branch.
   */
  async selectActiveMessage(params: {
    botId: string;
    sessionKey: string;
    messageId: string;
    sessionFile?: string;
  }): Promise<void> {
    const filePath = await this.resolveManagedSessionFilePath(params);
    await withSessionWriteLock(filePath, async (normalizedFilePath) => {
      let raw: string;
      try {
        raw = await readFile(normalizedFilePath, "utf8");
      } catch (error) {
        if (isMissingPathError(error)) throw new SessionMessageNotFoundError();
        throw error;
      }
      const inspected = inspectTranscriptForMessage(raw, params.messageId);
      if (!inspected.found) throw new SessionMessageNotFoundError();

      const marker = JSON.stringify({
        type: "leaf",
        id: crypto.randomUUID(),
        parentId: inspected.rawTailId,
        timestamp: new Date().toISOString(),
        targetId: params.messageId,
        appendParentId: params.messageId,
      });
      const separator = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
      await appendFile(normalizedFilePath, `${separator}${marker}\n`, "utf8");
    });
    this.invalidateSessionsCache();
  }

  async getChatHistoryBySessionKey(
    botId: string,
    sessionKey: string,
    limit?: number,
  ): Promise<{ messages: ChatMessage[]; sessionKey: string | null }> {
    if (this.gateway && !/^compat-[A-Za-z0-9_-]+$/.test(sessionKey)) {
      const session = await this.getSessionBySessionKey(botId, sessionKey);
      return session
        ? {
            messages: await this.readGatewayMessages(
              sessionKey,
              limit ?? 200,
              session.channelType,
            ),
            sessionKey,
          }
        : { messages: [], sessionKey: null };
    }
    const session = await this.getSessionByKey(botId, sessionKey);
    if (!session) {
      return { messages: [], sessionKey: null };
    }
    const filePath = await this.resolveSessionFilePath(
      session.botId,
      session.sessionKey,
    );
    return {
      messages: await this.readMessages(
        filePath,
        limit ?? 200,
        session.channelType,
      ),
      sessionKey: session.sessionKey,
    };
  }

  /**
   * Read an isolated cron run's transcript directly.
   *
   * OpenClaw >=2026.7 keys per-run automation transcripts
   * `agent:<botId>:cron:<jobId>:run:<runUuid>` but never references them in
   * sessions.json, so the regular getSession* lookups cannot see them. The
   * `:run:` suffix is the transcript file stem under the agent's sessions
   * dir. Returns null when the transcript is gone (the 24h cron session
   * reaper archives expired run transcripts) or the path escapes the
   * sessions dir.
   */
  async getRunTranscriptMessages(
    botId: string,
    runSessionId: string,
    limit?: number,
    sessionKey?: string,
  ): Promise<ChatMessage[] | null> {
    if (this.gateway) {
      if (!sessionKey || !sessionKey.startsWith(`agent:${botId}:`)) return null;
      return this.readGatewayMessages(
        sessionKey,
        limit ?? 200,
        null,
        runSessionId,
      );
    }
    const sessionsDir = path.join(
      this.env.openclawStateDir,
      "agents",
      botId,
      "sessions",
    );
    const resolved = path.resolve(sessionsDir, `${runSessionId}.jsonl`);
    if (
      !resolved.startsWith(sessionsDir + path.sep) &&
      resolved !== sessionsDir
    ) {
      return null;
    }
    try {
      await stat(resolved);
    } catch {
      return null;
    }
    return this.readMessages(resolved, limit ?? 200, null);
  }

  /**
   * Returns the full conversation history for a bot's main webchat session,
   * aggregating across all compacted sessions in chronological order.
   *
   * When OpenClaw performs context compaction it creates a new UUID-named JSONL
   * and updates sessions.json to point agent:{botId}:main at that new file.
   * The previous session files remain on disk but are no longer referenced by
   * any session key ("orphaned").  Since every channel session (WeChat, Feishu,
   * Slack, …) is always mapped in sessions.json, any orphaned JSONL file must
   * have been a previous main (webchat) session — so we include all of them.
   *
   * The result is sorted by message createdAt so the timeline reads correctly
   * across session boundaries.
   */
  async getFullMainChatHistory(
    botId: string,
    limit = 500,
  ): Promise<{ messages: ChatMessage[]; sessionCount: number }> {
    if (this.gateway) {
      const session = await this.getSessionBySessionKey(
        botId,
        `agent:${botId}:main`,
      );
      return session
        ? {
            messages: await this.readGatewayMessages(
              session.sessionKey,
              limit,
              session.channelType,
            ),
            sessionCount: 1,
          }
        : { messages: [], sessionCount: 0 };
    }
    const sessionsDir = path.join(
      this.env.openclawStateDir,
      "agents",
      botId,
      "sessions",
    );

    // 1. Read sessions.json to find which session IDs are currently "active"
    //    (mapped to any session key, e.g. channel sessions).
    const index = await this.readSessionsIndex(sessionsDir);
    const activeMappedIds = new Set<string>();
    let currentMainId: string | null = null;
    const mainKey = `agent:${botId}:main`;

    for (const [key, entry] of Object.entries(index)) {
      let sessionId: string | null = null;
      if (typeof entry.sessionFile === "string" && entry.sessionFile.trim()) {
        // sessionFile is the full path; we want the UUID basename (without .jsonl)
        sessionId = path.basename(entry.sessionFile, ".jsonl");
      } else if (
        typeof entry.sessionId === "string" &&
        entry.sessionId.trim()
      ) {
        sessionId = entry.sessionId;
      }
      if (!sessionId) continue;
      activeMappedIds.add(sessionId);
      if (key === mainKey) {
        currentMainId = sessionId;
      }
    }

    // 2. List all JSONL files in the sessions directory.
    let files: string[];
    try {
      const dirents = await readdir(sessionsDir, { withFileTypes: true });
      files = dirents
        .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
        .map((d) => path.join(sessionsDir, d.name));
    } catch {
      return { messages: [], sessionCount: 0 };
    }

    // 3. Candidate sessions = current main session + any JSONL that is NOT
    //    currently mapped to any session key (orphaned = previous main sessions).
    const candidateFiles: string[] = [];
    for (const filePath of files) {
      const id = path.basename(filePath, ".jsonl");
      const isMappedToOtherKey =
        activeMappedIds.has(id) && id !== currentMainId;
      if (!isMappedToOtherKey) {
        candidateFiles.push(filePath);
      }
    }

    // 4. Read the first-line timestamp of each candidate file to sort sessions
    //    chronologically (oldest → newest).
    const withTimestamps: Array<{ filePath: string; ts: number }> = [];
    for (const filePath of candidateFiles) {
      const ts = await this.readFirstLineTimestamp(filePath);
      withTimestamps.push({ filePath, ts });
    }
    withTimestamps.sort((a, b) => a.ts - b.ts);

    // 5. Read and concatenate messages from all sessions, then return the last
    //    `limit` messages so the caller always gets a bounded result.
    const all: ChatMessage[] = [];
    for (const { filePath } of withTimestamps) {
      // Use a large per-file limit; we'll trim the total at the end.
      const msgs = await this.readMessages(filePath, 10_000, "webchat");
      all.push(...msgs);
    }

    return {
      messages: all.slice(-limit),
      sessionCount: withTimestamps.length,
    };
  }

  /** Read the `timestamp` field from the first line of a JSONL session file. */
  private async readFirstLineTimestamp(filePath: string): Promise<number> {
    try {
      const raw = await readFile(filePath, "utf8");
      const firstLine = raw.split("\n")[0]?.trim();
      if (!firstLine) return 0;
      const parsed = JSON.parse(firstLine) as { timestamp?: string };
      return parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;
    } catch {
      return 0;
    }
  }

  async appendCompatTranscript(input: {
    botId: string;
    sessionKey: string;
    title: string;
    channelType: string;
    channelId?: string | null;
    metadata?: Record<string, unknown>;
    userText: string;
    assistantText: string;
    provider?: string | null;
    model?: string | null;
    api?: string | null;
  }): Promise<void> {
    const filePath = this.getSessionFilePath(input.botId, input.sessionKey);
    await mkdir(path.dirname(filePath), { recursive: true });

    let existingFile = true;
    try {
      await stat(filePath);
    } catch {
      existingFile = false;
    }

    if (!existingFile) {
      const sessionEntry = {
        type: "session",
        version: 3,
        id: input.sessionKey,
        timestamp: new Date().toISOString(),
        cwd: path.join(this.env.openclawStateDir, "agents", input.botId),
      };
      await writeFile(filePath, `${JSON.stringify(sessionEntry)}\n`, "utf8");
    }

    const nowIso = new Date().toISOString();
    const rootId = crypto.randomBytes(4).toString("hex");
    const userId = crypto.randomBytes(4).toString("hex");
    const assistantId = crypto.randomBytes(4).toString("hex");
    const transcript = [
      JSON.stringify({
        type: "message",
        id: userId,
        parentId: rootId,
        timestamp: nowIso,
        message: {
          role: "user",
          content: [{ type: "text", text: input.userText }],
          timestamp: Date.now(),
        },
      }),
      JSON.stringify({
        type: "message",
        id: assistantId,
        parentId: userId,
        timestamp: nowIso,
        message: {
          role: "assistant",
          content: [{ type: "text", text: input.assistantText }],
          ...(input.api ? { api: input.api } : {}),
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.model ? { model: input.model } : {}),
          timestamp: Date.now(),
        },
      }),
    ].join("\n");
    await appendFile(filePath, `${transcript}\n`, "utf8");

    const existing = await this.readSessionMetadata(filePath);
    await this.writeSessionMetadata(filePath, {
      ...existing,
      title: input.title,
      channelType: input.channelType,
      channelId: input.channelId ?? null,
      status: "active",
      lastMessageAt: nowIso,
      metadata: {
        ...(existing.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing.createdAt ?? nowIso,
      updatedAt: nowIso,
    });
    this.invalidateSessionsCache();
  }

  private async readMessages(
    filePath: string,
    limit: number,
    channelType?: string | null,
  ): Promise<ChatMessage[]> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return [];
    }

    return this.parseTranscriptMessages(raw, limit, channelType);
  }

  private async parseTranscriptMessages(
    raw: string,
    limit: number,
    channelType?: string | null,
  ): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];
    // Set when a heartbeat poll message was skipped and we're waiting to see
    // whether its direct reply is a trivial ack (also skipped) or a genuine
    // proactive message (surfaced normally, with no trace of the poll).
    let pendingHeartbeatPollId: string | null = null;
    // Last surfaced assistant message (id + media-marker-stripped text), used
    // to drop the delivery pipeline's sanitized echo of the same reply.
    let lastAssistant: {
      id: string;
      strippedText: string;
      abortSnapshot: boolean;
    } | null = null;
    for (const line of selectActiveTranscriptLines(raw)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          id?: string;
          parentId?: string;
          timestamp?: string;
          message?: {
            role?: string;
            content?: unknown;
            timestamp?: number;
            toolName?: string;
            toolCallId?: string;
            MediaPath?: string;
            MediaPaths?: string[];
            MediaType?: string;
            MediaTypes?: string[];
            provider?: string;
            model?: string;
            stopReason?: string;
            openclawAbort?: { aborted?: boolean };
          };
        };
        if (entry.type !== "message" || !entry.message) continue;
        const role = entry.message.role;
        if (
          role === "user" &&
          entry.message.content === HEARTBEAT_POLL_MESSAGE
        ) {
          pendingHeartbeatPollId = entry.id ?? "";
          continue;
        }
        if (pendingHeartbeatPollId !== null) {
          const isDirectHeartbeatReply =
            role === "assistant" && entry.parentId === pendingHeartbeatPollId;
          pendingHeartbeatPollId = null;
          if (
            isDirectHeartbeatReply &&
            isTrivialHeartbeatReply(entry.message.content)
          ) {
            continue;
          }
        }
        if (role === "toolResult") {
          // Surface renderable tool results (A2UI) so the frontend can pair
          // them with the assistant's toolCall block; drop everything else.
          const toolName = entry.message.toolName;
          if (
            typeof toolName !== "string" ||
            !SurfacedToolResultNames.has(toolName)
          ) {
            continue;
          }
          messages.push({
            id: entry.id ?? "",
            role,
            content: this.rewriteToolResultMediaPaths(entry.message.content),
            timestamp: entry.message.timestamp ?? null,
            createdAt: entry.timestamp ?? null,
            toolName,
            ...(typeof entry.message.toolCallId === "string"
              ? { toolCallId: entry.message.toolCallId }
              : {}),
          });
          continue;
        }
        if (role !== "user" && role !== "assistant") continue;
        const mediaPaths =
          entry.message.MediaPaths ??
          (entry.message.MediaPath ? [entry.message.MediaPath] : []);
        const mediaTypes =
          entry.message.MediaTypes ??
          (entry.message.MediaType ? [entry.message.MediaType] : []);
        if (role === "assistant") {
          const strippedText = rawMessageText(entry.message.content)
            .replace(ASSISTANT_MEDIA_MARKER_PATTERN, "")
            .trim();
          const abortSnapshot =
            entry.message.provider === "openclaw" &&
            entry.message.model === "gateway-injected" &&
            entry.message.openclawAbort?.aborted === true;
          const aborted =
            abortSnapshot || entry.message.stopReason === "aborted";
          const failed = entry.message.stopReason === "error";

          if (
            lastAssistant?.abortSnapshot === true &&
            !abortSnapshot &&
            entry.message.stopReason === "aborted" &&
            mediaPaths.length === 0 &&
            strippedText !== "" &&
            lastAssistant.strippedText.endsWith(strippedText) &&
            messages.at(-1)?.id === lastAssistant.id
          ) {
            // sessions.steer first writes a gateway-injected aggregate of all
            // streamed assistant text, then the aborted provider request
            // persists its final partial segment. Keep the precise provider
            // record and remove the aggregate so history contains one copy.
            messages.pop();
          }
          if (
            lastAssistant !== null &&
            entry.parentId === lastAssistant.id &&
            mediaPaths.length === 0 &&
            strippedText !== "" &&
            strippedText === lastAssistant.strippedText
          ) {
            // Sanitized delivery echo: when a reply carries `MEDIA:` marker
            // lines, the channel pipeline re-appends the same reply minus the
            // markers (~1s later, parentId pointing at the original, tagged
            // with an idempotencyKey). Surfacing both shows the user the same
            // bubble twice — drop the echo, keep the original (which owns the
            // media attachment).
            continue;
          }
          lastAssistant = {
            id: entry.id ?? "",
            strippedText,
            abortSnapshot,
          };

          const normalizedMessage = this.normalizeChatMessage(
            {
              id: entry.id ?? "",
              role,
              content: entry.message.content,
              timestamp: entry.message.timestamp ?? null,
              createdAt: entry.timestamp ?? null,
              ...(aborted ? { aborted: true } : {}),
              ...(failed ? { failed: true } : {}),
            },
            channelType,
            { paths: mediaPaths, types: mediaTypes },
          );
          if (normalizedMessage) {
            messages.push(normalizedMessage);
          }
          continue;
        }
        const normalizedMessage = this.normalizeChatMessage(
          {
            id: entry.id ?? "",
            role,
            content: entry.message.content,
            timestamp: entry.message.timestamp ?? null,
            createdAt: entry.timestamp ?? null,
          },
          channelType,
          { paths: mediaPaths, types: mediaTypes },
        );
        if (normalizedMessage) {
          messages.push(normalizedMessage);
        }
      } catch {
        // skip malformed lines
      }
    }

    // Mirror referenced media into the durable cache while the originals
    // still exist — OpenClaw TTL-cleans <state-dir>/media/ but transcripts
    // (and therefore this history view) reference the files forever.
    await this.flushMediaCacheQueue();

    // Return last N messages
    return messages.slice(-limit);
  }

  private normalizeChatMessage(
    message: ChatMessage,
    channelType?: string | null,
    media?: { paths: string[]; types: string[] },
  ): ChatMessage | null {
    // Inter-session routed messages (background tool completions) carry a
    // runtime-internal envelope as user-role text.  Strip the envelope, keep
    // the media payload, and re-attribute bot-originated content.
    const interSession = this.transformInterSessionMessage(message);
    const role = interSession?.role ?? message.role;
    const rawContent = interSession ? interSession.content : message.content;

    const content = this.normalizeMessageContent(role, rawContent, channelType);

    const mediaEntries: Array<{ path: string; mimeType?: string }> = (
      media?.paths ?? []
    )
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map((p, i) => ({ path: p, mimeType: media?.types?.[i] }));

    // Assistant replies reference generated files via `MEDIA:<path>` lines.
    const withMarkers =
      role === "assistant"
        ? this.extractAssistantMediaMarkers(content)
        : { content, mediaPaths: [] as string[] };
    for (const markerPath of withMarkers.mediaPaths) {
      mediaEntries.push({ path: markerPath });
    }

    const finalContent = this.appendMediaBlocks(
      withMarkers.content,
      mediaEntries,
    );
    if (finalContent == null) {
      return null;
    }

    return {
      ...message,
      role,
      content: finalContent,
    };
  }

  /**
   * Detect an inter-session envelope message and return the display-level
   * transformation: envelope text removed, role re-attributed to the bot
   * when the routed content is not end-user input (`isUser=false`).
   * Returns null when the message is not an inter-session envelope.
   */
  private transformInterSessionMessage(
    message: ChatMessage,
  ): { role: ChatMessage["role"]; content: unknown } | null {
    if (message.role !== "user") return null;

    const findEnvelopeText = (): string | null => {
      if (typeof message.content === "string") {
        return message.content.startsWith(INTER_SESSION_MESSAGE_PREFIX)
          ? message.content
          : null;
      }
      if (!Array.isArray(message.content)) return null;
      for (const part of message.content) {
        const block = part as Record<string, unknown> | null;
        if (
          block?.type === "text" &&
          typeof block.text === "string" &&
          block.text.startsWith(INTER_SESSION_MESSAGE_PREFIX)
        ) {
          return block.text;
        }
      }
      return null;
    };

    const envelopeText = findEnvelopeText();
    if (envelopeText == null) return null;

    const headerLine = envelopeText.split("\n", 1)[0] ?? "";
    const role = /\bisUser=false\b/.test(headerLine) ? "assistant" : "user";

    if (typeof message.content === "string") {
      // Pure-text envelope: nothing user-visible remains.
      return { role, content: [] };
    }
    const remaining = (message.content as unknown[]).filter((part) => {
      const block = part as Record<string, unknown> | null;
      return !(
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.startsWith(INTER_SESSION_MESSAGE_PREFIX)
      );
    });
    return { role, content: remaining };
  }

  /**
   * Pull `MEDIA:<path>` directive lines out of normalized assistant content.
   * Returns the content with those lines removed plus the extracted paths.
   */
  private extractAssistantMediaMarkers(content: unknown): {
    content: unknown;
    mediaPaths: string[];
  } {
    const mediaPaths: string[] = [];
    const stripFromText = (text: string): string =>
      text
        .replace(ASSISTANT_MEDIA_MARKER_PATTERN, (_m, p: string) => {
          mediaPaths.push(p.trim());
          return "";
        })
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    if (typeof content === "string") {
      const stripped = stripFromText(content);
      return { content: stripped, mediaPaths };
    }
    if (!Array.isArray(content)) {
      return { content, mediaPaths };
    }
    const blocks = content.map((part) => {
      const block = part as Record<string, unknown> | null;
      if (block?.type === "text" && typeof block.text === "string") {
        return { ...block, text: stripFromText(block.text) };
      }
      return part;
    });
    return { content: blocks, mediaPaths };
  }

  /**
   * Append transcript-referenced media (MediaPaths fields, MEDIA: markers)
   * to normalized message content as image/file blocks the frontend can
   * render.  Image bytes are served by `/api/v1/media/state-file`.
   */
  private appendMediaBlocks(
    content: unknown | null,
    mediaEntries: Array<{ path: string; mimeType?: string }>,
  ): unknown | null {
    if (mediaEntries.length === 0) {
      // Re-apply the empty check normalizeMessageContent already performed —
      // marker stripping may have emptied a previously non-empty string.
      if (typeof content === "string" && content.trim().length === 0) {
        return null;
      }
      return content;
    }

    const seen = new Set<string>();
    const mediaBlocks: Array<Record<string, unknown>> = [];
    for (const entry of mediaEntries) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      const mimeType = mimeTypeForMediaPath(entry.path, entry.mimeType);
      if (mimeType.startsWith("image/")) {
        this.queueMediaCache(entry.path);
        mediaBlocks.push({
          type: "image",
          url: mediaFileUrl(entry.path),
          mimeType,
        });
      } else {
        this.queueMediaCache(entry.path);
        mediaBlocks.push({
          type: "file",
          url: mediaFileUrl(entry.path),
          metadata: {
            filename: path.basename(entry.path),
            mimeType,
            url: mediaFileUrl(entry.path),
          },
        });
      }
    }

    const mediaPathSet = seen;
    const remainingInlineMediaReplacements = {
      image: mediaBlocks.filter((block) => block.type === "image").length,
      file: mediaBlocks.filter((block) => block.type === "file").length,
    };
    const isHiddenMediaText = (text: string): boolean => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return true;
      if (trimmed === MEDIA_ONLY_PLACEHOLDER_TEXT) return true;
      // Legacy format prepended the raw media path as the first text line.
      return mediaPathSet.has(trimmed);
    };
    const stripLeadingMediaPathLine = (text: string): string => {
      const lines = text.split("\n");
      while (lines.length > 0 && mediaPathSet.has((lines[0] ?? "").trim())) {
        lines.shift();
      }
      return lines.join("\n").trim();
    };

    const textBlocks: Array<Record<string, unknown>> = [];
    if (typeof content === "string") {
      const cleaned = stripLeadingMediaPathLine(content);
      if (!isHiddenMediaText(cleaned)) {
        textBlocks.push({ type: "text", text: cleaned });
      }
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const block = part as Record<string, unknown> | null;
        if (block?.type === "text" && typeof block.text === "string") {
          const cleaned = stripLeadingMediaPathLine(block.text);
          if (isHiddenMediaText(cleaned)) continue;
          textBlocks.push({ ...block, text: cleaned });
          continue;
        }
        if (
          (block?.type === "image" || block?.type === "file") &&
          remainingInlineMediaReplacements[block.type] > 0
        ) {
          // OpenClaw stores inbound attachments twice: inline base64 content
          // for the model and MediaPaths for transcript persistence. Prefer
          // the served MediaPaths block so history renders one lightweight
          // attachment instead of both representations.
          remainingInlineMediaReplacements[block.type] -= 1;
          continue;
        }
        if (block != null) textBlocks.push(block);
      }
    }

    return [...textBlocks, ...mediaBlocks];
  }

  private normalizeMessageContent(
    role: ChatMessage["role"],
    content: unknown,
    channelType?: string | null,
  ): unknown | null {
    if (typeof content === "string") {
      const normalizedParts = this.normalizeTextParts(
        role,
        content,
        channelType,
      );
      if (normalizedParts.length === 0) {
        return null;
      }

      if (normalizedParts.length === 1 && normalizedParts[0]?.type === "text") {
        return normalizedParts[0].text;
      }

      return normalizedParts;
    }

    if (!Array.isArray(content)) {
      return content;
    }

    const normalizedBlocks: Array<Record<string, unknown>> = [];
    let hasVisibleContent = false;

    for (const part of content) {
      if (typeof part !== "object" || part === null) {
        continue;
      }

      const block = part as Record<string, unknown>;
      const blockType = typeof block.type === "string" ? block.type : null;

      if (blockType === "thinking") {
        continue;
      }

      if (blockType === "text") {
        const rawText = typeof block.text === "string" ? block.text : null;
        if (rawText == null) {
          continue;
        }

        const normalizedParts = this.normalizeTextParts(
          role,
          rawText,
          channelType,
        );
        if (normalizedParts.length === 0) {
          continue;
        }

        for (const normalizedPart of normalizedParts) {
          if (normalizedPart.type === "replyContext") {
            normalizedBlocks.push(normalizedPart);
            hasVisibleContent = true;
            continue;
          }

          normalizedBlocks.push({
            ...block,
            text: normalizedPart.text,
          });
          hasVisibleContent = true;
        }
        continue;
      }

      if (blockType === "replyContext") {
        const replyText =
          typeof block.text === "string" ? block.text.trim() : "";
        if (replyText.length === 0) {
          continue;
        }

        normalizedBlocks.push({
          ...block,
          text: replyText,
        });
        hasVisibleContent = true;
        continue;
      }

      if (blockType === "toolCall" || blockType === "tool_use") {
        normalizedBlocks.push(block);
        hasVisibleContent = true;
        continue;
      }

      // A2UI interactive content blocks — passed through for frontend rendering.
      if (blockType === "a2ui") {
        normalizedBlocks.push(block);
        hasVisibleContent = true;
        continue;
      }

      // Media blocks (image / file) are user-visible content — if the user
      // sends just an image with no accompanying text, the text block is
      // reduced to the empty string by the sanitizer and would otherwise
      // leave `hasVisibleContent = false`, causing the whole message to be
      // dropped from the history endpoint.  Treat them as visible so the
      // bubble (and its attachment card/preview) persists through polling
      // refreshes.
      if (blockType === "image" || blockType === "file") {
        normalizedBlocks.push(block);
        hasVisibleContent = true;
        continue;
      }

      // Preserve unknown blocks for forward compatibility, but only text,
      // replyContext, tool, image and file blocks count as visible transcript
      // content.
      normalizedBlocks.push(block);
    }

    return hasVisibleContent ? normalizedBlocks : null;
  }

  private normalizeTextParts(
    role: ChatMessage["role"],
    text: string,
    channelType?: string | null,
  ): NormalizedTextPart[] {
    if (role === "assistant") {
      const normalizedText = this.stripAssistantReplyPrefix(text).trim();
      return normalizedText.length > 0
        ? [{ type: "text", text: normalizedText }]
        : [];
    }

    // OpenClaw injects synthetic user-role messages to trigger in-context
    // behaviors (pre-compaction memory flush, system prompts, heartbeats).
    // These are internal control signals aimed at the model, not real user
    // input — filtering them out keeps the visible transcript clean.
    if (SynthesizedUserMessagePatterns.some((re) => re.test(text))) {
      return [];
    }

    const sanitized = this.sanitizeUserMessageText(text, channelType);
    const normalizedParts: NormalizedTextPart[] = [];

    if (sanitized.replyContext) {
      normalizedParts.push({
        type: "replyContext",
        text: sanitized.replyContext,
      });
    }
    if (sanitized.text.length > 0) {
      normalizedParts.push({
        type: "text",
        text: sanitized.text,
      });
    }

    return normalizedParts;
  }

  private sanitizeUserMessageText(
    text: string,
    channelType?: string | null,
  ): SanitizedUserMessageText {
    const replyContextFromMetadata = this.extractReplyContextFromMetadata(text);
    const withoutMetadata = this.stripTranscriptMetadataBlocks(text);
    const withoutChannelSuffix = this.stripChannelSystemSuffix(
      withoutMetadata,
      channelType,
    );

    let normalizedText = withoutChannelSuffix.trim();
    const markerMatch = withoutChannelSuffix.match(
      /\[message_id:\s*[^\]]+\](?:\n|\\n)(.+?):\s*([\s\S]*)$/,
    );
    if (markerMatch?.[2] != null) {
      normalizedText = markerMatch[2].trim();
    } else {
      const timestampMatch = withoutChannelSuffix.match(
        /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*([\s\S]*)$/,
      );
      if (timestampMatch?.[1] != null) {
        normalizedText = timestampMatch[1].trim();
      }
    }

    const extractedReplyContext = this.extractReplyContextPrefix(
      normalizedText
        .replace(USER_MEDIA_ATTACHMENT_MARKER_PATTERN, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
      channelType,
    );

    return {
      text: extractedReplyContext.text.trim(),
      replyContext:
        replyContextFromMetadata ?? extractedReplyContext.replyContext,
    };
  }

  private stripAssistantReplyPrefix(text: string): string {
    return text.replace(/^\s*\[\[reply_to_current\]\]\s*/u, "");
  }

  private stripTranscriptMetadataBlocks(text: string): string {
    return text
      .replace(
        /Conversation info \(untrusted metadata\):\s*```json\s*[\s\S]*?```\s*/gu,
        "",
      )
      .replace(
        /Sender \(untrusted metadata\):\s*```json\s*[\s\S]*?```\s*/gu,
        "",
      )
      .replace(
        /Replied message \(untrusted, for context\):\s*```json\s*[\s\S]*?```\s*/gu,
        "",
      );
  }

  private stripChannelSystemSuffix(
    text: string,
    channelType?: string | null,
  ): string {
    if (channelType?.toLowerCase() !== "feishu") {
      return text;
    }

    let normalized = text.trimEnd();
    normalized = normalized.replace(FEISHU_SELF_MENTION_SYSTEM_LINE, "");
    normalized = normalized.replace(FEISHU_MENTION_TAGS_SYSTEM_LINE, "");

    return normalized.trimEnd();
  }

  private extractReplyContextFromMetadata(text: string): string | null {
    const replyMeta = this.parseJsonMetadataBlock(
      text,
      "Replied message (untrusted, for context)",
    );
    if (!replyMeta) {
      return null;
    }

    return (
      this.readStringValue(replyMeta, "body") ??
      this.readStringValue(replyMeta, "text") ??
      this.readStringValue(replyMeta, "message") ??
      this.readStringValue(replyMeta, "title") ??
      this.readStringValue(replyMeta, "content") ??
      null
    );
  }

  private extractReplyContextPrefix(
    text: string,
    channelType?: string | null,
  ): SanitizedUserMessageText {
    const normalizedChannelType = channelType?.toLowerCase() ?? "";
    const matchers = [
      normalizedChannelType === "feishu"
        ? this.matchEnglishReplyContextPrefix(text)
        : null,
      normalizedChannelType === "openclaw-weixin" ||
      normalizedChannelType === "wechat"
        ? this.matchChineseReplyContextPrefix(text)
        : null,
      normalizedChannelType.length === 0
        ? (this.matchEnglishReplyContextPrefix(text) ??
          this.matchChineseReplyContextPrefix(text))
        : null,
    ].filter((match): match is SanitizedUserMessageText => match != null);

    return (
      matchers[0] ?? {
        text,
        replyContext: null,
      }
    );
  }

  private matchEnglishReplyContextPrefix(
    text: string,
  ): SanitizedUserMessageText | null {
    const match = text.match(
      /^\[Replying to:\s*(?:"([\s\S]*?)"|([^\]]+))\]\s*(?:(?:\r?\n)|\\n)+([\s\S]*)$/u,
    );
    const replyContext = (match?.[1] ?? match?.[2] ?? "").trim();
    const body = (match?.[3] ?? "").trim();
    if (!match || replyContext.length === 0) {
      return null;
    }

    return {
      text: body,
      replyContext,
    };
  }

  private matchChineseReplyContextPrefix(
    text: string,
  ): SanitizedUserMessageText | null {
    const match = text.match(
      /^\[引用:\s*([\s\S]*?)\]\s*(?:(?:\r?\n)|\\n)+([\s\S]*)$/u,
    );
    const replyContext = (match?.[1] ?? "").trim();
    const body = (match?.[2] ?? "").trim();
    if (!match || replyContext.length === 0) {
      return null;
    }

    return {
      text: body,
      replyContext,
    };
  }

  async getSession(
    id: string,
    includeArchived = false,
  ): Promise<SessionResponse | null> {
    const sessions = await this.listSessions(
      false,
      includeArchived ? "include" : "exclude",
    );
    return sessions.find((session) => session.id === id) ?? null;
  }

  /**
   * Look up a session by its OpenClaw sessionKey without pre-creating it.
   *
   * Reads sessions.json to find the UUID that OpenClaw assigned to this
   * sessionKey, then fetches the session from the full sessions list.
   * Returns null if OpenClaw has not yet created a session for this key.
   */
  async getSessionBySessionKey(
    botId: string,
    sessionKey: string,
  ): Promise<SessionResponse | null> {
    if (this.gateway) {
      // A cached empty list must not hide a just-accepted chat.send.
      const sessions = await this.listSessions(true);
      return (
        sessions.find(
          (session) =>
            session.botId === botId && session.sessionKey === sessionKey,
        ) ?? null
      );
    }
    const sessionsDir = path.join(
      this.env.openclawStateDir,
      "agents",
      botId,
      "sessions",
    );
    const index = await this.readSessionsIndex(sessionsDir);
    const entry = index[sessionKey];
    if (!entry) {
      return null;
    }
    // Find the UUID file id (sessions.json stores sessionFile or sessionId).
    // Use path.basename on both fields to strip any path traversal attempts.
    let sessionFileId: string | null = null;
    if (typeof entry.sessionFile === "string" && entry.sessionFile.trim()) {
      sessionFileId = path.basename(entry.sessionFile);
    } else if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
      sessionFileId = `${path.basename(entry.sessionId)}.jsonl`;
    }
    if (!sessionFileId) {
      return null;
    }
    const sessions = await this.listSessions();
    return (
      sessions.find(
        (session) => session.id === sessionFileId && session.botId === botId,
      ) ?? null
    );
  }

  private async getSessionByKey(
    botId: string,
    sessionKey: string,
  ): Promise<SessionResponse | null> {
    const id = `${sessionKey}.jsonl`;
    const sessions = await this.listSessions();
    return (
      sessions.find(
        (session) => session.id === id && session.botId === botId,
      ) ?? null
    );
  }

  private getSessionFilePath(botId: string, sessionKey: string): string {
    return path.join(
      this.env.openclawStateDir,
      "agents",
      botId,
      "sessions",
      `${sessionKey}.jsonl`,
    );
  }

  /**
   * Resolve the actual JSONL file path for a session.
   *
   * OpenClaw stores conversation history in UUID-named files
   * (e.g. `sessions/{uuid}.jsonl`), but its `sessions.json` index maps
   * sessionKey → `{ sessionId, sessionFile, … }`.  When the sessionKey is a
   * "named" key (like `agent:{id}:main`), the key-based path will be empty
   * because OpenClaw never writes to it — it writes to the UUID path instead.
   *
   * Algorithm:
   * 1. Read sessions.json from the agent's sessions directory.
   * 2. If the index has an entry for this sessionKey with a `sessionFile` or
   *    `sessionId`, return that path — after verifying it stays within the
   *    expected state directory (path traversal guard).
   * 3. Otherwise fall back to the legacy key-based path.
   */
  private async resolveSessionFilePath(
    botId: string,
    sessionKey: string,
  ): Promise<string> {
    const sessionsDir = path.join(
      this.env.openclawStateDir,
      "agents",
      botId,
      "sessions",
    );
    const index = await this.readSessionsIndex(sessionsDir);
    const entry = index[sessionKey];

    if (entry) {
      // Prefer the explicit sessionFile field if present
      if (typeof entry.sessionFile === "string" && entry.sessionFile.trim()) {
        const resolved = path.resolve(entry.sessionFile);
        // Guard: resolved path must stay inside openclawStateDir to prevent
        // path traversal attacks via a malicious sessions.json entry.
        const stateDir = path.resolve(this.env.openclawStateDir);
        if (resolved.startsWith(stateDir + path.sep) || resolved === stateDir) {
          return resolved;
        }
        // Suspicious path — fall through to safe alternatives
        logger.warn(
          { botId, sessionKey, resolved, stateDir },
          "resolveSessionFilePath: sessionFile escapes openclawStateDir, ignoring",
        );
      }
      // Fall back to constructing from sessionId — basename only, no traversal
      if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
        const sessionId = path.basename(entry.sessionId); // strip any dirs
        return path.join(sessionsDir, `${sessionId}.jsonl`);
      }
    }

    // Legacy fallback: {sessionKey}.jsonl
    return this.getSessionFilePath(botId, sessionKey);
  }

  private async resolveManagedSessionFilePath(params: {
    botId: string;
    sessionKey: string;
    sessionFile?: string;
  }): Promise<string> {
    if (!params.sessionFile) {
      return this.resolveSessionFilePath(params.botId, params.sessionKey);
    }
    const resolved = path.resolve(params.sessionFile);
    const stateDir = path.resolve(this.env.openclawStateDir);
    if (
      resolved !== stateDir &&
      !resolved.startsWith(`${stateDir}${path.sep}`)
    ) {
      throw new Error(
        "Session transcript is outside the managed state directory",
      );
    }
    return resolved;
  }

  private async readSessionsIndex(
    sessionsDir: string,
  ): Promise<Record<string, SessionsIndexEntry>> {
    const indexPath = path.join(sessionsDir, "sessions.json");
    try {
      const raw = await readFile(indexPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, SessionsIndexEntry>;
      return parsed;
    } catch (error) {
      if (isMissingPathError(error)) {
        return {};
      }
      throwSessionsRuntimeUnavailable("read-sessions-index", error);
    }
  }

  /**
   * Remove a sessionKey entry from OpenClaw's sessions.json index.
   *
   * OpenClaw owns sessions.json and writes to it during normal operation.
   * When the user deletes a session through the Nexu UI we must also
   * remove the index entry, otherwise the session would reappear after
   * an OpenClaw restart (the index entry still points to the now-deleted
   * file, and OpenClaw recreates it on next message).
   */
  private async removeSessionIndexEntry(
    botId: string,
    sessionKey: string,
  ): Promise<void> {
    const sessionsDir = path.join(
      this.env.openclawStateDir,
      "agents",
      botId,
      "sessions",
    );
    const indexPath = path.join(sessionsDir, "sessions.json");
    try {
      const raw = await readFile(indexPath, "utf8");
      const index = JSON.parse(raw) as Record<string, SessionsIndexEntry>;
      if (!(sessionKey in index)) {
        return;
      }
      delete index[sessionKey];
      await writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
    } catch (err) {
      logger.warn(
        { botId, sessionKey, err },
        "removeSessionIndexEntry: failed to update sessions.json",
      );
    }
  }

  private findSessionIndexEntry(
    index: Record<string, SessionsIndexEntry>,
    filePath: string,
    sessionKey: string,
  ): [string, SessionsIndexEntry] | undefined {
    return Object.entries(index).find(([, item]) => {
      if (item.sessionId === sessionKey) {
        return true;
      }
      if (
        typeof item.sessionId === "string" &&
        `${path.basename(item.sessionId)}.jsonl` === path.basename(filePath)
      ) {
        return true;
      }
      if (typeof item.sessionFile === "string") {
        return path.resolve(item.sessionFile) === path.resolve(filePath);
      }
      return false;
    });
  }

  /**
   * OpenClaw-maintained session name (explicit label/subject or the
   * utility-model generated displayName). Used as the title fallback for
   * sessions with no channel hints (webchat "agent:<botId>:main" and
   * per-conversation "agent:<botId>:<uuid>" keys).
   */
  private readIndexSessionName(
    index: Record<string, SessionsIndexEntry>,
    filePath: string,
    sessionKey: string,
  ): string | undefined {
    const entry = this.findSessionIndexEntry(index, filePath, sessionKey)?.[1];
    if (!entry) {
      return undefined;
    }
    for (const candidate of [entry.label, entry.displayName, entry.subject]) {
      // The utility-model title generator may emit a markdown heading
      // ("# 标题") that upstream normalizeDashboardSessionTitle does not
      // strip, so drop any leading heading marker on read-back.
      const normalized =
        typeof candidate === "string"
          ? candidate.replace(/^#{1,6}\s+/, "").trim()
          : undefined;
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }

  private inferSessionHintsFromIndex(
    index: Record<string, SessionsIndexEntry>,
    filePath: string,
    sessionKey: string,
  ): SessionHints {
    const matched = this.findSessionIndexEntry(index, filePath, sessionKey);

    if (!matched) {
      return {};
    }

    const [indexKey, entry] = matched;
    const openAiUserContext = this.parseOpenAiUserSessionContext(indexKey);
    const rawChannel =
      openAiUserContext?.channel ??
      entry.lastChannel ??
      entry.origin?.provider ??
      undefined;
    const normalizedChannel = this.normalizeInferredChannelType(rawChannel);
    const channelType =
      normalizedChannel === "dingtalk-connector"
        ? "dingtalk"
        : normalizedChannel;
    const senderName =
      openAiUserContext?.sendername ?? entry.origin?.label ?? undefined;
    const groupName = openAiUserContext?.groupsubject ?? undefined;

    return {
      senderName,
      groupName,
      channelType,
    };
  }

  private parseOpenAiUserSessionContext(
    indexKey: string,
  ): OpenAiUserSessionContext | null {
    const marker = ":openai-user:";
    const markerIndex = indexKey.indexOf(marker);
    if (markerIndex === -1) {
      return null;
    }

    const rawContext = indexKey.slice(markerIndex + marker.length).trim();
    if (!rawContext.startsWith("{")) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawContext) as OpenAiUserSessionContext;
      return typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }

  private async readSessionMetadata(
    filePath: string,
  ): Promise<SessionMetadata> {
    try {
      const raw = await readFile(sessionMetadataPath(filePath), "utf8");
      return JSON.parse(raw) as SessionMetadata;
    } catch {
      return {};
    }
  }

  private buildPublicMetadata(
    filePath: string,
    metadata: Record<string, unknown> | null | undefined,
  ): SessionMetadataRecord {
    return {
      ...(metadata ?? {}),
      source: "openclaw-filesystem",
      path: filePath,
    };
  }

  /**
   * Read the first few KB of a JSONL file and extract sender name and
   * channel type from the first user message's "Sender (untrusted metadata)"
   * block. This avoids reading the entire (potentially large) session file.
   */
  private async inferSessionHints(filePath: string): Promise<SessionHints> {
    const READ_BYTES = 16_384; // 16 KB is enough for the first ~20 lines
    let chunk: string;
    try {
      const fh = await open(filePath, "r");
      try {
        const buf = Buffer.alloc(READ_BYTES);
        const { bytesRead } = await fh.read(buf, 0, READ_BYTES, 0);
        chunk = buf.toString("utf8", 0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch {
      return {};
    }

    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      let entry: {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "message" || entry.message?.role !== "user") continue;

      const content = entry.message.content;
      const text = this.extractTextFromContent(content);
      if (!text) continue;

      return this.parseSessionHints(text);
    }
    return {};
  }

  private extractTextFromContent(content: unknown): string | undefined {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as { type: string }).type === "text" &&
          "text" in part
        ) {
          return (part as { text: string }).text;
        }
      }
    }
    return undefined;
  }

  private parseSessionHints(text: string): SessionHints {
    const senderMeta = this.parseJsonMetadataBlock(
      text,
      "Sender (untrusted metadata)",
    );
    const conversationMeta = this.parseJsonMetadataBlock(
      text,
      "Conversation info (untrusted metadata)",
    );

    const senderName =
      this.readStringValue(senderMeta, "name") ??
      this.readStringValue(senderMeta, "label") ??
      this.readStringValue(conversationMeta, "sender") ??
      undefined;
    const qqbotPeerId =
      this.readStringValue(conversationMeta, "sender_id") ??
      this.readStringValue(senderMeta, "id") ??
      undefined;
    const qqbotGroupOpenid =
      this.readStringValue(conversationMeta, "group_openid") ?? undefined;

    // Extract group name from conversation metadata, with multi-source fallback
    const rawGroupName =
      this.readStringValue(conversationMeta, "group_name") ??
      this.readStringValue(conversationMeta, "chat_name") ??
      this.readStringValue(conversationMeta, "group_subject") ??
      this.readStringValue(conversationMeta, "conversation_label") ??
      undefined;

    // Filter out platform-internal IDs that look like identifiers rather than
    // human-readable group names:
    //   oc_ / ou_  — OpenClaw / Feishu internal IDs (hex suffix)
    //   C/G/D + [A-Z0-9]{8,} — Slack IDs: channels (C), groups (G), DMs (D)
    const isIdLike =
      rawGroupName !== undefined &&
      /^(?:oc_|ou_)[a-f0-9]+$|^[CGD][A-Z0-9]{8,}$/.test(rawGroupName);
    const groupName = isIdLike ? undefined : rawGroupName;

    let channelType: string | undefined;
    const combined = [
      this.readStringValue(senderMeta, "label") ?? "",
      this.readStringValue(senderMeta, "id") ?? "",
      this.readStringValue(conversationMeta, "sender_id") ?? "",
      this.readStringValue(conversationMeta, "conversation_label") ?? "",
      this.readStringValue(conversationMeta, "group_subject") ?? "",
      text,
    ]
      .join(" ")
      .toLowerCase();
    if (
      combined.includes("feishu") ||
      /\b(?:ou|oc)_[a-f0-9]{32}\b/.test(combined)
    ) {
      channelType = "feishu";
    } else if (
      combined.includes("openclaw-weixin") ||
      combined.includes("wechat")
    ) {
      channelType = "openclaw-weixin";
    } else if (combined.includes("slack")) {
      channelType = "slack";
    } else if (combined.includes("discord")) {
      channelType = "discord";
    } else if (
      combined.includes("whatsapp") ||
      combined.includes("@s.whatsapp.net") ||
      combined.includes("@g.us")
    ) {
      channelType = "whatsapp";
    } else if (combined.includes("qqbot")) {
      channelType = "qqbot";
    } else if (combined.includes("telegram")) {
      channelType = "telegram";
    }

    let qqbotMessageType: "c2c" | "group" | undefined;
    if (channelType === "qqbot") {
      if (qqbotGroupOpenid || /qqbot:group:/i.test(combined)) {
        qqbotMessageType = "group";
      } else if (qqbotPeerId || /qqbot:c2c:/i.test(combined)) {
        qqbotMessageType = "c2c";
      }
    }

    return {
      senderName,
      groupName,
      channelType: this.normalizeInferredChannelType(channelType),
      metadata: this.extractExactChatTargetMetadata(
        senderMeta,
        conversationMeta,
      ),
      feishuMessageId:
        this.readStringValue(conversationMeta, "message_id") ?? undefined,
      qqbotPeerId,
      qqbotGroupOpenid,
      qqbotMessageType,
    };
  }

  private resolveQqbotDisplayNames(
    hints: SessionHints,
    knownUsers: QqbotKnownUser[],
  ): { senderName?: string; groupName?: string } | null {
    const senderName = hints.senderName?.trim();
    const groupName = hints.groupName?.trim();
    const senderReadable =
      senderName && !this.isOpaqueQqbotValue(senderName, "user")
        ? senderName
        : undefined;
    const groupReadable =
      groupName && !this.isOpaqueQqbotValue(groupName, "group")
        ? groupName
        : undefined;

    if (senderReadable || groupReadable) {
      return {
        senderName: senderReadable,
        groupName: groupReadable,
      };
    }

    const knownUserNickname = this.findQqbotKnownUserNickname(
      knownUsers,
      hints.qqbotPeerId ?? extractQqbotOpaqueId(senderName),
      hints.qqbotMessageType ?? "c2c",
      hints.qqbotGroupOpenid ?? extractQqbotOpaqueId(groupName),
    );

    return {
      senderName: senderReadable ?? knownUserNickname ?? senderName,
      groupName: groupReadable ?? groupName,
    };
  }

  private normalizeInferredChannelType(
    channelType: string | undefined,
  ): string | undefined {
    if (!channelType) {
      return undefined;
    }

    const normalized = channelType.trim().toLowerCase();
    if (normalized === "wechat") {
      return "openclaw-weixin";
    }
    if (normalized === "dingtalk-connector") {
      return "dingtalk";
    }

    return normalized || undefined;
  }

  private parseJsonMetadataBlock(
    text: string,
    title: string,
  ): SessionMetadataRecord | null {
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(
      new RegExp(`${escapedTitle}:\\s*\`\`\`json\\s*\\n([\\s\\S]*?)\`\`\``),
    );
    const jsonBlock = match?.[1];
    if (!jsonBlock) {
      return null;
    }

    try {
      return JSON.parse(jsonBlock) as SessionMetadataRecord;
    } catch {
      return null;
    }
  }

  private shouldReplaceInferredTitle(
    title: string | undefined,
    sessionKey: string,
  ): boolean {
    if (!title) {
      return true;
    }

    const normalized = title.trim();
    if (!normalized) {
      return true;
    }

    return (
      normalized === sessionKey ||
      UUID_LIKE_TITLE_PATTERN.test(normalized) ||
      // Heal sessions whose persisted title is the raw opaque wechat id.
      normalized.endsWith("@im.wechat") ||
      // Heal sessions whose persisted title is the raw opaque qqbot open id.
      QQBOT_OPAQUE_TITLE_PATTERN.test(normalized)
    );
  }

  private extractExactChatTargetMetadata(
    senderMeta: SessionMetadataRecord | null,
    conversationMeta: SessionMetadataRecord | null,
  ): SessionMetadataRecord | undefined {
    const metadata: SessionMetadataRecord = {};

    const openChatId = [
      this.readStringValue(conversationMeta, "openChatId"),
      this.readStringValue(conversationMeta, "open_chat_id"),
      this.readStringValue(conversationMeta, "chatId"),
      this.readStringValue(conversationMeta, "chat_id"),
      this.readStringValue(conversationMeta, "conversation_label"),
      this.readStringValue(conversationMeta, "group_subject"),
    ].find((value) => value?.startsWith("oc_"));
    if (openChatId) {
      metadata.openChatId = openChatId;
    }

    const openId = [
      this.readStringValue(conversationMeta, "openId"),
      this.readStringValue(conversationMeta, "open_id"),
      this.readStringValue(conversationMeta, "sender_id"),
      this.readStringValue(senderMeta, "openId"),
      this.readStringValue(senderMeta, "open_id"),
      this.readStringValue(senderMeta, "id"),
    ].find((value) => value?.startsWith("ou_"));
    if (openId) {
      metadata.openId = openId;
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private mergeSessionMetadata(
    existing: SessionMetadataRecord | null | undefined,
    inferred: SessionMetadataRecord | undefined,
  ): { metadata: SessionMetadataRecord | null; changed: boolean } {
    if (!inferred || Object.keys(inferred).length === 0) {
      return { metadata: existing ?? null, changed: false };
    }

    const merged: SessionMetadataRecord = {
      ...(existing ?? {}),
    };
    let changed = false;

    for (const [key, value] of Object.entries(inferred)) {
      const current = merged[key];
      if (typeof current === "string" && current.trim().length > 0) {
        continue;
      }
      merged[key] = value;
      changed = true;
    }

    return { metadata: merged, changed };
  }

  private async resolveExactChatMetadata(
    botId: string,
    existing: SessionMetadataRecord | null | undefined,
    hints: SessionHints,
  ): Promise<SessionMetadataRecord | undefined> {
    const existingOpenChatId =
      this.readStringValue(existing, "openChatId") ??
      this.readStringValue(existing, "open_chat_id") ??
      this.readStringValue(existing, "chatId") ??
      this.readStringValue(existing, "chat_id");
    if (existingOpenChatId?.startsWith("oc_")) {
      return hints.metadata;
    }

    const hintedOpenChatId = this.readStringValue(hints.metadata, "openChatId");
    if (hintedOpenChatId?.startsWith("oc_")) {
      return hints.metadata;
    }

    if (hints.channelType !== "feishu" || !hints.feishuMessageId) {
      return hints.metadata;
    }

    const openChatId = await this.fetchFeishuOpenChatIdByMessageId(
      botId,
      hints.feishuMessageId,
    );
    if (!openChatId) {
      return hints.metadata;
    }

    return {
      ...(hints.metadata ?? {}),
      openChatId,
    };
  }

  private async fetchFeishuOpenChatIdByMessageId(
    botId: string,
    messageId: string,
  ): Promise<string | null> {
    const credentials = await this.getFeishuCredentials(botId);
    if (!credentials) {
      return null;
    }

    const tenantToken = await this.getFeishuTenantToken(
      credentials.appId,
      credentials.appSecret,
    );
    if (!tenantToken) {
      return null;
    }

    try {
      const response = await proxyFetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        {
          headers: {
            Authorization: `Bearer ${tenantToken}`,
          },
        },
      );
      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as {
        code?: number;
        data?: {
          chat_id?: string;
          message?: {
            chat_id?: string;
          };
          items?: Array<{
            chat_id?: string;
          }>;
        };
      };
      if (payload.code !== 0) {
        return null;
      }

      const openChatId =
        payload.data?.chat_id ??
        payload.data?.message?.chat_id ??
        payload.data?.items?.[0]?.chat_id;
      return typeof openChatId === "string" && openChatId.startsWith("oc_")
        ? openChatId
        : null;
    } catch {
      return null;
    }
  }

  private async getFeishuCredentials(
    botId: string,
  ): Promise<{ appId: string; appSecret: string } | null> {
    const config = await this.readControllerConfig();
    const channel = config?.channels?.find(
      (item) => item.botId === botId && item.channelType === "feishu",
    );
    if (!channel?.id) {
      return null;
    }

    const appId = config?.secrets?.[`channel:${channel.id}:appId`];
    const appSecret = config?.secrets?.[`channel:${channel.id}:appSecret`];
    if (
      typeof appId !== "string" ||
      appId.length === 0 ||
      typeof appSecret !== "string" ||
      appSecret.length === 0
    ) {
      return null;
    }

    return { appId, appSecret };
  }

  private async readControllerConfig(): Promise<ControllerConfigRecord | null> {
    try {
      const raw = await readFile(this.env.nexuConfigPath, "utf8");
      return JSON.parse(raw) as ControllerConfigRecord;
    } catch {
      return null;
    }
  }

  private async getFeishuTenantToken(
    appId: string,
    appSecret: string,
  ): Promise<string | null> {
    const cached = this.feishuTokenCache.get(appId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    try {
      const response = await proxyFetch(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            app_id: appId,
            app_secret: appSecret,
          }),
        },
      );
      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as {
        code?: number;
        tenant_access_token?: string;
        expire?: number;
      };
      if (
        payload.code !== 0 ||
        typeof payload.tenant_access_token !== "string" ||
        payload.tenant_access_token.length === 0
      ) {
        return null;
      }

      const expiresAt =
        Date.now() + Math.max((payload.expire ?? 7200) - 60, 60) * 1000;
      this.feishuTokenCache.set(appId, {
        token: payload.tenant_access_token,
        expiresAt,
      });
      return payload.tenant_access_token;
    } catch {
      return null;
    }
  }

  private readStringValue(
    record: SessionMetadataRecord | null | undefined,
    key: string,
  ): string | null {
    if (!record) {
      return null;
    }

    const value = record[key];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  }

  private isOpaqueQqbotValue(value: string, kind: "user" | "group"): boolean {
    const normalized = normalizeQqbotDisplayName(value, kind);
    return normalized !== undefined && normalized !== value.trim();
  }

  private findQqbotKnownUserNickname(
    users: QqbotKnownUser[],
    openid: string | undefined,
    type: "c2c" | "group",
    groupOpenid?: string,
  ): string | undefined {
    if (!openid) {
      return undefined;
    }

    const exactMatch = users.find((user) => {
      if (user.openid !== openid || user.type !== type) {
        return false;
      }
      if (type === "group" && groupOpenid) {
        return user.groupOpenid === groupOpenid;
      }
      return true;
    });
    const nickname = exactMatch?.nickname?.trim();
    return nickname && !this.isOpaqueQqbotValue(nickname, "user")
      ? nickname
      : undefined;
  }

  private async readQqbotKnownUsers(): Promise<QqbotKnownUser[]> {
    const homeDir = process.env.HOME?.trim() || homedir();
    const filePath = path.join(
      homeDir,
      ".openclaw",
      "qqbot",
      "data",
      "known-users.json",
    );

    try {
      await access(filePath);
    } catch {
      this.qqbotKnownUsersCache = null;
      return [];
    }

    try {
      const fileStat = await stat(filePath);
      if (
        this.qqbotKnownUsersCache &&
        this.qqbotKnownUsersCache.filePath === filePath &&
        this.qqbotKnownUsersCache.mtimeMs === fileStat.mtimeMs
      ) {
        return this.qqbotKnownUsersCache.users;
      }

      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const users = Array.isArray(parsed)
        ? parsed.filter((item): item is QqbotKnownUser => {
            if (typeof item !== "object" || item === null) {
              return false;
            }
            const record = item as Record<string, unknown>;
            return (
              typeof record.openid === "string" &&
              (record.type === "c2c" || record.type === "group")
            );
          })
        : [];

      this.qqbotKnownUsersCache = {
        filePath,
        mtimeMs: fileStat.mtimeMs,
        users,
      };

      return users;
    } catch {
      return [];
    }
  }

  private async writeSessionMetadata(
    filePath: string,
    metadata: SessionMetadata,
  ): Promise<void> {
    await writeFile(
      sessionMetadataPath(filePath),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
  }
}
