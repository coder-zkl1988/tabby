// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  postApiV1SessionsByIdMessagesByMessageIdBranch,
  postApiV1SessionsByIdMessagesByMessageIdRollback,
} from "../lib/api/sdk.gen";
import { A2UISidebarProvider } from "../src/lib/a2ui/a2ui-sidebar-context";
import { SessionsPage } from "../src/pages/sessions";

vi.mock("@/lib/tracking", () => ({
  track: vi.fn(),
}));

// Matches apps/web/src/i18n/locales/en.ts — the session header's "Open in X"
// deep-link button renders these platform labels via i18n, not literal text.
const OPEN_IN_CHANNEL_LABELS: Record<string, string> = {
  "channels.openInSlack": "Open in Slack",
  "channels.openInFeishu": "Open in Feishu",
  "channels.openInTelegram": "Open in Telegram",
  "channels.openInDiscord": "Open in Discord",
  "channels.openInWhatsApp": "Open in WhatsApp",
  "channels.openInDingTalk": "Open in DingTalk",
  "channels.openInWeCom": "Open in WeCom",
  "channels.openInQQ": "Open in QQ",
  "channels.openInWeChat": "Open in WeChat",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === "sessions.chat.messages" && values?.count != null) {
        return `${String(values.count)} messages`;
      }
      if (key === "sessions.chat.lastActive" && values?.time != null) {
        return `Last active ${String(values.time)}`;
      }
      if (key === "sessions.chat.toolActivity") {
        return "Localized Tool Activity";
      }
      if (key === "sessions.chat.toolCompleted") {
        return "Completed";
      }
      if (key === "sessions.chat.stepsCompleted" && values?.count != null) {
        return `${String(values.count)} steps completed`;
      }
      if (key === "sessions.chat.stepsRunning" && values?.count != null) {
        return `Running ${String(values.count)} steps`;
      }
      if (key === "sessions.chat.reasoningStep") {
        return "Thought";
      }
      if (key === "sessions.chat.processNote") {
        return "Process note";
      }
      if (key === "sessions.chat.replyLabel") {
        return "Localized Reply";
      }
      if (key === "sessions.chat.runMessagePlaceholder") {
        return "Continue typing to guide the task or ask about progress";
      }
      if (key === "sessions.chat.runToolsUnavailable") {
        return "Available after the current task finishes";
      }
      if (key === "sessions.chat.sendRunMessage") {
        return "Send";
      }
      if (key === "sessions.chat.stopCurrentTask") {
        return "Stop current task";
      }
      if (key === "sessions.chat.branchFromMessage") {
        return "Branch from this message";
      }
      if (key === "sessions.chat.rollbackToMessage") {
        return "Roll back to this message";
      }
      if (key === "sessions.chat.branchCreated") {
        return "Message branch created";
      }
      if (key === "sessions.chat.branchFailed") {
        return "Unable to create message branch";
      }
      if (key in OPEN_IN_CHANNEL_LABELS) {
        return OPEN_IN_CHANNEL_LABELS[key];
      }
      return key;
    },
  }),
}));

vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1Channels: vi.fn(async () => ({
    data: { channels: [] },
  })),
  getApiV1SessionsById: vi.fn(async () => ({
    data: {
      id: "fetched-session",
      channelId: null,
      title: "Fetched conversation",
      channelType: "web",
      messageCount: 0,
      lastMessageAt: null,
      metadata: {},
    },
  })),
  getApiV1SessionsByIdMessages: vi.fn(async () => ({
    data: { messages: [], sessionKey: "agent:fetched:main" },
  })),
  getApiV1Bots: vi.fn(async () => ({ data: { bots: [] } })),
  getApiV1BotsByBotId: vi.fn(async () => ({ data: undefined })),
  getApiV1ChatRunStatus: vi.fn(async () => ({ data: { busy: false } })),
  postApiV1SessionsByIdMessagesByMessageIdBranch: vi.fn(),
  postApiV1SessionsByIdMessagesByMessageIdRollback: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-probe">{location.pathname}</output>;
}

function renderSessionsPage(options?: {
  busy?: boolean;
  local?: boolean;
}): string {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  queryClient.setQueryData(["session-meta", "sess-1"], {
    id: "sess-1",
    channelId: "channel-slack-1",
    title: "Alex DM",
    channelType: options?.local ? "web" : "slack",
    messageCount: 2,
    lastMessageAt: "2026-03-20T08:58:00.000Z",
    metadata: {
      isGroup: false,
    },
    ...(options?.busy
      ? { botId: "bot-1", sessionKey: "agent:bot-1:main" }
      : {}),
  });
  queryClient.setQueryData(["chat-history", "sess-1"], {
    messages: [
      {
        id: "msg-1",
        role: "user",
        content:
          "[message_id: 123]\\nAlex: Can you summarize tomorrow's meetings?",
        timestamp: new Date("2026-03-20T08:57:00.000Z").getTime(),
        createdAt: "2026-03-20T08:57:00.000Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Sure. I checked your calendar and drafted the summary.",
          },
          {
            type: "toolCall",
            name: "google-calendar",
            arguments: {
              task: "Review every calendar event for the next seven days, compare attendee availability, flag scheduling conflicts, and return a complete recommendation without omitting any event details.",
            },
          },
        ],
        timestamp: new Date("2026-03-20T08:58:00.000Z").getTime(),
        createdAt: "2026-03-20T08:58:00.000Z",
      },
    ],
  });
  if (options?.busy) {
    queryClient.setQueryData(["chat-run-status", "sess-1"], { busy: true });
    queryClient.setQueryData(["bot", "bot-1"], {
      id: "bot-1",
      name: "Provider expert",
      slug: "provider-expert",
      status: "active",
      modelId: "openai/gpt-5.6",
    });
    queryClient.setQueryData(["bots"], { bots: [] });
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <A2UISidebarProvider>
        <MemoryRouter initialEntries={["/workspace/sessions/sess-1"]}>
          <Routes>
            <Route path="/workspace/sessions/:id" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </A2UISidebarProvider>
    </QueryClientProvider>,
  );
}

describe("SessionsPage", () => {
  it("renders a structured session header and cleaned transcript", () => {
    const markup = renderSessionsPage();

    expect(markup).toContain('data-session-platform="slack"');
    expect(markup).toContain('data-chat-thread="sess-1"');
    expect(markup).toContain("<title>Slack</title>");
    expect(markup).toContain("<p>Can you summarize tomorrow's meetings?</p>");
    expect(markup).not.toContain("[message_id:");
    expect(markup).toContain("google-calendar");
    expect(markup).toContain("Open in Slack");
    expect(markup).toContain('data-session-operations-toggle="true"');
    expect(markup).toContain('data-session-browser-toggle="true"');
    expect(markup).toContain('data-session-canvas-toggle="true"');
    expect(markup.indexOf("data-session-browser-toggle")).toBeLessThan(
      markup.indexOf("data-session-canvas-toggle"),
    );
    expect(markup.indexOf("data-session-canvas-toggle")).toBeLessThan(
      markup.indexOf("data-session-operations-toggle"),
    );
    expect(markup).not.toContain('data-message-action="branch"');
    expect(markup.match(/data-message-action="rollback"/g)).toHaveLength(1);
  });

  it("offers branch and rollback only on local user messages", () => {
    const markup = renderSessionsPage({ local: true });
    expect(markup.match(/data-message-action="branch"/g)).toHaveLength(1);
    expect(markup.match(/data-message-action="rollback"/g)).toHaveLength(1);
    expect(markup).not.toMatch(
      /data-message-action="branch"[^>]*\sdisabled=""/,
    );
    expect(markup).not.toMatch(
      /data-message-action="rollback"[^>]*\sdisabled=""/,
    );
  });

  it.each([
    "[路由提示：请先匹配专家并调用会话工具。]\n\n[my note] keep this user text",
    "[请使用「calendar」技能完成本次请求]\n[路由提示：本轮使用专家路由。]\n\n[my note] keep this user text",
    "[my note] keep this user text",
  ])(
    "restores user drafts without injected routing or skill wrappers (%s)",
    async (editorText) => {
      Element.prototype.scrollIntoView = vi.fn();
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
        },
      });
      queryClient.setQueryData(["session-meta", "restored"], {
        id: "restored",
        sessionKey: "agent:bot-1:main",
        channelType: "web",
        title: "Restored",
        messageCount: 0,
        metadata: {},
      });
      queryClient.setQueryData(["chat-history", "restored"], { messages: [] });
      queryClient.setQueryData(["channels"], { channels: [] });
      queryClient.setQueryData(["bots"], { bots: [] });
      render(
        <QueryClientProvider client={queryClient}>
          <A2UISidebarProvider>
            <MemoryRouter
              initialEntries={[
                {
                  pathname: "/workspace/sessions/restored",
                  state: {
                    messageDraft: { sessionId: "restored", editorText },
                  },
                },
              ]}
            >
              <Routes>
                <Route
                  path="/workspace/sessions/:id"
                  element={<SessionsPage />}
                />
              </Routes>
            </MemoryRouter>
          </A2UISidebarProvider>
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
          "[my note] keep this user text",
        ),
      );
    },
  );

  it("keeps one natural composer available while the session is busy", () => {
    const markup = renderSessionsPage({ busy: true, local: true });

    expect(markup).toContain(
      "Continue typing to guide the task or ask about progress",
    );
    expect(markup).toContain("placeholder:text-text-tertiary");
    expect(markup).toContain('data-chat-action="stop"');
    expect(markup).toContain('aria-label="Stop current task"');
    expect(markup).toContain('data-run-message-mode="auto"');
    expect(markup).toContain('data-run-message-mode="side-question"');
    expect(markup).toContain('data-run-message-mode="steer"');
    expect(markup).toMatch(
      /<button[^>]*(?:data-run-message-mode="auto"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-run-message-mode="auto")/,
    );
    expect(markup).not.toContain('data-chat-attachment="true"');
    expect(markup).not.toContain('data-chat-skill="true"');
    expect(markup).toContain('data-chat-agent="true"');
    expect(markup).toContain('data-chat-model="true"');
    expect(markup).toContain("Provider expert");
    expect(markup).toContain("openai/gpt-5.6");
    expect(markup).not.toContain('data-chat-action="send"');
    expect(markup).not.toContain("Stop and redirect");
    expect(markup).not.toContain("Side question");
    expect(markup).toMatch(/data-message-action="branch"[^>]*\sdisabled=""/);
    expect(markup).toMatch(/data-message-action="rollback"[^>]*\sdisabled=""/);
  });

  it("branches from a message and navigates to the new session", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const branchMock = vi.mocked(
      postApiV1SessionsByIdMessagesByMessageIdBranch,
    );
    branchMock.mockResolvedValueOnce({
      data: {
        id: "sess-branched",
        botId: "bot-1",
        sessionKey: "agent:bot-1:branch",
        title: "Branched conversation",
        messageId: "msg-branch-source",
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
        },
      },
    });
    queryClient.setQueryData(["session-meta", "sess-branch-source"], {
      id: "sess-branch-source",
      channelId: "channel-web-1",
      title: "Source conversation",
      channelType: "web",
      messageCount: 1,
      lastMessageAt: "2026-03-20T08:58:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-branch-source"], {
      messages: [
        {
          id: "msg-branch-source",
          role: "user",
          content: "Create an alternative from here",
          timestamp: new Date("2026-03-20T08:58:00.000Z").getTime(),
          createdAt: "2026-03-20T08:58:00.000Z",
        },
      ],
    });
    queryClient.setQueryData(["channels"], { channels: [] });
    queryClient.setQueryData(["bots"], { bots: [] });

    render(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter
            initialEntries={["/workspace/sessions/sess-branch-source"]}
          >
            <LocationProbe />
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Branch from this message" }),
    );

    await waitFor(() => {
      expect(branchMock).toHaveBeenCalledWith({
        path: {
          id: "sess-branch-source",
          messageId: "msg-branch-source",
        },
      });
      expect(screen.getByTestId("location-probe").textContent).toBe(
        "/workspace/sessions/sess-branched",
      );
    });
  });

  it("confirms and rolls the current session back to a message", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const rollbackMock = vi.mocked(
      postApiV1SessionsByIdMessagesByMessageIdRollback,
    );
    rollbackMock.mockResolvedValueOnce({
      data: {
        ok: true,
        id: "sess-rollback",
        sessionKey: "agent:bot-1:main",
        messageId: "msg-rollback",
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    queryClient.setQueryData(["session-meta", "sess-rollback"], {
      id: "sess-rollback",
      channelId: "channel-web-1",
      title: "Rollback conversation",
      channelType: "web",
      messageCount: 1,
      lastMessageAt: "2026-03-20T08:58:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-rollback"], {
      messages: [
        {
          id: "msg-rollback",
          role: "user",
          content: "Return here",
          timestamp: new Date("2026-03-20T08:58:00.000Z").getTime(),
          createdAt: "2026-03-20T08:58:00.000Z",
        },
      ],
    });
    queryClient.setQueryData(["channels"], { channels: [] });
    queryClient.setQueryData(["bots"], { bots: [] });

    render(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter initialEntries={["/workspace/sessions/sess-rollback"]}>
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Roll back to this message" }),
    );

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(rollbackMock).toHaveBeenCalledWith({
        path: { id: "sess-rollback", messageId: "msg-rollback" },
      });
    });
  });

  it("renders assistant tool activity as a compact execution group", () => {
    const markup = renderSessionsPage();

    expect(markup).toContain('data-chat-layout="centered"');
    expect(markup).toContain("data-execution-group=");
    expect(markup).toContain('data-execution-state="completed"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-tool-card="google-calendar"');
    expect(markup).toContain('data-tool-card-variant="execution-row"');
    expect(markup).toContain('data-tool-arguments-toggle="google-calendar"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(
      "return a complete recommendation without omitting any event details.",
    );
    expect(markup).toContain(">1 steps completed<");
    expect(markup).toContain("Google Calendar");
    expect(markup).not.toContain(">Localized Tool Activity<");
  });

  it("renders markdown formatting with safe links and escaped raw html", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-markdown"], {
      id: "sess-markdown",
      title: "Markdown check",
      channelType: "web",
      messageCount: 1,
      lastMessageAt: "2026-03-22T15:00:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-markdown"], {
      messages: [
        {
          id: "msg-markdown",
          role: "assistant",
          content:
            "**bold** [docs](https://example.com) `inline`\n\n<script>alert('xss')</script>",
          timestamp: new Date("2026-03-22T15:00:00.000Z").getTime(),
          createdAt: "2026-03-22T15:00:00.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter initialEntries={["/workspace/sessions/sess-markdown"]}>
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain("<strong>bold</strong>");
    expect(markup).toContain("<code>inline</code>");
    expect(markup).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">',
    );
    expect(markup).toContain("&lt;script&gt;alert('xss')&lt;/script&gt;");
  });

  it("does not render markdown image syntax as an img tag", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-markdown-image"], {
      id: "sess-markdown-image",
      title: "Markdown image check",
      channelType: "web",
      messageCount: 1,
      lastMessageAt: "2026-03-23T03:20:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-markdown-image"], {
      messages: [
        {
          id: "msg-markdown-image",
          role: "assistant",
          content: "![tracker](https://example.com/pixel)",
          timestamp: new Date("2026-03-23T03:20:00.000Z").getTime(),
          createdAt: "2026-03-23T03:20:00.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter
            initialEntries={["/workspace/sessions/sess-markdown-image"]}
          >
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    expect(markup).not.toContain('<img src="https://example.com/pixel"');
    expect(markup).toContain(
      '!<a href="https://example.com/pixel" target="_blank" rel="noopener noreferrer nofollow">tracker</a>',
    );
  });

  it("strips conversation metadata blocks before rendering user text", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-meta-only"], {
      id: "sess-meta-only",
      title: "测试",
      channelType: "web",
      messageCount: 1,
      lastMessageAt: "2026-03-22T10:49:06.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-meta-only"], {
      messages: [
        {
          id: "msg-meta-only",
          role: "user",
          content:
            'Conversation info (untrusted metadata):\n```json\n{\n  "message_id": "openclaw-weixin:1774176546217-9644087e",\n  "timestamp": "Sun 2026-03-22 18:49 GMT+8"\n}\n```\n\n测试',
          timestamp: new Date("2026-03-22T10:49:06.000Z").getTime(),
          createdAt: "2026-03-22T10:49:06.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter initialEntries={["/workspace/sessions/sess-meta-only"]}>
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain("测试");
    expect(markup).not.toContain("Conversation info (untrusted metadata)");
    expect(markup).not.toContain("openclaw-weixin:1774176546217-9644087e");
  });

  it("strips the controller-injected expert-routing hint before rendering user text", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-routing-hint"], {
      id: "sess-routing-hint",
      title: "克隆龙",
      channelType: "web",
      messageCount: 1,
      lastMessageAt: "2026-07-01T06:13:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-routing-hint"], {
      messages: [
        {
          id: "msg-routing-hint",
          role: "user",
          content:
            "[路由提示：如果本请求属于某个垂直专业领域、且有更合适的专家来处理，请先调用 find_expert 检索；命中已安装专家就用 sessions_spawn 委派给它并把结果转述给用户，命中未安装专家就调用 propose_expert_install 让用户确认安装；如果只是通用、简单或闲聊类问题，直接自己回答，不要路由。]\n\n你是谁你能做什么",
          timestamp: new Date("2026-07-01T06:13:00.000Z").getTime(),
          createdAt: "2026-07-01T06:13:00.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter
            initialEntries={["/workspace/sessions/sess-routing-hint"]}
          >
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain("你是谁你能做什么");
    expect(markup).not.toContain("路由提示");
    expect(markup).not.toContain("find_expert");
  });

  it("renders a Feishu deep link when the backing channel config is available", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-2"], {
      id: "sess-2",
      botId: "bot-feishu",
      sessionKey: "sess-2",
      channelId: "channel-feishu-1",
      title: "唐其远",
      channelType: "feishu",
      messageCount: 1,
      lastMessageAt: "2026-03-20T08:58:00.000Z",
      metadata: {
        path: "/Users/qiyuan/.openclaw/agents/bot-feishu/sessions/sess-2.jsonl",
        openChatId: "oc_41e7bdf4877cfc316136f4ccf6c32613",
      },
    });
    queryClient.setQueryData(["chat-history", "sess-2"], {
      messages: [
        {
          id: "msg-3",
          role: "assistant",
          content: "Hello from Feishu",
          timestamp: new Date("2026-03-20T08:58:00.000Z").getTime(),
          createdAt: "2026-03-20T08:58:00.000Z",
        },
      ],
    });
    queryClient.setQueryData(["channels"], {
      channels: [
        {
          id: "channel-feishu-1",
          channelType: "feishu",
          accountId: "feishu:cli_xxx",
          teamName: "Feishu Team",
          appId: "cli_xxx",
          botUserId: null,
          status: "connected",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter initialEntries={["/workspace/sessions/sess-2"]}>
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain(
      'href="https://applink.feishu.cn/client/chat/open?openChatId=oc_41e7bdf4877cfc316136f4ccf6c32613"',
    );
    expect(markup).toContain("Open in Feishu");
    // "Open Folder" (with data-session-folder-url) was removed from the page;
    // this test used to assert it — keep only the deep-link behavior.
  });

  it("does not render a wrong Feishu deep link when exact chat metadata is missing", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-3"], {
      id: "sess-3",
      botId: "bot-feishu",
      sessionKey: "sess-3",
      channelId: "channel-feishu-1",
      title: "唐其远",
      channelType: "feishu",
      messageCount: 1,
      lastMessageAt: "2026-03-20T08:58:00.000Z",
      metadata: {
        path: "/Users/qiyuan/.openclaw/agents/bot-feishu/sessions/sess-3.jsonl",
        openId: "ou_00c644f271002b17348e992569f0f327",
      },
    });
    queryClient.setQueryData(["chat-history", "sess-3"], {
      messages: [
        {
          id: "msg-4",
          role: "assistant",
          content: "Hello from Feishu DM",
          timestamp: new Date("2026-03-20T08:58:00.000Z").getTime(),
          createdAt: "2026-03-20T08:58:00.000Z",
        },
      ],
    });
    queryClient.setQueryData(["channels"], {
      channels: [
        {
          id: "channel-feishu-1",
          channelType: "feishu",
          accountId: "feishu:cli_xxx",
          teamName: "Feishu Team",
          appId: "cli_xxx",
          botUserId: null,
          status: "connected",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter initialEntries={["/workspace/sessions/sess-3"]}>
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain("Open in Feishu");
    expect(markup).not.toContain(
      'href="https://applink.feishu.cn/client/chat/open?openId=ou_00c644f271002b17348e992569f0f327"',
    );
    expect(markup).not.toContain(
      'href="https://applink.feishu.cn/client/bot/open?appId=cli_xxx"',
    );
  });

  it("renders WhatsApp session headers with the platform icon and open-chat action", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-whatsapp"], {
      id: "sess-whatsapp",
      botId: "bot-whatsapp",
      sessionKey: "sess-whatsapp",
      channelId: "channel-whatsapp-1",
      title: "Alice",
      channelType: "whatsapp",
      messageCount: 5,
      lastMessageAt: "2026-03-20T08:58:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-whatsapp"], {
      messages: [
        {
          id: "msg-whatsapp-1",
          role: "assistant",
          content: "Hello from WhatsApp",
          timestamp: new Date("2026-03-20T08:58:00.000Z").getTime(),
          createdAt: "2026-03-20T08:58:00.000Z",
        },
      ],
    });
    queryClient.setQueryData(["channels"], {
      channels: [
        {
          id: "channel-whatsapp-1",
          channelType: "whatsapp",
          accountId: "whatsapp-default",
          teamName: "WhatsApp",
          appId: null,
          botUserId: null,
          status: "connected",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter initialEntries={["/workspace/sessions/sess-whatsapp"]}>
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-session-platform="whatsapp"');
    expect(markup).toContain("<title>WhatsApp</title>");
    expect(markup).toContain("WhatsApp · 5 messages");
    expect(markup).toContain('href="https://web.whatsapp.com/"');
    expect(markup).toContain("Open in WhatsApp");
  });

  it("strips assistant reply markers and keeps tool-only activity visible", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-tool"], {
      id: "sess-tool",
      title: "Feishu cleanup",
      channelType: "feishu",
      messageCount: 2,
      lastMessageAt: "2026-03-23T03:20:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-tool"], {
      messages: [
        {
          id: "msg-prefix",
          role: "assistant",
          content: "[[reply_to_current]] 已处理完成，全部状态已修正为已上线。",
          timestamp: new Date("2026-03-23T03:19:00.000Z").getTime(),
          createdAt: "2026-03-23T03:19:00.000Z",
        },
        {
          id: "msg-tool-only",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "feishu_bitable_list_records",
            },
          ],
          timestamp: new Date("2026-03-23T03:20:00.000Z").getTime(),
          createdAt: "2026-03-23T03:20:00.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter initialEntries={["/workspace/sessions/sess-tool"]}>
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain("已处理完成，全部状态已修正为已上线。");
    expect(markup).not.toContain("[[reply_to_current]]");
    expect(markup).toContain('data-tool-card="feishu_bitable_list_records"');
    expect(markup).toContain("Feishu Bitable List Records");
  });

  it("falls back to the localized tool label for placeholder tool names", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-tool-fallback"], {
      id: "sess-tool-fallback",
      title: "Placeholder tool names",
      channelType: "web",
      messageCount: 2,
      lastMessageAt: "2026-03-23T03:35:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-tool-fallback"], {
      messages: [
        {
          id: "msg-placeholder-name",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "tool",
            },
          ],
          timestamp: new Date("2026-03-23T03:34:00.000Z").getTime(),
          createdAt: "2026-03-23T03:34:00.000Z",
        },
        {
          id: "msg-separator-name",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "---",
            },
          ],
          timestamp: new Date("2026-03-23T03:35:00.000Z").getTime(),
          createdAt: "2026-03-23T03:35:00.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter
            initialEntries={["/workspace/sessions/sess-tool-fallback"]}
          >
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    const fallbackMatches = markup.match(/Localized Tool Activity/g) ?? [];

    expect(markup).toContain('data-tool-card="tool"');
    expect(markup).toContain('data-tool-card="---"');
    expect(markup).not.toContain(">Tool<");
    expect(fallbackMatches).toHaveLength(2);
  });

  it("renders reply context as quote UI instead of raw metadata", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-reply"], {
      id: "sess-reply",
      title: "Feishu reply",
      channelType: "feishu",
      messageCount: 1,
      lastMessageAt: "2026-03-23T03:25:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-reply"], {
      messages: [
        {
          id: "msg-reply-context",
          role: "user",
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
          timestamp: new Date("2026-03-23T03:25:00.000Z").getTime(),
          createdAt: "2026-03-23T03:25:00.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter initialEntries={["/workspace/sessions/sess-reply"]}>
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-reply-context="[Interactive Card]"');
    expect(markup).toContain("Interactive Card");
    expect(markup).toContain("你是谁");
    expect(markup).toContain("Localized Reply");
    expect(markup).not.toContain(">Reply<");
    expect(markup).not.toContain(
      "[Replying to: &quot;[Interactive Card]&quot;]",
    );
  });

  it("renders the TeamRunCard from a team_run_auto tool result (real transcript shape)", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["session-meta", "sess-team-run"], {
      id: "sess-team-run",
      title: "小红书运营团队 队长",
      channelType: "web",
      messageCount: 3,
      lastMessageAt: "2026-07-03T03:32:00.000Z",
      metadata: {},
    });
    // Mirrors the live OpenClaw transcript exactly: the a2ui JSONL rides in
    // the FIRST toolResult text block, the model-facing summary in the second.
    const a2uiJsonl = [
      JSON.stringify({
        version: "v0.9",
        createSurface: {
          surfaceId: "team-run-parent-1",
          catalogId: "https://nexu.app/a2ui/custom-catalog.json",
        },
      }),
      JSON.stringify({
        version: "v0.9",
        updateComponents: {
          surfaceId: "team-run-parent-1",
          components: [
            {
              id: "team-run-card",
              type: "TeamRunCard",
              run: {
                teamId: "team-1",
                boardId: "team-team-1",
                parentCardId: "parent-1",
                title: "便携咖啡机种草笔记",
                steps: [
                  {
                    id: "card-a",
                    name: "卖点分析",
                    assigneeName: "小红书运营专家",
                    cardId: "card-a",
                    dependsOn: [],
                  },
                ],
              },
            },
          ],
        },
      }),
    ].join("\n");
    queryClient.setQueryData(["chat-history", "sess-team-run"], {
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "帮团队安排任务",
          timestamp: new Date("2026-07-03T03:32:00.000Z").getTime(),
          createdAt: "2026-07-03T03:32:00.000Z",
        },
        {
          id: "msg-2",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "team_run_auto",
              arguments: { task: "写种草笔记" },
            },
          ],
          timestamp: new Date("2026-07-03T03:32:05.000Z").getTime(),
          createdAt: "2026-07-03T03:32:05.000Z",
        },
        {
          id: "msg-3",
          role: "toolResult",
          toolName: "team_run_auto",
          toolCallId: "call_1",
          content: [
            { type: "text", text: ["```a2ui", a2uiJsonl, "```"].join("\n") },
            { type: "text", text: '{"started":true,"note":"..."}' },
          ],
          timestamp: new Date("2026-07-03T03:32:06.000Z").getTime(),
          createdAt: "2026-07-03T03:32:06.000Z",
        },
        {
          id: "msg-4",
          role: "assistant",
          content: "已安排团队开始处理。",
          timestamp: new Date("2026-07-03T03:32:08.000Z").getTime(),
          createdAt: "2026-07-03T03:32:08.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter initialEntries={["/workspace/sessions/sess-team-run"]}>
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    // The run card must render inline on the assistant message that called
    // the tool; the raw a2ui payload must never leak as text.
    expect(markup).toContain('data-team-run-card="parent-1"');
    expect(markup).toContain("便携咖啡机种草笔记");
    expect(markup).toContain("卖点分析");
    expect(markup).not.toContain("```a2ui");
  });

  it("renders the CanvasOpCard from a canvas_op tool result and strips the raw block", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["session-meta", "sess-canvas-op"], {
      id: "sess-canvas-op",
      title: "画布助手",
      channelType: "web",
      messageCount: 3,
      lastMessageAt: "2026-07-07T03:32:00.000Z",
      metadata: {},
    });
    // Mirrors the nexu-canvas plugin transcript: the fenced ```canvas-op```
    // JSON rides in the canvas_op toolResult text.
    const canvasOpBlock = [
      "```canvas-op",
      JSON.stringify({
        ops: [
          { op: "add_node", ref: "n1", nodeType: "text", title: "标题" },
          { op: "connect", from: "ref:n1", to: "ref:n1" },
        ],
        summary: "加一个文本节点",
      }),
      "```",
    ].join("\n");
    queryClient.setQueryData(["chat-history", "sess-canvas-op"], {
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "在画布上加个标题节点",
          timestamp: new Date("2026-07-07T03:32:00.000Z").getTime(),
          createdAt: "2026-07-07T03:32:00.000Z",
        },
        {
          id: "msg-2",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_canvas_1",
              name: "canvas_op",
              arguments: {},
            },
          ],
          timestamp: new Date("2026-07-07T03:32:05.000Z").getTime(),
          createdAt: "2026-07-07T03:32:05.000Z",
        },
        {
          id: "msg-3",
          role: "toolResult",
          toolName: "canvas_op",
          toolCallId: "call_canvas_1",
          content: [{ type: "text", text: canvasOpBlock }],
          timestamp: new Date("2026-07-07T03:32:06.000Z").getTime(),
          createdAt: "2026-07-07T03:32:06.000Z",
        },
        {
          id: "msg-4",
          role: "assistant",
          content: "已经准备好画布操作，请确认。",
          timestamp: new Date("2026-07-07T03:32:08.000Z").getTime(),
          createdAt: "2026-07-07T03:32:08.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter initialEntries={["/workspace/sessions/sess-canvas-op"]}>
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    // The confirm card renders inline on the parent assistant message; the raw
    // fenced block must never leak as text.
    expect(markup).toContain("data-canvas-op-card");
    expect(markup).toContain("加一个文本节点");
    expect(markup).toContain("data-canvas-op-apply");
    expect(markup).not.toContain("```canvas-op");
    expect(markup).not.toContain('"add_node"');
  });

  it("renders a failure chip for a canvas_op_result round-trip, never the raw JSON", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["session-meta", "sess-canvas-op-result"], {
      id: "sess-canvas-op-result",
      title: "画布助手",
      channelType: "web",
      messageCount: 1,
      lastMessageAt: "2026-07-07T03:33:00.000Z",
      metadata: {},
    });
    // Mirrors what CanvasOpCard posts back via postApiV1ChatLocal when the
    // user clicks 应用 and applyCanvasOps() returns errors (canvas-op-card.tsx).
    queryClient.setQueryData(["chat-history", "sess-canvas-op-result"], {
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: JSON.stringify({
            type: "canvas_op_result",
            applied: 1,
            errors: ["未找到节点：does-not-exist"],
          }),
          timestamp: new Date("2026-07-07T03:33:00.000Z").getTime(),
          createdAt: "2026-07-07T03:33:00.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <A2UISidebarProvider>
          <MemoryRouter
            initialEntries={["/workspace/sessions/sess-canvas-op-result"]}
          >
            <Routes>
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
            </Routes>
          </MemoryRouter>
        </A2UISidebarProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain("data-canvas-op-result");
    expect(markup).toContain("画布操作应用失败（1 项）");
    expect(markup).not.toContain("canvas_op_result");
    expect(markup).not.toContain("does-not-exist");
  });
});
