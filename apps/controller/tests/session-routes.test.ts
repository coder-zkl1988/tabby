import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControllerContainer } from "../src/app/container.js";
import { createApp } from "../src/app/create-app.js";
import type { ControllerEnv } from "../src/app/env.js";
import {
  SessionMessageNotFoundError,
  SessionsRuntime,
  SessionsRuntimeUnavailableError,
} from "../src/runtime/sessions-runtime.js";
import { createRuntimeState } from "../src/runtime/state.js";
import { SessionService } from "../src/services/session-service.js";

function createEnv(rootDir: string): ControllerEnv {
  return {
    nodeEnv: "test",
    port: 3010,
    host: "127.0.0.1",
    webUrl: "http://localhost:5173",
    nexuCloudUrl: "https://nexu.io",
    nexuLinkUrl: null,
    nexuHomeDir: path.join(rootDir, ".nexu"),
    nexuConfigPath: path.join(rootDir, ".nexu", "config.json"),
    artifactsIndexPath: path.join(rootDir, ".nexu", "artifacts", "index.json"),
    compiledOpenclawSnapshotPath: path.join(
      rootDir,
      ".nexu",
      "compiled-openclaw.json",
    ),
    openclawStateDir: path.join(rootDir, ".openclaw"),
    openclawConfigPath: path.join(rootDir, ".openclaw", "openclaw.json"),
    openclawSkillsDir: path.join(rootDir, ".openclaw", "skills"),
    openclawCuratedSkillsDir: path.join(rootDir, ".openclaw", "bundled-skills"),
    skillhubCacheDir: path.join(rootDir, ".nexu", "skillhub-cache"),
    skillDbPath: path.join(rootDir, ".nexu", "skillhub.db"),
    staticSkillsDir: undefined,
    openclawWorkspaceTemplatesDir: path.join(
      rootDir,
      ".openclaw",
      "workspace-templates",
    ),
    openclawBin: "openclaw",
    litellmBaseUrl: null,
    litellmApiKey: null,
    openclawGatewayPort: 18789,
    openclawGatewayToken: "token-123",
    manageOpenclawProcess: false,
    gatewayProbeEnabled: false,
    runtimeSyncIntervalMs: 2000,
    runtimeHealthIntervalMs: 5000,
    defaultModelId: "anthropic/claude-sonnet-4",
  } as ControllerEnv;
}

function createTestContainer(rootDir: string): ControllerContainer {
  const env = createEnv(rootDir);
  const sessionsRuntime = new SessionsRuntime(env);

  return {
    env,
    configStore: {} as ControllerContainer["configStore"],
    gatewayClient: {} as ControllerContainer["gatewayClient"],
    runtimeHealth: {
      probe: vi.fn(async () => ({
        ok: true,
      })),
    } as unknown as ControllerContainer["runtimeHealth"],
    openclawProcess: {} as ControllerContainer["openclawProcess"],
    agentService: {} as ControllerContainer["agentService"],
    channelService: {} as ControllerContainer["channelService"],
    channelFallbackService: {
      stop: vi.fn(),
    } as unknown as ControllerContainer["channelFallbackService"],
    sessionService: new SessionService(sessionsRuntime),
    runtimeConfigService: {} as ControllerContainer["runtimeConfigService"],
    runtimeModelStateService:
      {} as ControllerContainer["runtimeModelStateService"],
    modelProviderService: {} as ControllerContainer["modelProviderService"],
    integrationService: {} as ControllerContainer["integrationService"],
    localUserService: {} as ControllerContainer["localUserService"],
    desktopLocalService: {} as ControllerContainer["desktopLocalService"],
    artifactService: {} as ControllerContainer["artifactService"],
    templateService: {} as ControllerContainer["templateService"],
    skillhubService: {
      catalog: {
        getCatalog: vi.fn(() => ({
          skills: [],
          installedSlugs: [],
          installedSkills: [],
          meta: null,
        })),
        installSkill: vi.fn(),
        uninstallSkill: vi.fn(),
        refreshCatalog: vi.fn(),
        importSkillZip: vi.fn(),
      },
      start: vi.fn(),
      dispose: vi.fn(),
    } as unknown as ControllerContainer["skillhubService"],
    openclawSyncService: {} as ControllerContainer["openclawSyncService"],
    wsClient: {
      stop: vi.fn(),
    } as unknown as ControllerContainer["wsClient"],
    gatewayService: {
      isConnected: vi.fn(() => false),
    } as unknown as ControllerContainer["gatewayService"],
    runtimeState: createRuntimeState(),
    startBackgroundLoops: () => () => {},
  };
}

describe("session routes", () => {
  let rootDir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = null;
    }
  });

  it("normalizes pinned and unread query filters to booleans", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-session-routes-"));
    const container = createTestContainer(rootDir);
    const listSessions = vi.fn(async () => ({
      sessions: [],
      total: 0,
      limit: 7,
      offset: 2,
    }));
    container.sessionService = {
      listSessions,
    } as unknown as ControllerContainer["sessionService"];
    const app = createApp(container);

    const response = await app.request(
      "/api/v1/sessions?pinned=true&unread=false&archived=include&limit=7&offset=2",
    );

    expect(response.status).toBe(200);
    expect(listSessions).toHaveBeenCalledWith({
      archived: "include",
      limit: 7,
      offset: 2,
      pinned: true,
      unread: false,
    });
  });

  it("returns a sanitized unavailable response when session storage cannot be read", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-session-routes-"));
    const container = createTestContainer(rootDir);
    container.sessionService = {
      listSessions: vi.fn(async () => {
        throw new SessionsRuntimeUnavailableError();
      }),
    } as unknown as ControllerContainer["sessionService"];
    const app = createApp(container);

    const response = await app.request("/api/v1/sessions");
    const responseText = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(responseText)).toEqual({
      message: "Session data is temporarily unavailable",
    });
    expect(responseText).not.toContain(rootDir);
  });

  it("serves cleaned chat history through the session messages API", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-session-routes-"));
    const container = createTestContainer(rootDir);
    const app = createApp(container);

    const createSession = await app.request("/api/internal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: "bot-feishu",
        sessionKey: "clean-api",
        title: "Feishu cleanup",
        channelType: "feishu",
      }),
    });

    expect(createSession.status).toBe(201);

    const sessionPath = path.join(
      rootDir,
      ".openclaw",
      "agents",
      "bot-feishu",
      "sessions",
      "clean-api.jsonl",
    );
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "message",
          id: "msg-user",
          timestamp: "2026-03-23T02:00:00.000Z",
          message: {
            role: "user",
            timestamp: Date.parse("2026-03-23T02:00:00.000Z"),
            content: [
              {
                type: "text",
                text: [
                  "Conversation info (untrusted metadata):",
                  "```json",
                  JSON.stringify(
                    {
                      message_id: "om_x100",
                      sender: "唐其远",
                    },
                    null,
                    2,
                  ),
                  "```",
                  "",
                  "Sender (untrusted metadata):",
                  "```json",
                  JSON.stringify(
                    {
                      label: "唐其远 (ou_123)",
                      id: "ou_123",
                      name: "唐其远",
                    },
                    null,
                    2,
                  ),
                  "```",
                  "",
                  "Replied message (untrusted, for context):",
                  "```json",
                  JSON.stringify(
                    {
                      body: "[Interactive Card]",
                    },
                    null,
                    2,
                  ),
                  "```",
                  "",
                  "[message_id: om_x100]",
                  '唐其远: [Replying to: "[Interactive Card]"]',
                  "",
                  "你是谁",
                  "",
                  '[System: The content may include mention tags in the form <at user_id="...">name</at>. Treat these as real mentions of Feishu entities (users or bots).]',
                  '[System: If user_id is "ou_123", that mention refers to you.]',
                ].join("\n"),
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "msg-assistant",
          timestamp: "2026-03-23T02:01:00.000Z",
          message: {
            role: "assistant",
            timestamp: Date.parse("2026-03-23T02:01:00.000Z"),
            content: [
              {
                type: "thinking",
                thinking: "**Checking records**",
              },
              {
                type: "text",
                text: "[[reply_to_current]] 已扫描全部记录，没有发现异常。",
              },
              {
                type: "toolCall",
                id: "tool-1",
                name: "feishu_bitable_list_records",
                arguments: {
                  tableId: "tbl_123",
                },
              },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const response = await app.request(
      "/api/v1/sessions/clean-api.jsonl/messages?limit=10",
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      messages: Array<{
        id: string;
        role: "user" | "assistant";
        content: unknown;
      }>;
    };

    expect(payload.messages).toStrictEqual([
      {
        id: "msg-user",
        role: "user",
        timestamp: Date.parse("2026-03-23T02:00:00.000Z"),
        createdAt: "2026-03-23T02:00:00.000Z",
        content: [
          {
            type: "replyContext",
            text: "[Interactive Card]",
          },
          {
            type: "text",
            text: "你是谁",
          },
        ],
      },
      {
        id: "msg-assistant",
        role: "assistant",
        timestamp: Date.parse("2026-03-23T02:01:00.000Z"),
        createdAt: "2026-03-23T02:01:00.000Z",
        content: [
          {
            type: "text",
            text: "已扫描全部记录，没有发现异常。",
          },
          {
            type: "toolCall",
            id: "tool-1",
            name: "feishu_bitable_list_records",
            arguments: {
              tableId: "tbl_123",
            },
          },
        ],
      },
    ]);
  });

  it("exposes message-level branch and rollback operations", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-session-routes-"));
    const container = createTestContainer(rootDir);
    const branchAtMessage = vi.fn(async () => ({
      id: "branch.jsonl",
      botId: "bot-1",
      sessionKey: "agent:bot-1:branch",
      title: "Review · branch",
      messageId: "message-1",
      editorText: "Original prompt",
      editorAttachments: [{ mimeType: "image/png", data: "base64-image" }],
    }));
    const rollbackToMessage = vi.fn(async () => ({
      ok: true as const,
      id: "source.jsonl",
      sessionKey: "agent:bot-1:source",
      messageId: "message-1",
      editorText: "Original prompt",
      editorAttachments: [{ mimeType: "image/png", data: "base64-image" }],
    }));
    container.sessionService = {
      branchAtMessage,
      rollbackToMessage,
    } as unknown as ControllerContainer["sessionService"];
    const app = createApp(container);

    const branchResponse = await app.request(
      "/api/v1/sessions/source.jsonl/messages/message-1/branch",
      { method: "POST" },
    );
    const rollbackResponse = await app.request(
      "/api/v1/sessions/source.jsonl/messages/message-1/rollback",
      { method: "POST" },
    );

    expect(branchResponse.status).toBe(200);
    expect(await branchResponse.json()).toMatchObject({
      id: "branch.jsonl",
      messageId: "message-1",
      editorText: "Original prompt",
      editorAttachments: [{ mimeType: "image/png", data: "base64-image" }],
    });
    expect(rollbackResponse.status).toBe(200);
    expect(await rollbackResponse.json()).toMatchObject({
      ok: true,
      messageId: "message-1",
      editorText: "Original prompt",
      editorAttachments: [{ mimeType: "image/png", data: "base64-image" }],
    });
    expect(branchAtMessage).toHaveBeenCalledWith("source.jsonl", "message-1");
    expect(rollbackToMessage).toHaveBeenCalledWith("source.jsonl", "message-1");
  });

  it("returns 404 for an unknown message and 409 for a running session", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-session-routes-"));
    const container = createTestContainer(rootDir);
    container.sessionService = {
      branchAtMessage: vi.fn(async () => {
        throw new SessionMessageNotFoundError();
      }),
      rollbackToMessage: vi.fn(async () => {
        throw new Error(
          "Cannot switch message branches while the session is running",
        );
      }),
    } as unknown as ControllerContainer["sessionService"];
    const app = createApp(container);

    const missingResponse = await app.request(
      "/api/v1/sessions/source.jsonl/messages/missing/branch",
      { method: "POST" },
    );
    const runningResponse = await app.request(
      "/api/v1/sessions/source.jsonl/messages/message-1/rollback",
      { method: "POST" },
    );

    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({
      message: "Message not found in session",
    });
    expect(runningResponse.status).toBe(409);
  });
});
