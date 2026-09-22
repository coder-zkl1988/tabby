import type {
  CreateSessionInput,
  SessionArchiveFilter,
  SessionCheckpoint,
  SessionKind,
  SessionOrganizationPatch,
  SessionRunState,
  UpdateSessionInput,
} from "@nexu/shared";
import {
  isDesktopSessionKey,
  mintDerivedSessionKey,
} from "../lib/desktop-session-key.js";
import { logger } from "../lib/logger.js";
import {
  SessionMessageNotFoundError,
  type SessionsRuntime,
} from "../runtime/sessions-runtime.js";
import type {
  OpenClawGatewayService,
  SessionCompactionCheckpointSnapshot,
} from "./openclaw-gateway-service.js";
import type { SessionRunRegistry } from "./session-run-registry.js";

function normalizeCheckpoint(
  checkpoint: SessionCompactionCheckpointSnapshot,
): SessionCheckpoint {
  return {
    id: checkpoint.checkpointId,
    createdAt: new Date(checkpoint.createdAt).toISOString(),
    reason: checkpoint.reason,
    ...(checkpoint.tokensBefore !== undefined
      ? { tokensBefore: checkpoint.tokensBefore }
      : {}),
    ...(checkpoint.tokensAfter !== undefined
      ? { tokensAfter: checkpoint.tokensAfter }
      : {}),
    ...(checkpoint.summary !== undefined
      ? { summary: checkpoint.summary }
      : {}),
  };
}

function rethrowMessageMutationError(error: unknown): never {
  if (
    error instanceof Error &&
    /message entry not found|message entry is not on the active path|entry is not a user message/i.test(
      error.message,
    )
  ) {
    throw new SessionMessageNotFoundError();
  }
  throw error;
}

export class SessionService {
  constructor(
    private readonly sessionsRuntime: SessionsRuntime,
    /** Optional: session management RPC (rename/archive/fork) is skipped when absent. */
    private readonly gatewayService?: OpenClawGatewayService,
    private readonly runRegistry?: SessionRunRegistry,
  ) {}

  async listSessions(params: {
    limit: number;
    offset: number;
    botId?: string;
    channelType?: string;
    status?: string;
    search?: string;
    archived?: SessionArchiveFilter;
    category?: string;
    kind?: SessionKind;
    runState?: SessionRunState;
    pinned?: boolean;
    unread?: boolean;
  }) {
    let sessions = await this.sessionsRuntime.listSessions(
      false,
      params.archived ?? "exclude",
    );

    sessions = sessions.map((session) => ({
      ...session,
      runState: this.runRegistry?.isBusy(session.sessionKey)
        ? "running"
        : (session.runState ?? "idle"),
    }));

    if (params.botId) {
      sessions = sessions.filter((session) => session.botId === params.botId);
    }
    if (params.channelType) {
      sessions = sessions.filter(
        (session) => session.channelType === params.channelType,
      );
    }
    if (params.status) {
      sessions = sessions.filter((session) => session.status === params.status);
    }
    if (params.search) {
      const search = params.search.trim().toLocaleLowerCase();
      if (search) {
        sessions = sessions.filter(
          (session) =>
            session.title.toLocaleLowerCase().includes(search) ||
            session.category?.toLocaleLowerCase().includes(search) ||
            session.channelType?.toLocaleLowerCase().includes(search),
        );
      }
    }
    if (params.category) {
      sessions = sessions.filter(
        (session) => session.category === params.category,
      );
    }
    if (params.kind) {
      sessions = sessions.filter((session) => {
        const scheduled = session.sessionKey.includes(":schedule-");
        return params.kind === "scheduled" ? scheduled : !scheduled;
      });
    }
    if (params.runState) {
      sessions = sessions.filter(
        (session) => session.runState === params.runState,
      );
    }
    if (params.pinned !== undefined) {
      sessions = sessions.filter((session) => session.pinned === params.pinned);
    }
    if (params.unread !== undefined) {
      sessions = sessions.filter((session) => session.unread === params.unread);
    }

    sessions.sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    });

    return {
      sessions: sessions.slice(params.offset, params.offset + params.limit),
      total: sessions.length,
      limit: params.limit,
      offset: params.offset,
    };
  }

  async getSession(id: string) {
    return this.sessionsRuntime.getSession(id);
  }

  async createSession(input: CreateSessionInput) {
    return this.sessionsRuntime.createOrUpdateSession(input);
  }

  async updateSession(id: string, input: UpdateSessionInput) {
    const session = await this.sessionsRuntime.updateSession(id, input);
    // Mirror a rename into OpenClaw's session store label so gateway-side
    // views (Control UI, deriveSessionTitle) agree with nexu. Best-effort:
    // the .meta.json title above stays nexu's display authority.
    if (
      session &&
      input.title &&
      !this.sessionsRuntime.usesGatewayPersistence?.() &&
      this.gatewayService?.isConnected()
    ) {
      try {
        await this.gatewayService.sessionsPatch({
          key: session.sessionKey,
          agentId: session.botId,
          label: input.title,
        });
      } catch (err) {
        logger.warn(
          { id, error: err instanceof Error ? err.message : String(err) },
          "session_rename_gateway_label_patch_failed",
        );
      }
    }
    return session;
  }

  /**
   * Archive / unarchive via the OpenClaw session store (>=2026.7.1).
   * Archived sessions disappear from listSessions (index entry archivedAt).
   * Throws with OpenClaw's message when blocked (main session / active run).
   */
  async setSessionArchived(id: string, archived: boolean) {
    const session = await this.sessionsRuntime.getSession(id, !archived);
    if (!session) return null;
    if (!this.gatewayService?.isConnected()) {
      throw new Error("OpenClaw gateway is not connected");
    }
    await this.gatewayService.sessionsPatch({
      key: session.sessionKey,
      agentId: session.botId,
      archived,
    });
    this.sessionsRuntime.invalidateSessionsCache();
    return { ...session, archived };
  }

  async updateOrganization(id: string, input: SessionOrganizationPatch) {
    const session = await this.sessionsRuntime.getSession(id, true);
    if (!session) return null;
    if (!this.gatewayService?.isConnected()) {
      throw new Error("OpenClaw gateway is not connected");
    }
    await this.gatewayService.sessionsPatch({
      key: session.sessionKey,
      agentId: session.botId,
      ...(input.clearCategory
        ? { category: null }
        : input.category !== undefined
          ? { category: input.category }
          : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.unread !== undefined ? { unread: input.unread } : {}),
    });
    this.sessionsRuntime.invalidateSessionsCache();
    return { ok: true };
  }

  async listCheckpoints(id: string) {
    const session = await this.sessionsRuntime.getSession(id, true);
    if (!session) return null;
    if (!this.gatewayService?.isConnected()) {
      throw new Error("OpenClaw gateway is not connected");
    }
    const result = await this.gatewayService.sessionsCompactionList({
      key: session.sessionKey,
      agentId: session.botId,
    });
    return {
      checkpoints: (result.checkpoints ?? []).map(normalizeCheckpoint),
    };
  }

  async branchFromCheckpoint(id: string, checkpointId: string) {
    const session = await this.sessionsRuntime.getSession(id, true);
    if (!session) return null;
    if (!this.gatewayService?.isConnected()) {
      throw new Error("OpenClaw gateway is not connected");
    }
    const result = await this.gatewayService.sessionsCompactionBranch({
      key: session.sessionKey,
      agentId: session.botId,
      checkpointId,
    });
    if (!result.key || !result.sessionId || !result.checkpoint) {
      throw new Error("OpenClaw did not return the recovery branch details");
    }
    const title = `${session.title} · recovery`;
    let materializedId: string | null = null;
    try {
      materializedId = this.sessionsRuntime.usesGatewayPersistence?.()
        ? `${result.sessionId}.jsonl`
        : await this.sessionsRuntime.materializeSessionFile(
            result.entry?.sessionFile,
            title,
          );
      await this.gatewayService.sessionsPatch({
        key: result.key,
        agentId: session.botId,
        label: title,
      });
    } catch (err) {
      logger.warn(
        {
          id,
          recoverySessionKey: result.key,
          error: err instanceof Error ? err.message : String(err),
        },
        "session_recovery_branch_metadata_update_failed",
      );
    }
    this.sessionsRuntime.invalidateSessionsCache();
    return {
      id: materializedId ?? `${result.sessionId}.jsonl`,
      botId: session.botId,
      sessionKey: result.key,
      title,
      checkpoint: normalizeCheckpoint(result.checkpoint),
    };
  }

  /**
   * Fork a session (OpenClaw >=2026.7.1): creates a new session whose context
   * inherits from the parent chain. Materializes the forked session's
   * transcript file so it appears in the sidebar immediately.
   */
  async forkSession(id: string) {
    const session = await this.sessionsRuntime.getSession(id);
    if (!session) return null;
    this.assertSessionNotRunning(session.sessionKey);
    if (!this.gatewayService?.isConnected()) {
      throw new Error("OpenClaw gateway is not connected");
    }
    const forkKey = mintDerivedSessionKey(
      session.botId,
      session.sessionKey,
      "fork",
    );
    const created = await this.gatewayService.sessionsCreate({
      key: forkKey,
      agentId: session.botId,
      parentSessionKey: session.sessionKey,
      fork: true,
    });
    const sessionFile = created.entry?.sessionFile;
    const forkTitle = `${session.title} · fork`;
    const materialized = this.sessionsRuntime.usesGatewayPersistence?.()
      ? created.sessionId
        ? `${created.sessionId}.jsonl`
        : created.entry?.sessionId
          ? `${created.entry.sessionId}.jsonl`
          : null
      : await this.sessionsRuntime.materializeSessionFile(
          sessionFile,
          forkTitle,
        );
    if (!materialized) {
      throw new Error("OpenClaw did not return the forked session details");
    }
    if (this.sessionsRuntime.usesGatewayPersistence?.()) {
      await this.gatewayService.sessionsPatch({
        key: created.key ?? forkKey,
        agentId: session.botId,
        label: forkTitle,
      });
    }
    this.sessionsRuntime.invalidateSessionsCache();
    return {
      id: materialized,
      botId: session.botId,
      sessionKey: created.key ?? forkKey,
      title: forkTitle,
    };
  }

  async branchAtMessage(id: string, messageId: string) {
    const session = await this.sessionsRuntime.getSession(id);
    if (!session) return null;
    this.assertSessionNotRunning(session.sessionKey);
    if (!this.gatewayService?.isConnected()) {
      throw new Error("OpenClaw gateway is not connected");
    }
    // The native fork RPC owns its target key. Do not turn a channel
    // transcript into a desktop-origin conversation through this action.
    if (
      !isDesktopSessionKey(session.sessionKey) &&
      !/^agent:[^:]+:dashboard:[0-9a-f-]+$/i.test(session.sessionKey)
    ) {
      throw new Error(
        "Message branches are only available for desktop conversations",
      );
    }
    let created: Awaited<ReturnType<OpenClawGatewayService["sessionsFork"]>>;
    try {
      created = await this.gatewayService.sessionsFork({
        sessionKey: session.sessionKey,
        agentId: session.botId,
        entryId: messageId,
      });
    } catch (error) {
      rethrowMessageMutationError(error);
    }
    const branchTitle = `${session.title} · branch`;
    await this.gatewayService.sessionsPatch({
      key: created.sessionKey,
      agentId: session.botId,
      label: branchTitle,
    });
    this.sessionsRuntime.invalidateSessionsCache();
    const branch = await this.sessionsRuntime.getSessionBySessionKey(
      session.botId,
      created.sessionKey,
    );
    if (!branch)
      throw new Error("OpenClaw did not return the message branch details");
    return {
      id: branch.id,
      botId: session.botId,
      sessionKey: created.sessionKey,
      title: branchTitle,
      messageId,
      editorText: created.editorText,
      editorAttachments: created.editorAttachments,
    };
  }

  async rollbackToMessage(id: string, messageId: string) {
    const session = await this.sessionsRuntime.getSession(id);
    if (!session) return null;
    this.assertSessionNotRunning(session.sessionKey);
    if (!this.gatewayService?.isConnected()) {
      throw new Error("OpenClaw gateway is not connected");
    }
    let result: Awaited<ReturnType<OpenClawGatewayService["sessionsRewind"]>>;
    try {
      result = await this.gatewayService.sessionsRewind({
        sessionKey: session.sessionKey,
        agentId: session.botId,
        entryId: messageId,
      });
    } catch (error) {
      rethrowMessageMutationError(error);
    }
    this.sessionsRuntime.invalidateSessionsCache();
    // Rewind replaces the underlying SQLite transcript identity.
    const restored = await this.sessionsRuntime.getSessionBySessionKey(
      session.botId,
      session.sessionKey,
    );
    if (!restored)
      throw new Error("OpenClaw did not return the rewound session details");
    return {
      ok: true as const,
      id: restored.id,
      sessionKey: session.sessionKey,
      messageId,
      editorText: result.editorText,
      editorAttachments: result.editorAttachments,
    };
  }

  async resetSession(id: string) {
    return this.sessionsRuntime.resetSession(id);
  }

  async deleteSession(id: string) {
    return this.sessionsRuntime.deleteSession(id);
  }

  async getSessionBySessionKey(botId: string, sessionKey: string) {
    return this.sessionsRuntime.getSessionBySessionKey(botId, sessionKey);
  }

  async getChatHistory(id: string, limit?: number) {
    return this.sessionsRuntime.getChatHistory(id, limit);
  }

  async getChatHistoryBySessionKey(
    botId: string,
    sessionKey: string,
    limit?: number,
  ) {
    return this.sessionsRuntime.getChatHistoryBySessionKey(
      botId,
      sessionKey,
      limit,
    );
  }

  async getFullMainChatHistory(botId: string, limit?: number) {
    return this.sessionsRuntime.getFullMainChatHistory(botId, limit);
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
  }) {
    return this.sessionsRuntime.appendCompatTranscript(input);
  }

  private assertSessionNotRunning(sessionKey: string): void {
    if (this.runRegistry?.isBusy(sessionKey)) {
      throw new Error(
        "Cannot switch message branches while the session is running",
      );
    }
  }
}
