import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import type { SessionsGatewayReader } from "../src/runtime/gateway-session-reader.js";
import {
  SessionsRuntime,
  SessionsRuntimeUnavailableError,
} from "../src/runtime/sessions-runtime.js";

describe("SessionsRuntime with gateway-owned SQLite persistence", () => {
  let stateDir: string;
  let env: ControllerEnv;
  let gateway: SessionsGatewayReader;
  const sessionKey = "agent:bot-1:conversation-1";
  const row = {
    key: sessionKey,
    sessionId: "session-1",
    channel: "webchat",
    label: "My test conversation",
    createdAt: 1_780_000_000_000,
    updatedAt: 1_780_000_002_000,
    pinned: true,
    unread: true,
    totalTokens: 12,
    hasActiveRun: true,
  };

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "nexu-gateway-sessions-"));
    env = {
      openclawStateDir: stateDir,
      nexuHomeDir: stateDir,
    } as ControllerEnv;
    gateway = {
      sessionsPatch: vi.fn(async () => ({ ok: true })),
      sessionsReset: vi.fn(async () => ({ ok: true })),
      sessionsDelete: vi.fn(async () => ({ ok: true })),
      listStoredSessions: vi.fn(async () => ({ sessions: [row] })),
      getStoredChatHistory: vi.fn(async () => ({
        messages: [
          {
            role: "user",
            content: "Hello from the new conversation",
            __openclaw: { id: "user-1", recordTimestampMs: row.createdAt },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Hello back" }],
            timestamp: row.updatedAt,
            __openclaw: { id: "assistant-1", seq: 4 },
          },
        ],
      })),
    };
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("discovers a new session without sessions.json or JSONL and preserves its ID across reopen", async () => {
    const runtime = new SessionsRuntime(env, gateway);
    const session = await runtime.getSessionBySessionKey("bot-1", sessionKey);
    expect(session).toMatchObject({
      id: "session-1.jsonl",
      botId: "bot-1",
      sessionKey,
      title: row.label,
      channelType: "webchat",
      pinned: true,
      unread: true,
      totalTokens: 12,
      runState: "running",
      metadata: { source: "openclaw-gateway" },
    });
    const reopened = new SessionsRuntime(env, gateway);
    expect(await reopened.getSession("session-1.jsonl")).toEqual(session);
    await expect(access(path.join(stateDir, "agents"))).rejects.toThrow();
  });

  it("reads gateway history after reopen with stable transcript IDs and timestamps", async () => {
    const runtime = new SessionsRuntime(env, gateway);
    const history = await runtime.getChatHistory("session-1.jsonl", 50);
    expect(gateway.getStoredChatHistory).toHaveBeenCalledWith(sessionKey, 50);
    expect(history.sessionKey).toBe(sessionKey);
    expect(history.messages).toMatchObject([
      {
        id: "user-1",
        role: "user",
        content: "Hello from the new conversation",
        timestamp: row.createdAt,
        createdAt: new Date(row.createdAt).toISOString(),
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "text", text: "Hello back" }],
        timestamp: row.updatedAt,
      },
    ]);
    expect(
      await runtime.getChatHistoryBySessionKey("bot-1", sessionKey, 50),
    ).toEqual(history);
  });

  it("refreshes an empty cache when a just-started session appears", async () => {
    vi.mocked(gateway.listStoredSessions)
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValueOnce({ sessions: [row] });
    const runtime = new SessionsRuntime(env, gateway);
    expect(await runtime.listSessions()).toEqual([]);
    expect(
      await runtime.getSessionBySessionKey("bot-1", sessionKey),
    ).toMatchObject({ id: "session-1.jsonl" });
  });

  it("continues paginating when hidden rows leave the visible history short", async () => {
    vi.mocked(gateway.getStoredChatHistory)
      .mockResolvedValueOnce({
        messages: [
          {
            role: "toolResult",
            toolName: "exec",
            content: "hidden",
            __openclaw: { id: "tool-1" },
          },
          {
            role: "assistant",
            content: "New reply",
            __openclaw: { id: "assistant-new" },
          },
        ],
        hasMore: true,
        nextOffset: 2,
        totalMessages: 20,
      })
      .mockResolvedValueOnce({
        messages: [
          {
            role: "user",
            content: "Older question",
            __openclaw: { id: "user-old" },
          },
          {
            role: "assistant",
            content: "Older answer",
            __openclaw: { id: "assistant-old" },
          },
        ],
        hasMore: false,
      });
    const runtime = new SessionsRuntime(env, gateway);
    const result = await runtime.getRunTranscriptMessages(
      "bot-1",
      "historic-run",
      3,
      sessionKey,
    );
    expect(result?.map((message) => message.id)).toEqual([
      "user-old",
      "assistant-old",
      "assistant-new",
    ]);
    expect(gateway.getStoredChatHistory).toHaveBeenNthCalledWith(
      2,
      sessionKey,
      3,
      "historic-run",
      2,
    );
  });

  it("reports a broken pagination cursor instead of returning a truncated history", async () => {
    vi.mocked(gateway.getStoredChatHistory).mockResolvedValue({
      messages: [],
      hasMore: true,
      nextOffset: 0,
    });
    const runtime = new SessionsRuntime(env, gateway);
    await expect(
      runtime.getChatHistory("session-1.jsonl", 3),
    ).rejects.toBeInstanceOf(SessionsRuntimeUnavailableError);
    expect(gateway.getStoredChatHistory).toHaveBeenCalledTimes(1);
  });

  it("keeps archived filtering and excludes runtime-only sessions", async () => {
    vi.mocked(gateway.listStoredSessions).mockResolvedValue({
      sessions: [
        row,
        {
          ...row,
          sessionId: "archived-1",
          key: "agent:bot-1:archived",
          archived: true,
          archivedAt: row.updatedAt,
        },
        { ...row, key: "agent:main:main" },
        { ...row, key: "agent:bot-1:subagent:child" },
        { ...row, key: "agent:bot-1:openai:utility" },
        { ...row, origin: { provider: "heartbeat" } },
      ],
    });
    const runtime = new SessionsRuntime(env, gateway);
    expect((await runtime.listSessions()).map((session) => session.id)).toEqual(
      ["session-1.jsonl"],
    );
    expect(
      (await runtime.listSessions(false, "only")).map((session) => session.id),
    ).toEqual(["archived-1.jsonl"]);
    expect(await runtime.listSessions(false, "include")).toHaveLength(2);
  });

  it("reports gateway read failures instead of returning an empty successful result", async () => {
    vi.mocked(gateway.listStoredSessions).mockRejectedValue(
      new Error("gateway unavailable"),
    );
    const runtime = new SessionsRuntime(env, gateway);
    await expect(runtime.listSessions()).rejects.toBeInstanceOf(
      SessionsRuntimeUnavailableError,
    );

    vi.mocked(gateway.listStoredSessions).mockResolvedValue({
      sessions: [row],
    });
    vi.mocked(gateway.getStoredChatHistory).mockRejectedValue(
      new Error("history unavailable"),
    );
    await expect(
      runtime.getChatHistory("session-1.jsonl"),
    ).rejects.toBeInstanceOf(SessionsRuntimeUnavailableError);
  });

  it("persists renames through the gateway and reflects them after reopening", async () => {
    const runtime = new SessionsRuntime(env, gateway);
    expect(
      await runtime.updateSession("session-1.jsonl", { title: "Renamed" }),
    ).toMatchObject({ title: "Renamed" });
    expect(gateway.sessionsPatch).toHaveBeenCalledWith({
      key: sessionKey,
      agentId: "bot-1",
      label: "Renamed",
    });
    const reopened = new SessionsRuntime(env, gateway);
    expect(await reopened.getSession("session-1.jsonl")).toMatchObject({
      title: "Renamed",
    });
    await expect(
      access(
        path.join(stateDir, "agents", "bot-1", "sessions", "session-1.jsonl"),
      ),
    ).rejects.toThrow();
  });

  it("preserves local status and metadata updates across gateway readback", async () => {
    const runtime = new SessionsRuntime(env, gateway);
    expect(
      await runtime.updateSession("session-1.jsonl", {
        status: "ended",
        metadata: { note: "completed" },
      }),
    ).toMatchObject({
      status: "ended",
      metadata: { note: "completed", source: "openclaw-gateway" },
    });
    expect(
      await new SessionsRuntime(env, gateway).getSession("session-1.jsonl"),
    ).toMatchObject({ status: "ended", metadata: { note: "completed" } });
  });

  it("keeps Nexu compatibility transcripts visible without relisting migrated runtime files", async () => {
    const runtime = new SessionsRuntime(env, gateway);
    await runtime.listSessions();
    const compatKey = "compat-dingtalk_test";
    const sessionsDir = path.join(stateDir, "agents", "bot-1", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "session-1.jsonl"), "");
    await writeFile(path.join(sessionsDir, "orphan.jsonl"), "");
    await writeFile(path.join(sessionsDir, "compat-unowned.jsonl"), "");
    await writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({ [sessionKey]: { sessionId: "session-1" } }),
    );
    const appendInput = {
      botId: "bot-1",
      sessionKey: compatKey,
      title: "DingTalk conversation",
      channelType: "dingtalk",
      userText: "first question",
      assistantText: "first answer",
    };
    await runtime.appendCompatTranscript(appendInput);
    await runtime.appendCompatTranscript({
      ...appendInput,
      userText: "second question",
      assistantText: "second answer",
    });

    expect(
      (await runtime.listSessions()).map((session) => session.id).sort(),
    ).toEqual([`${compatKey}.jsonl`, "session-1.jsonl"].sort());
    const history = await runtime.getChatHistoryBySessionKey(
      "bot-1",
      compatKey,
    );
    expect(history.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(history.messages[0]?.content).toEqual([
      { type: "text", text: "first question" },
    ]);
    expect(await runtime.getChatHistory(`${compatKey}.jsonl`)).toEqual(history);
    expect(gateway.getStoredChatHistory).not.toHaveBeenCalled();
    expect(
      await runtime.updateSession(`${compatKey}.jsonl`, {
        title: "Renamed compat",
      }),
    ).toMatchObject({ title: "Renamed compat" });
    expect(gateway.sessionsPatch).not.toHaveBeenCalled();
    expect(await runtime.resetSession(`${compatKey}.jsonl`)).toMatchObject({
      messageCount: 0,
    });
    expect(gateway.sessionsReset).not.toHaveBeenCalled();
    expect(await runtime.deleteSession(`${compatKey}.jsonl`)).toBe(true);
    expect(gateway.sessionsDelete).not.toHaveBeenCalled();
    expect((await runtime.listSessions()).map((session) => session.id)).toEqual(
      ["session-1.jsonl"],
    );
  });

  it("resets through the gateway and returns the new session identity", async () => {
    const runtime = new SessionsRuntime(env, gateway);
    await runtime.getChatHistory("session-1.jsonl");
    vi.mocked(gateway.listStoredSessions).mockResolvedValue({
      sessions: [{ ...row, sessionId: "reset-session" }],
    });
    expect(await runtime.resetSession("session-1.jsonl")).toMatchObject({
      id: "reset-session.jsonl",
      messageCount: 0,
    });
    expect(gateway.sessionsReset).toHaveBeenCalledWith({
      key: sessionKey,
      agentId: "bot-1",
      reason: "reset",
    });
  });

  it("deletes through the gateway and invalidates the visible list", async () => {
    const runtime = new SessionsRuntime(env, gateway);
    expect(await runtime.deleteSession("session-1.jsonl")).toBe(true);
    expect(gateway.sessionsDelete).toHaveBeenCalledWith({
      key: sessionKey,
      agentId: "bot-1",
    });
    vi.mocked(gateway.listStoredSessions).mockResolvedValue({ sessions: [] });
    expect(await runtime.listSessions()).toEqual([]);
  });

  it("does not hide a rejected gateway delete", async () => {
    vi.mocked(gateway.sessionsDelete).mockRejectedValue(
      new Error("session is running"),
    );
    const runtime = new SessionsRuntime(env, gateway);
    await expect(runtime.deleteSession("session-1.jsonl")).rejects.toThrow(
      "session is running",
    );
    expect(await runtime.getSession("session-1.jsonl")).not.toBeNull();
  });

  it("reads main chat history through the same gateway contract", async () => {
    vi.mocked(gateway.listStoredSessions).mockResolvedValue({
      sessions: [{ ...row, key: "agent:bot-1:main" }],
    });
    const runtime = new SessionsRuntime(env, gateway);
    expect(await runtime.getFullMainChatHistory("bot-1", 100)).toMatchObject({
      sessionCount: 1,
      messages: [{ id: "user-1" }, { id: "assistant-1" }],
    });
    expect(gateway.getStoredChatHistory).toHaveBeenCalledWith(
      "agent:bot-1:main",
      100,
    );
  });

  it("hides a truncated routing title and derives a readable title after history is loaded", async () => {
    vi.mocked(gateway.listStoredSessions).mockResolvedValue({
      sessions: [
        {
          ...row,
          label: undefined,
          derivedTitle: "[路由提示：你是团队队长。需要成员产出实际工…",
        },
      ],
    });
    vi.mocked(gateway.getStoredChatHistory).mockResolvedValue({
      messages: [
        {
          role: "user",
          content: "[路由提示：内部规则。]\n帮我写一份报告",
          __openclaw: { id: "user-1" },
        },
      ],
    });
    const runtime = new SessionsRuntime(env, gateway);
    expect((await runtime.listSessions())[0]?.title).toBe("New conversation");
    await runtime.getChatHistory("session-1.jsonl");
    expect((await runtime.listSessions(true))[0]?.title).toBe("帮我写一份报告");
    vi.mocked(gateway.listStoredSessions).mockResolvedValue({
      sessions: [{ ...row, label: "Chosen title" }],
    });
    expect((await runtime.listSessions(true))[0]?.title).toBe("Chosen title");
  });

  it("reads an isolated schedule transcript by gateway session key and generation", async () => {
    const runtime = new SessionsRuntime(env, gateway);
    const runKey = "agent:bot-1:cron:job-1:run:run-session";
    expect(
      await runtime.getRunTranscriptMessages(
        "bot-1",
        "run-session",
        80,
        runKey,
      ),
    ).toHaveLength(2);
    expect(gateway.getStoredChatHistory).toHaveBeenCalledWith(
      runKey,
      80,
      "run-session",
    );
    expect(
      await runtime.getRunTranscriptMessages(
        "other-bot",
        "run-session",
        80,
        runKey,
      ),
    ).toBeNull();
  });
});
