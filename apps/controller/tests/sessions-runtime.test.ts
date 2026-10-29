import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import { mediaCacheDir, mediaCachePathFor } from "../src/lib/media-cache.js";
import { restrictedTextSessionKey } from "../src/lib/restricted-text-session-key.js";
import {
  SessionMessageNotFoundError,
  SessionTranscriptLockedError,
  SessionsRuntime,
  SessionsRuntimeUnavailableError,
} from "../src/runtime/sessions-runtime.js";

function createEnv(overrides: Record<string, unknown> = {}): ControllerEnv {
  return {
    nodeEnv: "test",
    port: 3010,
    host: "127.0.0.1",
    webUrl: "http://localhost:5173",
    nexuCloudUrl: "https://nexu.io",
    nexuLinkUrl: null,
    nexuHomeDir: "/tmp/nexu-test",
    nexuConfigPath: "/tmp/nexu-test/config.json",
    artifactsIndexPath: "/tmp/nexu-test/artifacts/index.json",
    compiledOpenclawSnapshotPath: "/tmp/nexu-test/compiled-openclaw.json",
    openclawStateDir: "/tmp/openclaw",
    openclawConfigPath: "/tmp/openclaw/openclaw.json",
    openclawSkillsDir: "/tmp/openclaw/skills",
    skillhubCacheDir: "/tmp/nexu-test/skillhub-cache",
    skillDbPath: "/tmp/nexu-test/skill-ledger.db",
    staticSkillsDir: undefined,
    openclawWorkspaceTemplatesDir: "/tmp/openclaw/workspace-templates",
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
    ...overrides,
  } as unknown as ControllerEnv;
}

describe("SessionsRuntime", () => {
  let rootDir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = null;
    }
  });

  it("returns an empty list when the agents directory does not exist", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({ openclawStateDir: rootDir }),
    );

    await expect(runtime.listSessions()).resolves.toEqual([]);
  });

  it("reports a sanitized unavailable error when the agents path cannot be scanned", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    await writeFile(path.join(rootDir, "agents"), "not a directory", "utf8");
    const runtime = new SessionsRuntime(
      createEnv({ openclawStateDir: rootDir }),
    );

    const result = runtime.listSessions();
    await expect(result).rejects.toBeInstanceOf(
      SessionsRuntimeUnavailableError,
    );
    await expect(result).rejects.not.toThrow(rootDir);
  });

  it("reports unavailable when a sessions index is unreadable JSON", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const sessionsDir = path.join(rootDir, "agents", "bot-1", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "sessions.json"), "{", "utf8");
    const runtime = new SessionsRuntime(
      createEnv({ openclawStateDir: rootDir }),
    );

    await expect(runtime.listSessions()).rejects.toBeInstanceOf(
      SessionsRuntimeUnavailableError,
    );
  });

  it("merges filesystem metadata into session responses", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    await runtime.createOrUpdateSession({
      botId: "bot-1",
      sessionKey: "s1",
      title: "Session 1",
      metadata: {
        openChatId: "oc_123",
      },
    });

    const sessions = await runtime.listSessions();
    const session = sessions[0];

    expect(session?.metadata).toMatchObject({
      openChatId: "oc_123",
      source: "openclaw-filesystem",
      path: path.join(rootDir, "agents", "bot-1", "sessions", "s1.jsonl"),
    });
  });

  it("hides restricted text-generation turns like subagent lanes", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({ openclawStateDir: rootDir }),
    );
    const sessionsDir = path.join(rootDir, "agents", "bot-1", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const index: Record<string, { sessionId: string; sessionFile: string }> =
      {};
    for (const [sessionKey, sessionId] of [
      ["agent:bot-1:main", "main-session"],
      [
        restrictedTextSessionKey("bot-1", "xhs-diagnosis", "gen-1"),
        "diagnosis-session",
      ],
    ] as const) {
      const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
      await writeFile(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          id: `msg-${sessionId}`,
          timestamp: "2026-10-21T02:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        })}\n`,
        "utf8",
      );
      index[sessionKey] = { sessionId, sessionFile };
    }
    await writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify(index)}\n`,
      "utf8",
    );

    const sessions = await runtime.listSessions();
    expect(sessions.map((session) => session.sessionKey)).toEqual([
      "agent:bot-1:main",
    ]);
  });

  it("infers and persists Feishu exact chat targets from transcript metadata", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const nexuConfigPath = path.join(rootDir, "config.json");
    const runtime = new SessionsRuntime(
      createEnv({
        nexuConfigPath,
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );
    await writeFile(
      nexuConfigPath,
      JSON.stringify(
        {
          channels: [
            {
              id: "feishu-channel-1",
              botId: "bot-feishu",
              channelType: "feishu",
              appId: "cli_test",
            },
          ],
          secrets: {
            "channel:feishu-channel-1:appId": "cli_test",
            "channel:feishu-channel-1:appSecret": "secret_test",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-feishu", "sessions");
    await mkdir(sessionsDir, { recursive: true });

    const groupSessionPath = path.join(sessionsDir, "group.jsonl");
    await writeFile(
      groupSessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-group-1",
        timestamp: "2026-03-20T09:00:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-03-20T09:00:00.000Z"),
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    message_id: "om_group_1",
                    sender_id: "ou_00c644f271002b17348e992569f0f327",
                    conversation_label: "oc_22e522a5c7c13fbbfbf22d82463a5d11",
                    group_subject: "oc_22e522a5c7c13fbbfbf22d82463a5d11",
                    sender: "唐其远",
                    is_group_chat: true,
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
                    label: "唐其远 (ou_00c644f271002b17348e992569f0f327)",
                    id: "ou_00c644f271002b17348e992569f0f327",
                    name: "唐其远",
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const directSessionPath = path.join(sessionsDir, "direct.jsonl");
    await writeFile(
      directSessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-direct-1",
        timestamp: "2026-03-20T09:05:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-03-20T09:05:00.000Z"),
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    message_id: "om_direct_1",
                    sender_id: "ou_00c644f271002b17348e992569f0f327",
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
                    label: "唐其远 (ou_00c644f271002b17348e992569f0f327)",
                    id: "ou_00c644f271002b17348e992569f0f327",
                    name: "唐其远",
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/auth/v3/tenant_access_token/internal")) {
        return new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: "tenant_token_test",
            expire: 7200,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url.includes("/open-apis/im/v1/messages/om_direct_1")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  message_id: "om_direct_1",
                  chat_id: "oc_4471dc3c56e6479a29555460b452b217",
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const sessions = await runtime.listSessions();

    expect(
      sessions.find((session) => session.sessionKey === "group")?.metadata,
    ).toMatchObject({
      openChatId: "oc_22e522a5c7c13fbbfbf22d82463a5d11",
      openId: "ou_00c644f271002b17348e992569f0f327",
    });
    expect(
      sessions.find((session) => session.sessionKey === "direct")?.metadata,
    ).toMatchObject({
      openChatId: "oc_4471dc3c56e6479a29555460b452b217",
      openId: "ou_00c644f271002b17348e992569f0f327",
    });

    const persistedGroupMeta = JSON.parse(
      await readFile(
        groupSessionPath.replace(/\.jsonl$/, ".meta.json"),
        "utf8",
      ),
    ) as { metadata?: Record<string, unknown> };
    expect(persistedGroupMeta.metadata).toMatchObject({
      openChatId: "oc_22e522a5c7c13fbbfbf22d82463a5d11",
      openId: "ou_00c644f271002b17348e992569f0f327",
    });

    const persistedDirectMeta = JSON.parse(
      await readFile(
        directSessionPath.replace(/\.jsonl$/, ".meta.json"),
        "utf8",
      ),
    ) as { metadata?: Record<string, unknown> };
    expect(persistedDirectMeta.metadata).toMatchObject({
      openChatId: "oc_4471dc3c56e6479a29555460b452b217",
      openId: "ou_00c644f271002b17348e992569f0f327",
    });
  });

  it("uses a stable WeChat fallback title when sender metadata is missing", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-weixin", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(
      sessionsDir,
      "b1392694-8959-454f-8571-a83cf1f6abef.jsonl",
    );

    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-weixin-1",
        timestamp: "2026-03-22T10:49:06.478Z",
        message: {
          role: "user",
          timestamp: 1774176546475,
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    message_id: "openclaw-weixin:1774176546217-9644087e",
                    timestamp: "Sun 2026-03-22 18:49 GMT+8",
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const sessions = await runtime.listSessions();
    const session = sessions.find(
      (item) => item.sessionKey === "b1392694-8959-454f-8571-a83cf1f6abef",
    );

    expect(session?.title).toBe("WeChat ClawBot");
  });

  it("replaces persisted uuid-like titles with inferred WeChat conversation titles", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-weixin", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionKey = "b1392694-8959-454f-8571-a83cf1f6abef";
    const sessionPath = path.join(sessionsDir, `${sessionKey}.jsonl`);

    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-weixin-2",
        timestamp: "2026-03-22T10:49:06.478Z",
        message: {
          role: "user",
          timestamp: 1774176546475,
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    message_id: "openclaw-weixin:1774176546217-9644087e",
                    timestamp: "Sun 2026-03-22 18:49 GMT+8",
                    channel: "openclaw-weixin",
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );
    await writeFile(
      sessionPath.replace(/\.jsonl$/, ".meta.json"),
      `${JSON.stringify({ title: sessionKey }, null, 2)}\n`,
      "utf8",
    );

    const sessions = await runtime.listSessions();
    const session = sessions.find((item) => item.sessionKey === sessionKey);

    expect(session?.channelType).toBe("openclaw-weixin");
    expect(session?.title).toBe("WeChat ClawBot");
  });

  it("infers dingtalk channel and sender name from the sessions index openai-user context", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(
      rootDir,
      "agents",
      "bot-dingtalk",
      "sessions",
    );
    await mkdir(sessionsDir, { recursive: true });
    const sessionKey = "2c3d5c06-2b91-4dd1-a8d2-b4e707645ff8";
    const sessionPath = path.join(sessionsDir, `${sessionKey}.jsonl`);

    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-dingtalk-1",
        timestamp: "2026-04-14T10:00:10.543Z",
        message: {
          role: "user",
          timestamp: 1776160810538,
          content: [{ type: "text", text: "你好" }],
        },
      })}\n`,
      "utf8",
    );
    await writeFile(
      sessionPath.replace(/\.jsonl$/, ".meta.json"),
      `${JSON.stringify({ title: sessionKey }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify(
        {
          'agent:bot-dingtalk:openai-user:{"channel":"dingtalk-connector","accountid":"__default__","chattype":"direct","peerid":"dingtalk-user-123","sendername":"Test User"}':
            {
              sessionId: sessionKey,
              sessionFile: sessionPath,
              updatedAt: 1776161129268,
            },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const sessions = await runtime.listSessions();
    // Since sessions.json maps the full openai-user index key → sessionId UUID,
    // the runtime uses the index key as sessionKey (via fileNameToIndexKey).
    const indexKey =
      'agent:bot-dingtalk:openai-user:{"channel":"dingtalk-connector","accountid":"__default__","chattype":"direct","peerid":"dingtalk-user-123","sendername":"Test User"}';
    const session = sessions.find((item) => item.sessionKey === indexKey);

    expect(session?.channelType).toBe("dingtalk");
    expect(session?.title).toBe("Test User · dingtalk");
  });

  it("uses the WeChat ClawBot fallback even when an opaque @im.wechat sender id is present", async () => {
    // The iLink wechat protocol does not expose nicknames; inbound messages
    // only carry an opaque `<id>@im.wechat` sender id. Don't leak the raw
    // id into the sidebar — fall through to the generic fallback.
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-weixin", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionKey = "f6c3b8a1-2222-4444-8888-aaaaaaaaaaaa";
    const sessionPath = path.join(sessionsDir, `${sessionKey}.jsonl`);
    const opaqueSenderId = "o9cq806H7ohuShZ_uaSLLSsPtFGc@im.wechat";

    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-weixin-3",
        timestamp: "2026-03-22T10:49:06.478Z",
        message: {
          role: "user",
          timestamp: 1774176546475,
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    sender_id: opaqueSenderId,
                    sender: opaqueSenderId,
                    channel: "openclaw-weixin",
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
                    label: opaqueSenderId,
                    id: opaqueSenderId,
                    name: opaqueSenderId,
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );
    // Existing session has the raw opaque id persisted as title — verify
    // shouldReplaceInferredTitle heals it back to the generic fallback.
    await writeFile(
      sessionPath.replace(/\.jsonl$/, ".meta.json"),
      `${JSON.stringify({ title: opaqueSenderId }, null, 2)}\n`,
      "utf8",
    );

    const sessions = await runtime.listSessions();
    const session = sessions.find((item) => item.sessionKey === sessionKey);

    expect(session?.channelType).toBe("openclaw-weixin");
    expect(session?.title).toBe("WeChat ClawBot");
    expect(session?.title).not.toContain("@im.wechat");
  });

  it("backfills channel types from sessions.json when transcript metadata is not channel-specific", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(
      rootDir,
      "agents",
      "bot-cross-channel",
      "sessions",
    );
    await mkdir(sessionsDir, { recursive: true });

    const whatsappSessionPath = path.join(sessionsDir, "whatsapp.jsonl");
    await writeFile(
      whatsappSessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-whatsapp-1",
        timestamp: "2026-03-26T08:22:07.967Z",
        message: {
          role: "user",
          timestamp: 1774513327964,
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    message_id: "AC2095457BE8A88A52DF303FC76D74B6",
                    sender_id: "+447925140412",
                    sender: "xirui0328",
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
                    label: "xirui0328 (+447925140412)",
                    id: "+447925140412",
                    name: "xirui0328",
                    e164: "+447925140412",
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const telegramSessionPath = path.join(sessionsDir, "telegram.jsonl");
    await writeFile(
      telegramSessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-telegram-1",
        timestamp: "2026-03-25T13:12:22.898Z",
        message: {
          role: "user",
          timestamp: 1774444342895,
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    message_id: "1",
                    sender_id: "6658353153",
                    sender: "Markeyda Williams",
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
                    label: "Markeyda Williams (6658353153)",
                    id: "6658353153",
                    name: "Markeyda Williams",
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    await writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:bot-cross-channel:direct:+447925140412": {
            sessionId: "whatsapp",
            sessionFile: whatsappSessionPath,
            lastChannel: "whatsapp",
            origin: {
              provider: "whatsapp",
              label: "+447925140412",
            },
          },
          "agent:bot-cross-channel:direct:6658353153": {
            sessionId: "telegram",
            sessionFile: telegramSessionPath,
            lastChannel: "telegram",
            origin: {
              provider: "telegram",
              label: "Markeyda Williams id:6658353153",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const sessions = await runtime.listSessions();

    // Since sessions.json entries carry a sessionFile (absolute path), the
    // runtime derives sessionKey from the index key rather than the file
    // basename.  See fileNameToIndexKey in _listSessionsUncached (introduced
    // in commit 08da42cbf).
    expect(
      sessions.find(
        (session) =>
          session.sessionKey === "agent:bot-cross-channel:direct:+447925140412",
      )?.channelType,
    ).toBe("whatsapp");
    expect(
      sessions.find(
        (session) =>
          session.sessionKey === "agent:bot-cross-channel:direct:6658353153",
      )?.channelType,
    ).toBe("telegram");
  });

  it("normalizes Feishu chat history before returning it", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawCuratedSkillsDir: path.join(rootDir, "bundled-skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-feishu", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, "feishu-cleanup.jsonl");
    await writeFile(
      sessionPath.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify(
        {
          title: "Feishu thread",
          channelType: "feishu",
        },
        null,
        2,
      ),
      "utf8",
    );
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

    const result = await runtime.getChatHistory("feishu-cleanup.jsonl");

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      id: "msg-user",
      role: "user",
    });
    expect(result.messages[0]?.content).toStrictEqual([
      {
        type: "replyContext",
        text: "[Interactive Card]",
      },
      {
        type: "text",
        text: "你是谁",
      },
    ]);
    expect(result.messages[1]).toMatchObject({
      id: "msg-assistant",
      role: "assistant",
    });
    expect(result.messages[1]?.content).toStrictEqual([
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
    ]);
  });

  it("does not strip system-like user text for non-Feishu channels", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawCuratedSkillsDir: path.join(rootDir, "bundled-skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-slack", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, "slack-raw.jsonl");
    await writeFile(
      sessionPath.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify(
        {
          title: "Slack thread",
          channelType: "slack",
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-user",
        timestamp: "2026-03-23T02:02:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-03-23T02:02:00.000Z"),
          content: [
            {
              type: "text",
              text: "Please keep this literal text: [System: deploy window is 15:00]",
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const result = await runtime.getChatHistory("slack-raw.jsonl");

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toStrictEqual([
      {
        type: "text",
        text: "Please keep this literal text: [System: deploy window is 15:00]",
      },
    ]);
  });

  it("strips Feishu system suffixes even when channelType casing differs", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawCuratedSkillsDir: path.join(rootDir, "bundled-skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-feishu", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, "feishu-casing.jsonl");
    await writeFile(
      sessionPath.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify(
        {
          title: "Feishu casing",
          channelType: "FEISHU",
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-user",
        timestamp: "2026-03-23T02:02:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-03-23T02:02:00.000Z"),
          content: [
            {
              type: "text",
              text: [
                "Please keep this literal text",
                '[System: The content may include mention tags in the form <at user_id="...">name</at>. Treat these as real mentions of Feishu entities (users or bots).]',
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const result = await runtime.getChatHistory("feishu-casing.jsonl");

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toStrictEqual([
      {
        type: "text",
        text: "Please keep this literal text",
      },
    ]);
  });

  it("drops transcript entries that only contain unknown blocks", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawCuratedSkillsDir: path.join(rootDir, "bundled-skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-web", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, "unknown-blocks.jsonl");
    await writeFile(
      sessionPath.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify(
        {
          title: "Unknown blocks",
          channelType: "web",
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-unknown-only",
        timestamp: "2026-03-23T02:04:00.000Z",
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-03-23T02:04:00.000Z"),
          content: [
            {
              type: "customBlock",
              payload: "opaque",
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const result = await runtime.getChatHistory("unknown-blocks.jsonl");

    expect(result.messages).toHaveLength(0);
  });

  it("extracts reply context for other channel-specific quote prefixes", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawCuratedSkillsDir: path.join(rootDir, "bundled-skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-weixin", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, "weixin-reply.jsonl");
    await writeFile(
      sessionPath.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify(
        {
          title: "WeChat thread",
          channelType: "openclaw-weixin",
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-user",
        timestamp: "2026-03-23T02:03:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-03-23T02:03:00.000Z"),
          content: [
            {
              type: "text",
              text: "[引用: 原始卡片消息]\\n\\n你好",
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const result = await runtime.getChatHistory("weixin-reply.jsonl");

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toStrictEqual([
      {
        type: "replyContext",
        text: "原始卡片消息",
      },
      {
        type: "text",
        text: "你好",
      },
    ]);
  });

  it("uses group_name as session title for group chats", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-feishu", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, "group-name-test.jsonl");

    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-group-name-1",
        timestamp: "2026-03-25T10:00:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-03-25T10:00:00.000Z"),
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    message_id: "om_grp_1",
                    sender_id: "ou_abc123def456abc123def456abc123de",
                    group_name: "Engineering Team",
                    sender: "Alice",
                    is_group_chat: true,
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
                    label: "Alice (ou_abc123def456abc123def456abc123de)",
                    id: "ou_abc123def456abc123def456abc123de",
                    name: "Alice",
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const sessions = await runtime.listSessions();
    const session = sessions.find((s) => s.sessionKey === "group-name-test");

    expect(session?.title).toBe("Engineering Team · feishu");
  });

  it("filters ID-like group names and falls back to senderName", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-feishu", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, "id-like-group.jsonl");

    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-id-like-1",
        timestamp: "2026-03-25T10:01:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-03-25T10:01:00.000Z"),
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    message_id: "om_grp_2",
                    sender_id: "ou_abc123def456abc123def456abc123de",
                    conversation_label: "oc_22e522a5c7c13fbbfbf22d82463a5d11",
                    sender: "Bob",
                    is_group_chat: true,
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
                    label: "Bob (ou_abc123def456abc123def456abc123de)",
                    id: "ou_abc123def456abc123def456abc123de",
                    name: "Bob",
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const sessions = await runtime.listSessions();
    const session = sessions.find((s) => s.sessionKey === "id-like-group");

    // oc_ prefix is ID-like, so groupName should be filtered out, falling back to senderName
    expect(session?.title).toBe("Bob · feishu");
  });

  it("keeps normal group names starting with uppercase C", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-slack", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, "c-name-group.jsonl");

    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-c-name-1",
        timestamp: "2026-03-25T10:02:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-03-25T10:02:00.000Z"),
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    message_id: "slack-msg-1",
                    chat_name: "Christmas Party Planning",
                    sender: "Carol",
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
                    label: "Carol",
                    name: "Carol",
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const sessions = await runtime.listSessions();
    const session = sessions.find((s) => s.sessionKey === "c-name-group");

    // "Christmas Party Planning" starts with C but is not an ID — should be kept
    expect(session?.title).toBe("Christmas Party Planning · slack");
  });

  it("filters Slack channel IDs like C05ABCD1234", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-slack", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, "slack-id-group.jsonl");

    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-slack-id-1",
        timestamp: "2026-03-25T10:03:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-03-25T10:03:00.000Z"),
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    message_id: "slack-msg-2",
                    conversation_label: "C05ABCD1234",
                    sender: "Dave",
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
                    label: "Dave",
                    name: "Dave",
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const sessions = await runtime.listSessions();
    const session = sessions.find((s) => s.sessionKey === "slack-id-group");

    // C05ABCD1234 is a Slack channel ID — should be filtered, fall back to senderName
    expect(session?.title).toBe("Dave · slack");
  });

  it("filters Slack group/DM IDs with G and D prefixes", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-slack", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, "slack-group-id.jsonl");

    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-slack-gid-1",
        timestamp: "2026-03-25T10:04:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-03-25T10:04:00.000Z"),
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    message_id: "slack-msg-3",
                    conversation_label: "G01ABC2DEF3",
                    sender: "Eve",
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
                    label: "Eve",
                    name: "Eve",
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const sessions = await runtime.listSessions();
    const session = sessions.find((s) => s.sessionKey === "slack-group-id");

    // G01ABC2DEF3 is a Slack group ID — should be filtered, fall back to senderName
    expect(session?.title).toBe("Eve · slack");
  });

  it("replaces qqbot opaque ids with a friendlier user label", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-qq", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionKey = "qqbot-opaque-user";
    const sessionPath = path.join(sessionsDir, `${sessionKey}.jsonl`);

    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-qqbot-1",
        timestamp: "2026-03-31T12:00:22.688Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-03-31T12:00:22.688Z"),
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    message_id: "qqbot-msg-1",
                    sender_id: "68B6446D467308C61B580FB6D56AEA49",
                    sender: "68B6446D467308C61B580FB6D56AEA49",
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
                    label: "68B6446D467308C61B580FB6D56AEA49",
                    id: "68B6446D467308C61B580FB6D56AEA49",
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    await writeFile(
      sessionPath.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify(
        {
          title: "68B6446D467308C61B580FB6D56AEA49 · qqbot",
          channelType: "qqbot",
        },
        null,
        2,
      ),
      "utf8",
    );

    const sessions = await runtime.listSessions();
    const session = sessions.find((s) => s.sessionKey === sessionKey);

    expect(session?.title).toBe("QQ user 68B6446D");
  });

  it("prefers qqbot known-user nicknames over opaque ids", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const homeDir = path.join(rootDir, "home");
    vi.stubEnv("HOME", homeDir);

    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const knownUsersDir = path.join(homeDir, ".openclaw", "qqbot", "data");
    await mkdir(knownUsersDir, { recursive: true });
    await writeFile(
      path.join(knownUsersDir, "known-users.json"),
      JSON.stringify(
        [
          {
            openid: "68B6446D467308C61B580FB6D56AEA49",
            type: "c2c",
            nickname: "Ray",
            accountId: "default",
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const sessionsDir = path.join(rootDir, "agents", "bot-qq", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionKey = "qqbot-known-user";
    const sessionPath = path.join(sessionsDir, `${sessionKey}.jsonl`);

    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-qqbot-2",
        timestamp: "2026-03-31T12:15:22.688Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-03-31T12:15:22.688Z"),
          content: [
            {
              type: "text",
              text: [
                "Conversation info (untrusted metadata):",
                "```json",
                JSON.stringify(
                  {
                    message_id: "qqbot-msg-2",
                    sender_id: "68B6446D467308C61B580FB6D56AEA49",
                    sender: "68B6446D467308C61B580FB6D56AEA49",
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
                    label: "68B6446D467308C61B580FB6D56AEA49",
                    id: "68B6446D467308C61B580FB6D56AEA49",
                  },
                  null,
                  2,
                ),
                "```",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    await writeFile(
      sessionPath.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify(
        {
          title: "68B6446D467308C61B580FB6D56AEA49 · qqbot",
          channelType: "qqbot",
        },
        null,
        2,
      ),
      "utf8",
    );

    const sessions = await runtime.listSessions();
    const session = sessions.find((s) => s.sessionKey === sessionKey);

    expect(session?.title).toBe("Ray");
  });

  function createWebchatRuntime(dir: string): SessionsRuntime {
    return new SessionsRuntime(
      createEnv({
        openclawStateDir: dir,
        openclawConfigPath: path.join(dir, "openclaw.json"),
        openclawSkillsDir: path.join(dir, "skills"),
        openclawCuratedSkillsDir: path.join(dir, "bundled-skills"),
        openclawWorkspaceTemplatesDir: path.join(dir, "workspace-templates"),
      }),
    );
  }

  async function writeWebchatSession(
    dir: string,
    fileName: string,
    records: unknown[],
  ): Promise<void> {
    const sessionsDir = path.join(dir, "agents", "bot-web", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, fileName);
    await writeFile(
      sessionPath.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ title: "Webchat", channelType: "webchat" }, null, 2),
      "utf8",
    );
    await writeFile(
      sessionPath,
      `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );
  }

  function transcriptMessage(
    id: string,
    parentId: string | null,
    role: "user" | "assistant",
  ): Record<string, unknown> {
    return {
      type: "message",
      id,
      parentId,
      timestamp: "2026-08-04T01:00:00.000Z",
      message: {
        role,
        content: `${role}-${id}`,
        timestamp: Date.parse("2026-08-04T01:00:00.000Z"),
      },
    };
  }

  it("keeps legacy flat history when a transcript has no leaf controls", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    await writeWebchatSession(rootDir, "legacy-branches.jsonl", [
      transcriptMessage("user-1", null, "user"),
      transcriptMessage("assistant-1", "user-1", "assistant"),
      transcriptMessage("user-2", "assistant-1", "user"),
      transcriptMessage("assistant-2", "user-2", "assistant"),
      transcriptMessage("alternate-user", "assistant-1", "user"),
    ]);

    const result = await runtime.getChatHistory("legacy-branches.jsonl");

    expect(result.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
      "alternate-user",
    ]);
  });

  it("reads only the active parent chain after a valid leaf control", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    await writeWebchatSession(rootDir, "active-branch.jsonl", [
      transcriptMessage("user-1", null, "user"),
      transcriptMessage("assistant-1", "user-1", "assistant"),
      transcriptMessage("abandoned-user", "assistant-1", "user"),
      transcriptMessage("abandoned-assistant", "abandoned-user", "assistant"),
      {
        type: "plugin_marker",
        id: "opaque-tail",
        parentId: "abandoned-assistant",
      },
      {
        type: "leaf",
        id: "leaf-1",
        parentId: "opaque-tail",
        timestamp: "2026-08-04T01:01:00.000Z",
        targetId: "assistant-1",
        appendParentId: "opaque-tail",
      },
      transcriptMessage("active-user", "assistant-1", "user"),
      transcriptMessage("active-assistant", "active-user", "assistant"),
    ]);

    const result = await runtime.getChatHistory("active-branch.jsonl");

    expect(result.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "active-user",
      "active-assistant",
    ]);
    await expect(
      runtime.sessionContainsActiveMessage({
        botId: "bot-web",
        sessionKey: "active-branch",
        messageId: "abandoned-user",
      }),
    ).resolves.toBe(false);
    await expect(
      runtime.sessionContainsActiveMessage({
        botId: "bot-web",
        sessionKey: "active-branch",
        messageId: "active-user",
      }),
    ).resolves.toBe(true);
  });

  it("ignores an invalid leaf control with an unknown target", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    await writeWebchatSession(rootDir, "invalid-leaf.jsonl", [
      transcriptMessage("user-1", null, "user"),
      transcriptMessage("assistant-1", "user-1", "assistant"),
      transcriptMessage("user-2", "assistant-1", "user"),
      {
        type: "leaf",
        id: "invalid-leaf",
        parentId: "user-2",
        timestamp: "2026-08-04T01:01:00.000Z",
        targetId: "missing-message",
        appendParentId: "missing-message",
      },
    ]);

    const result = await runtime.getChatHistory("invalid-leaf.jsonl");

    expect(result.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
    ]);
  });

  it("appends a leaf control for a known message and rejects unknown messages", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    await writeWebchatSession(rootDir, "message-rollback.jsonl", [
      transcriptMessage("user-1", null, "user"),
      transcriptMessage("assistant-1", "user-1", "assistant"),
      transcriptMessage("user-2", "assistant-1", "user"),
    ]);

    await runtime.selectActiveMessage({
      botId: "bot-web",
      sessionKey: "message-rollback",
      messageId: "assistant-1",
    });

    const sessionPath = path.join(
      rootDir,
      "agents",
      "bot-web",
      "sessions",
      "message-rollback.jsonl",
    );
    const transcript = await readFile(sessionPath, "utf8");
    const lastRecord = JSON.parse(
      transcript.trim().split("\n").at(-1) ?? "{}",
    ) as Record<string, unknown>;
    expect(lastRecord).toMatchObject({
      type: "leaf",
      parentId: "user-2",
      targetId: "assistant-1",
      appendParentId: "assistant-1",
    });
    await expect(
      runtime.selectActiveMessage({
        botId: "bot-web",
        sessionKey: "message-rollback",
        messageId: "missing-message",
      }),
    ).rejects.toBeInstanceOf(SessionMessageNotFoundError);
    const result = await runtime.getChatHistory("message-rollback.jsonl");
    expect(result.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    await expect(access(`${sessionPath}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not modify a transcript while OpenClaw holds its write lock", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    await writeWebchatSession(rootDir, "locked-rollback.jsonl", [
      transcriptMessage("user-1", null, "user"),
      transcriptMessage("assistant-1", "user-1", "assistant"),
    ]);
    const sessionPath = path.join(
      rootDir,
      "agents",
      "bot-web",
      "sessions",
      "locked-rollback.jsonl",
    );
    const original = await readFile(sessionPath, "utf8");
    await writeFile(
      `${sessionPath}.lock`,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );

    await expect(
      runtime.selectActiveMessage({
        botId: "bot-web",
        sessionKey: "locked-rollback",
        messageId: "assistant-1",
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptLockedError);
    await expect(readFile(sessionPath, "utf8")).resolves.toBe(original);
  });

  it("surfaces render_a2ui toolResult records and drops other tool results", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    await writeWebchatSession(rootDir, "a2ui-history.jsonl", [
      {
        type: "message",
        id: "msg-assistant",
        timestamp: "2026-06-11T06:30:00.000Z",
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-06-11T06:30:00.000Z"),
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "render_a2ui",
              arguments: { surfaceId: "sidebar:poster" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "msg-a2ui-result",
        timestamp: "2026-06-11T06:30:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "render_a2ui",
          timestamp: Date.parse("2026-06-11T06:30:01.000Z"),
          content: [
            {
              type: "text",
              text: '```a2ui\n{"version":"v0.9","createSurface":{"surfaceId":"sidebar:poster"}}\n```',
            },
          ],
        },
      },
      {
        type: "message",
        id: "msg-exec-result",
        timestamp: "2026-06-11T06:30:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "exec",
          timestamp: Date.parse("2026-06-11T06:30:02.000Z"),
          content: [{ type: "text", text: "ls output" }],
        },
      },
    ]);

    const result = await runtime.getChatHistory("a2ui-history.jsonl");

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({
      id: "msg-a2ui-result",
      role: "toolResult",
      toolName: "render_a2ui",
      toolCallId: "call-1",
    });
    const resultContent = result.messages[1]?.content as Array<{
      type: string;
      text: string;
    }>;
    expect(resultContent[0]?.text).toContain("```a2ui");
  });

  it("converts MediaPaths transcript fields into served image blocks", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    const inboundPath = path.join(rootDir, "media", "inbound", "photo.png");
    await writeWebchatSession(rootDir, "media-history.jsonl", [
      {
        type: "message",
        id: "msg-captioned",
        timestamp: "2026-06-11T06:31:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-06-11T06:31:00.000Z"),
          content: "告诉我图片中的信息",
          MediaPaths: [inboundPath],
          MediaTypes: ["image/png"],
        },
      },
      {
        type: "message",
        id: "msg-media-only",
        timestamp: "2026-06-11T06:32:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-06-11T06:32:00.000Z"),
          content: "[User sent media without caption]",
          MediaPath: inboundPath,
          MediaType: "image/png",
        },
      },
      {
        type: "message",
        id: "msg-inline-and-path",
        timestamp: "2026-06-11T06:33:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-06-11T06:33:00.000Z"),
          content: [
            {
              type: "text",
              text: "按照图片里的提示修改\n[media attached: media://inbound/photo.png]",
            },
            {
              type: "image",
              data: "inline-base64-image",
              mimeType: "image/jpeg",
            },
          ],
          MediaPaths: [inboundPath],
          MediaTypes: ["image/png"],
        },
      },
    ]);

    const result = await runtime.getChatHistory("media-history.jsonl");

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]?.content).toStrictEqual([
      { type: "text", text: "告诉我图片中的信息" },
      {
        type: "image",
        url: `/api/v1/media/state-file?path=${encodeURIComponent(inboundPath)}`,
        mimeType: "image/png",
      },
    ]);
    // Media-only message: placeholder text hidden, image block remains.
    expect(result.messages[1]?.content).toStrictEqual([
      {
        type: "image",
        url: `/api/v1/media/state-file?path=${encodeURIComponent(inboundPath)}`,
        mimeType: "image/png",
      },
    ]);
    // OpenClaw persists the same inbound image as both an inline base64 block
    // and MediaPaths. History keeps only the durable served representation,
    // and hides the internal media delivery marker from the caption.
    expect(result.messages[2]?.content).toStrictEqual([
      { type: "text", text: "按照图片里的提示修改" },
      {
        type: "image",
        url: `/api/v1/media/state-file?path=${encodeURIComponent(inboundPath)}`,
        mimeType: "image/png",
      },
    ]);
  });

  it("extracts MEDIA: markers from assistant replies into image blocks", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    const generatedPath = path.join(
      rootDir,
      "media",
      "tool-image-generation",
      "cover.png",
    );
    await writeWebchatSession(rootDir, "media-marker.jsonl", [
      {
        type: "message",
        id: "msg-assistant-media",
        timestamp: "2026-06-11T06:33:00.000Z",
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-06-11T06:33:00.000Z"),
          content: [
            {
              type: "text",
              text: `专辑封面已生成：\n\nMEDIA:${generatedPath}\n\n喜欢吗？`,
            },
          ],
        },
      },
    ]);

    const result = await runtime.getChatHistory("media-marker.jsonl");

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toStrictEqual([
      { type: "text", text: "专辑封面已生成：\n\n喜欢吗？" },
      {
        type: "image",
        url: `/api/v1/media/state-file?path=${encodeURIComponent(generatedPath)}`,
        mimeType: "image/png",
      },
    ]);
  });

  it("extracts MEDIA: markers with a space or full-width colon, as skill scripts and models actually emit them", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    const generatedPath = path.join(
      rootDir,
      "media",
      "tool-image-generation",
      "asian-girl.png",
    );
    await writeWebchatSession(rootDir, "media-marker-variants.jsonl", [
      {
        type: "message",
        id: "msg-assistant-media-variant",
        timestamp: "2026-06-11T06:33:00.000Z",
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-06-11T06:33:00.000Z"),
          content: [
            {
              type: "text",
              text: `图像已生成完成！\n\nMEDIA： ${generatedPath}`,
            },
          ],
        },
      },
    ]);

    const result = await runtime.getChatHistory("media-marker-variants.jsonl");

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toStrictEqual([
      { type: "text", text: "图像已生成完成！" },
      {
        type: "image",
        url: `/api/v1/media/state-file?path=${encodeURIComponent(generatedPath)}`,
        mimeType: "image/png",
      },
    ]);
  });

  it("hides a heartbeat poll and its trivial HEARTBEAT_OK ack", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    await writeWebchatSession(rootDir, "heartbeat-trivial.jsonl", [
      {
        type: "message",
        id: "msg-before",
        timestamp: "2026-07-06T13:44:59.000Z",
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-07-06T13:44:59.000Z"),
          content: [{ type: "text", text: "图片已生成完成！" }],
        },
      },
      {
        type: "message",
        id: "heartbeat-poll-1",
        parentId: "msg-before",
        timestamp: "2026-07-06T13:45:00.956Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-07-06T13:45:00.956Z"),
          content: "[OpenClaw heartbeat poll]",
        },
      },
      {
        type: "message",
        id: "heartbeat-reply-1",
        parentId: "heartbeat-poll-1",
        timestamp: "2026-07-06T13:45:10.346Z",
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-07-06T13:45:10.346Z"),
          content: [{ type: "text", text: "HEARTBEAT_OK" }],
        },
      },
    ]);

    const result = await runtime.getChatHistory("heartbeat-trivial.jsonl");

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.id).toBe("msg-before");
  });

  it("drops the sanitized delivery echo of a MEDIA-marker reply", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    await writeWebchatSession(rootDir, "media-echo.jsonl", [
      {
        type: "message",
        id: "reply-original",
        timestamp: "2026-07-14T08:51:14.380Z",
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-07-14T08:51:14.380Z"),
          content: [
            {
              type: "text",
              text: "已生成帖子，可直接发布。\n\nMEDIA: /tmp/media/cover.png",
            },
          ],
        },
      },
      {
        type: "message",
        id: "reply-echo",
        parentId: "reply-original",
        timestamp: "2026-07-14T08:51:15.293Z",
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-07-14T08:51:15.293Z"),
          content: [{ type: "text", text: "已生成帖子，可直接发布。" }],
        },
      },
    ]);

    const result = await runtime.getChatHistory("media-echo.jsonl");

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.id).toBe("reply-original");
  });

  it("keeps consecutive assistant replies that are genuinely different", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    await writeWebchatSession(rootDir, "media-no-echo.jsonl", [
      {
        type: "message",
        id: "reply-a",
        timestamp: "2026-07-14T08:51:14.380Z",
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-07-14T08:51:14.380Z"),
          content: [{ type: "text", text: "第一步完成。" }],
        },
      },
      {
        type: "message",
        id: "reply-b",
        parentId: "reply-a",
        timestamp: "2026-07-14T08:51:15.293Z",
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-07-14T08:51:15.293Z"),
          content: [{ type: "text", text: "第二步完成。" }],
        },
      },
    ]);

    const result = await runtime.getChatHistory("media-no-echo.jsonl");

    expect(result.messages).toHaveLength(2);
  });

  it("deduplicates sessions.steer abort snapshots and marks the partial output", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    await writeWebchatSession(rootDir, "steer-abort.jsonl", [
      {
        type: "message",
        id: "assistant-tool",
        timestamp: "2026-07-28T09:37:40.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Preparing the repository scan." },
            { type: "toolCall", id: "call-1", name: "exec" },
          ],
        },
      },
      {
        type: "message",
        id: "abort-snapshot",
        timestamp: "2026-07-28T09:37:53.654Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Preparing the repository scan.The repository boundary is confirmed.",
            },
          ],
          provider: "openclaw",
          model: "gateway-injected",
          openclawAbort: { aborted: true, runId: "run-original" },
        },
      },
      {
        type: "leaf",
        id: "abort-leaf",
      },
      {
        type: "message",
        id: "provider-aborted",
        timestamp: "2026-07-28T09:37:53.739Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "The repository boundary is confirmed." },
          ],
          provider: "custom-openai",
          model: "test-model",
          stopReason: "aborted",
        },
      },
    ]);

    const result = await runtime.getChatHistory("steer-abort.jsonl");

    expect(result.messages.map(({ id }) => id)).toEqual([
      "assistant-tool",
      "provider-aborted",
    ]);
    expect(result.messages[1]).toMatchObject({
      id: "provider-aborted",
      aborted: true,
    });
  });

  it("hides only the poll line when the agent uses a heartbeat to send a proactive message", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    await writeWebchatSession(rootDir, "heartbeat-proactive.jsonl", [
      {
        type: "message",
        id: "heartbeat-poll-2",
        timestamp: "2026-07-06T13:45:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-07-06T13:45:00.000Z"),
          content: "[OpenClaw heartbeat poll]",
        },
      },
      {
        type: "message",
        id: "heartbeat-reply-2",
        parentId: "heartbeat-poll-2",
        timestamp: "2026-07-06T13:45:10.000Z",
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-07-06T13:45:10.000Z"),
          content: [{ type: "text", text: "提醒一下：你今天还没检查过日历。" }],
        },
      },
    ]);

    const result = await runtime.getChatHistory("heartbeat-proactive.jsonl");

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.id).toBe("heartbeat-reply-2");
    expect(result.messages[0]?.content).toStrictEqual([
      { type: "text", text: "提醒一下：你今天还没检查过日历。" },
    ]);
  });

  it("strips inter-session envelopes and re-attributes routed media to the bot", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    await writeWebchatSession(rootDir, "inter-session.jsonl", [
      {
        type: "message",
        id: "msg-routed-image",
        timestamp: "2026-06-11T06:34:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-06-11T06:34:00.000Z"),
          content: [
            {
              type: "text",
              text: "[Inter-session message] sourceSession=image_generate:abc sourceChannel=webchat sourceTool=image_generate isUser=false\nThis content was routed by OpenClaw from another session or internal tool.\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\ninternal details\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
            },
            { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
          ],
        },
      },
      {
        type: "message",
        id: "msg-routed-text-only",
        timestamp: "2026-06-11T06:35:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-06-11T06:35:00.000Z"),
          content:
            "[Inter-session message] sourceSession=cron:xyz isUser=false\nrouting envelope only",
        },
      },
    ]);

    const result = await runtime.getChatHistory("inter-session.jsonl");

    // Text-only envelope is dropped entirely; media-bearing envelope keeps
    // its image and is shown as a bot message.
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: "msg-routed-image",
      role: "assistant",
    });
    expect(result.messages[0]?.content).toStrictEqual([
      { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
    ]);
  });

  it("rewrites media paths inside A2UI tool results and mirrors files to the cache", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const nexuHomeDir = path.join(rootDir, "nexu-home");
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawCuratedSkillsDir: path.join(rootDir, "bundled-skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
        nexuHomeDir,
      }),
    );
    const generatedPath = path.join(
      rootDir,
      "media",
      "tool-image-generation",
      "poster.png",
    );
    await mkdir(path.dirname(generatedPath), { recursive: true });
    await writeFile(generatedPath, "png-bytes", "utf8");
    const outsidePath = "/etc/passwd";
    await writeWebchatSession(rootDir, "a2ui-media.jsonl", [
      {
        type: "message",
        id: "msg-a2ui-media",
        timestamp: "2026-06-11T07:00:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-9",
          toolName: "render_a2ui",
          timestamp: Date.parse("2026-06-11T07:00:00.000Z"),
          content: [
            {
              type: "text",
              text: `\`\`\`a2ui\n{"version":"v0.9","updateComponents":{"surfaceId":"sidebar:poster","components":[{"id":"img","type":"Image","source":"${generatedPath}"},{"id":"raw","type":"Image","source":"${outsidePath}"}]}}\n\`\`\``,
            },
          ],
        },
      },
    ]);

    const result = await runtime.getChatHistory("a2ui-media.jsonl");

    expect(result.messages).toHaveLength(1);
    const text = (
      result.messages[0]?.content as Array<{ type: string; text: string }>
    )[0]?.text;
    // In-root path becomes a served URL; outside-root path stays untouched.
    expect(text).toContain(
      `/api/v1/media/state-file?path=${encodeURIComponent(generatedPath)}`,
    );
    expect(text).not.toContain(`"source":"${generatedPath}"`);
    expect(text).toContain(`"source":"${outsidePath}"`);
    // The referenced file is mirrored into the durable cache.
    const cached = await readFile(
      mediaCachePathFor(mediaCacheDir(nexuHomeDir), generatedPath),
      "utf8",
    );
    expect(cached).toBe("png-bytes");
  });

  it("mirrors MediaPaths media into the cache at history-read time", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const nexuHomeDir = path.join(rootDir, "nexu-home");
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawCuratedSkillsDir: path.join(rootDir, "bundled-skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
        nexuHomeDir,
      }),
    );
    const inboundPath = path.join(rootDir, "media", "inbound", "upload.jpg");
    await mkdir(path.dirname(inboundPath), { recursive: true });
    await writeFile(inboundPath, "jpg-bytes", "utf8");
    await writeWebchatSession(rootDir, "media-cache.jsonl", [
      {
        type: "message",
        id: "msg-upload",
        timestamp: "2026-06-11T07:01:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-06-11T07:01:00.000Z"),
          content: "看看这张图",
          MediaPath: inboundPath,
          MediaType: "image/jpeg",
        },
      },
    ]);

    await runtime.getChatHistory("media-cache.jsonl");

    const cached = await readFile(
      mediaCachePathFor(mediaCacheDir(nexuHomeDir), inboundPath),
      "utf8",
    );
    expect(cached).toBe("jpg-bytes");
  });

  async function writeIndexMappedSession(
    dir: string,
    botId: string,
    sessionKey: string,
    sessionId: string,
  ): Promise<{ sessionsDir: string; sessionPath: string }> {
    const sessionsDir = path.join(dir, "agents", botId, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "msg-1",
        timestamp: "2026-07-01T10:00:00.000Z",
        message: {
          role: "user",
          timestamp: Date.parse("2026-07-01T10:00:00.000Z"),
          content: [{ type: "text", text: "hello" }],
        },
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify(
        {
          [sessionKey]: {
            sessionId,
            sessionFile: sessionPath,
            updatedAt: Date.parse("2026-07-01T10:00:00.000Z"),
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return { sessionsDir, sessionPath };
  }

  it("updateSession writes metadata to the UUID file mapped in sessions.json, not the legacy sessionKey path", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionId = "3f2a9c40-88f1-4f0e-9a4b-6f1d2e3c4b5a";
    const sessionKey = "agent:bot-main:main";
    const { sessionsDir, sessionPath } = await writeIndexMappedSession(
      rootDir,
      "bot-main",
      sessionKey,
      sessionId,
    );
    await writeFile(
      sessionPath.replace(/\.jsonl$/, ".meta.json"),
      `${JSON.stringify({ title: "Old title", channelType: "webchat" }, null, 2)}\n`,
      "utf8",
    );

    const updated = await runtime.updateSession(`${sessionId}.jsonl`, {
      title: "Renamed title",
    });
    expect(updated?.title).toBe("Renamed title");

    const realMeta = JSON.parse(
      await readFile(sessionPath.replace(/\.jsonl$/, ".meta.json"), "utf8"),
    ) as { title?: string };
    expect(realMeta.title).toBe("Renamed title");

    // The legacy {sessionKey}.meta.json orphan must not be created.
    await expect(
      readFile(path.join(sessionsDir, `${sessionKey}.meta.json`), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resetSession truncates the UUID file mapped in sessions.json instead of failing on the legacy path", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = new SessionsRuntime(
      createEnv({
        openclawStateDir: rootDir,
        openclawConfigPath: path.join(rootDir, "openclaw.json"),
        openclawSkillsDir: path.join(rootDir, "skills"),
        openclawWorkspaceTemplatesDir: path.join(
          rootDir,
          "workspace-templates",
        ),
      }),
    );

    const sessionId = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
    const { sessionPath } = await writeIndexMappedSession(
      rootDir,
      "bot-main",
      "agent:bot-main:main",
      sessionId,
    );
    await writeFile(
      sessionPath.replace(/\.jsonl$/, ".meta.json"),
      `${JSON.stringify({ title: "Main", messageCount: 5 }, null, 2)}\n`,
      "utf8",
    );

    const reset = await runtime.resetSession(`${sessionId}.jsonl`);
    expect(reset).not.toBeNull();

    expect(await readFile(sessionPath, "utf8")).toBe("");
    const realMeta = JSON.parse(
      await readFile(sessionPath.replace(/\.jsonl$/, ".meta.json"), "utf8"),
    ) as { messageCount?: number; lastMessageAt?: string | null };
    expect(realMeta.messageCount).toBe(0);
    expect(realMeta.lastMessageAt).toBeNull();
  });

  it("turns an Office MEDIA marker into a downloadable file block", async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-sessions-runtime-"));
    const runtime = createWebchatRuntime(rootDir);
    const generatedPath = path.join(
      rootDir,
      "media",
      "officecli",
      "report.docx",
    );
    await mkdir(path.dirname(generatedPath), { recursive: true });
    await writeFile(generatedPath, "fake-docx", "utf8");
    await writeWebchatSession(rootDir, "office-media.jsonl", [
      {
        type: "message",
        id: "msg-office-media",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: `报告已完成。\n\nMEDIA: ${generatedPath}`,
        },
      },
    ]);

    const result = await runtime.getChatHistory("office-media.jsonl");
    const url = `/api/v1/media/state-file?path=${encodeURIComponent(generatedPath)}`;
    expect(result.messages[0]?.content).toStrictEqual([
      { type: "text", text: "报告已完成。" },
      {
        type: "file",
        url,
        metadata: {
          filename: "report.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          url,
        },
      },
    ]);
  });
});
