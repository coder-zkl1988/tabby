import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceLayout,
  deleteSidebarSession,
  filterSidebarSessions,
  getSidebarCreditBreakdown,
  renameSidebarSession,
} from "../src/layouts/workspace-layout";

const sessionApiMocks = vi.hoisted(() => ({
  getSessions: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
}));

vi.mock("@/lib/api", () => ({}));

vi.mock("@/lib/tracking", () => ({
  track: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/hooks/use-auto-update", () => ({
  useAutoUpdate: () => ({
    phase: "idle",
    percent: 0,
    version: null,
    download: vi.fn(),
    install: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-community-catalog", () => ({
  useCommunitySkillStatus: () => ({
    data: {
      installedSkills: [],
    },
  }),
}));

vi.mock("@/hooks/use-locale", () => ({
  useLocale: () => ({
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: {
        user: {
          email: "alice@example.com",
          name: "Alice",
        },
      },
    }),
    signOut: vi.fn(),
  },
}));

vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1Sessions: (...args: unknown[]) =>
    sessionApiMocks.getSessions(...args),
  deleteApiV1SessionsById: (...args: unknown[]) =>
    sessionApiMocks.deleteSession(...args),
  patchApiInternalSessionsById: (...args: unknown[]) =>
    sessionApiMocks.renameSession(...args),
  getApiV1Me: vi.fn(async () => ({
    data: {
      email: "alice@example.com",
      name: "Alice",
    },
  })),
}));

const storage = new Map<string, string>();

function installBrowserStubs() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "Mozilla/5.0",
    },
  });
}

function renderWorkspaceLayout(
  initialEntry = "/workspace/sessions/sess-1",
  rewardsStatus?: {
    viewer: {
      cloudConnected: boolean;
      activeModelId: string | null;
      activeModelProviderId: string | null;
      usingManagedModel: boolean;
    };
    progress: {
      claimedCount: number;
      totalCount: number;
      earnedCredits: number;
      availableCredits?: number;
    };
    cloudBalance: {
      totalBalance: number;
      totalRecharged: number;
      totalConsumed: number;
      giftedBalance?: number;
      planBalance?: number;
    } | null;
    tasks?: Array<Record<string, unknown>>;
  },
  cloudStatus?: {
    connected: boolean;
    polling?: boolean;
    userName?: string | null;
    userEmail?: string | null;
    connectedAt?: string | null;
    cloudUrl?: string;
    linkUrl?: string | null;
    activeProfileName?: string;
    profiles?: Array<Record<string, unknown>>;
  },
  sessionListError = false,
): string {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        retryOnMount: false,
      },
    },
  });

  if (sessionListError) {
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: ["sidebar-sessions"],
      queryFn: async () => [],
    });
    query.setState({
      error: new Error("session list unavailable"),
      fetchStatus: "idle",
      status: "error",
    });
  } else {
    queryClient.setQueryData(
      ["sidebar-sessions"],
      [
        {
          id: "sess-1",
          title: "Design sync thread",
          channelType: "slack",
          lastTime: "2026-03-20T08:57:00.000Z",
          status: "active",
          sessionKey: "agent:bot-1:slack:channel:C123",
        },
      ],
    );
  }
  queryClient.setQueryData(["me"], {
    email: "alice@example.com",
    name: "Alice",
  });
  if (rewardsStatus) {
    queryClient.setQueryData(["desktop-rewards"], {
      tasks: [],
      ...rewardsStatus,
    });
  }
  if (cloudStatus) {
    queryClient.setQueryData(["desktop-cloud-status"], {
      cloudUrl: "http://localhost:5176",
      linkUrl: "http://localhost:8080",
      activeProfileName: "Local",
      profiles: [],
      ...cloudStatus,
    });
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route element={<WorkspaceLayout />}>
            <Route path="/workspace" element={<div>Home body</div>} />
            <Route
              path="/workspace/sessions/:id"
              element={<div>Session body</div>}
            />
            <Route
              path="/workspace/rewards"
              element={<div>Rewards body</div>}
            />
            <Route path="/workspace/home" element={<div>Home body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("WorkspaceLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.clear();
    storage.set("nexu_setup_complete", "1");
    installBrowserStubs();
    sessionApiMocks.getSessions.mockResolvedValue({ data: { sessions: [] } });
    sessionApiMocks.deleteSession.mockResolvedValue({ data: {} });
    sessionApiMocks.renameSession.mockResolvedValue({ data: {} });
  });

  it("renders structured sidebar session rows for the workspace shell", () => {
    const markup = renderWorkspaceLayout();

    expect(markup).toContain('data-sidebar-session-row="sess-1"');
    expect(markup).toContain('data-session-channel-type="slack"');
    expect(markup).toContain('data-session-state="active"');
    expect(markup).toContain("<title>Slack</title>");
    expect(markup).toContain("Design sync thread");
    expect(markup).not.toContain("data-session-group-heading");
  });

  it("renders an unavailable retry state instead of a fake empty session list", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/sessions/sess-1",
      undefined,
      undefined,
      true,
    );

    expect(markup).toContain('data-session-list-unavailable="true"');
    expect(markup).toContain('data-session-list-retry="true"');
    expect(markup).toContain("layout.sessionsUnavailable");
    expect(markup).not.toContain("layout.noMatchingConversations");
  });

  it("rejects SDK errors for rename and delete instead of reporting success", async () => {
    sessionApiMocks.renameSession.mockResolvedValue({
      error: { message: "rename denied" },
    });
    sessionApiMocks.deleteSession.mockResolvedValue({
      error: { message: "delete denied" },
    });

    await expect(
      renameSidebarSession({ id: "sess-1", title: "New title" }),
    ).rejects.toThrow("rename session failed");
    await expect(deleteSidebarSession("sess-1")).rejects.toThrow(
      "delete session failed",
    );
  });

  it("renders the filter dropdown before session search without a section title", () => {
    const markup = renderWorkspaceLayout();
    const filterIndex = markup.indexOf('data-session-filter="true"');
    const searchIndex = markup.indexOf('data-session-search="true"');

    expect(markup).toContain('data-session-controls="true"');
    expect(filterIndex).toBeGreaterThan(-1);
    expect(searchIndex).toBeGreaterThan(filterIndex);
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('class="w-[84px] shrink-0"');
    expect(markup).not.toContain(">layout.conversations</div>");
  });

  it("filters conversations by title and stable session category", () => {
    const sessions = [
      {
        id: "live-1",
        title: "Release review",
        channelType: "web",
        lastTime: null,
        status: "active",
        sessionKey: "agent:bot-1:main",
      },
      {
        id: "ended-1",
        title: "Archived notes",
        channelType: "slack",
        lastTime: null,
        status: "ended",
        sessionKey: "agent:bot-1:slack:dm:1",
      },
      {
        id: "scheduled-1",
        title: "Release monitor",
        channelType: "web",
        lastTime: null,
        status: "active",
        sessionKey: "agent:bot-1:schedule-daily",
      },
    ];

    expect(filterSidebarSessions(sessions, "release", "all")).toHaveLength(2);
    expect(
      filterSidebarSessions(sessions, "", "conversations").map(
        (item) => item.id,
      ),
    ).toEqual(["live-1", "ended-1"]);
    expect(
      filterSidebarSessions(sessions, "monitor", "scheduled").map(
        (item) => item.id,
      ),
    ).toEqual(["scheduled-1"]);
  });

  it("does not render a sidebar collapse control in the desktop shell", () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Mozilla/5.0 Electron" },
    });

    const markup = renderWorkspaceLayout();

    expect(markup).not.toContain("layout.collapseSidebar");
    expect(markup).not.toContain("layout.expandSidebar");
  });

  it("shows a syncing placeholder instead of zero balance while rewards are still loading", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/sessions/sess-1",
      undefined,
      {
        connected: true,
      },
    );

    expect(markup).toContain("layout.sidebar.balancePlaceholder");
    expect(markup).not.toContain("0 layout.sidebar.balanceUnit");
  });

  it("keeps the rewards page route without rendering a main navigation tab", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/rewards",
      {
        viewer: {
          cloudConnected: true,
          activeModelId: "link/gemini",
          activeModelProviderId: "link",
          usingManagedModel: true,
        },
        progress: {
          claimedCount: 4,
          totalCount: 10,
          earnedCredits: 700,
        },
        cloudBalance: {
          totalBalance: 200,
          totalRecharged: 900,
          totalConsumed: 700,
        },
      },
      {
        connected: true,
      },
    );

    expect(markup).not.toContain("layout.nav.rewards");
    expect(markup).toContain("Rewards body");
    expect(markup).toContain("layout.sidebar.balanceLabel");
  });

  it("renders the logged-out sidebar growth card", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/sessions/sess-1",
      {
        viewer: {
          cloudConnected: false,
          activeModelId: null,
          activeModelProviderId: null,
          usingManagedModel: false,
        },
        progress: {
          claimedCount: 0,
          totalCount: 11,
          earnedCredits: 0,
        },
        cloudBalance: null,
      },
      {
        connected: false,
      },
    );

    expect(markup).toContain("layout.sidebar.loginTitle");
    expect(markup).toContain("layout.sidebar.loginSubtitle");
    expect(markup).toContain('data-sidebar-growth-card="login"');
    expect(markup).not.toContain('data-sidebar-rewards-balance="true"');
  });

  it("renders a loading shell instead of a fake zero-state card before rewards resolve", () => {
    const markup = renderWorkspaceLayout();

    expect(markup).toContain('data-rewards-card-loading="true"');
    expect(markup).not.toContain("layout.sidebar.loginTitle");
    expect(markup).not.toContain("layout.sidebar.balanceLabel");
  });

  it("renders the connected rewards shell immediately while balance data is still syncing", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/sessions/sess-1",
      undefined,
      {
        connected: true,
      },
    );

    expect(markup).not.toContain('data-rewards-card-loading="true"');
    expect(markup).toContain('data-sidebar-rewards-balance="true"');
    expect(markup).toContain("layout.sidebar.balanceLabel");
    expect(markup).toContain("layout.sidebar.balancePlaceholder");
    expect(markup).not.toContain("$0.00");
  });

  it("renders a global warning banner on non-remediation pages", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/sessions/sess-1",
      {
        viewer: {
          cloudConnected: true,
          activeModelId: "link/gemini",
          activeModelProviderId: "link",
          usingManagedModel: true,
        },
        progress: {
          claimedCount: 6,
          totalCount: 11,
          earnedCredits: 1200,
        },
        cloudBalance: {
          totalBalance: 5,
          totalRecharged: 1205,
          totalConsumed: 1200,
        },
      },
      {
        connected: true,
      },
    );

    expect(markup).toContain('data-budget-banner-status="warning"');
  });

  it("does not render the global budget banner on rewards pages", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/rewards",
      {
        viewer: {
          cloudConnected: true,
          activeModelId: "link/gemini",
          activeModelProviderId: "link",
          usingManagedModel: true,
        },
        progress: {
          claimedCount: 6,
          totalCount: 11,
          earnedCredits: 1200,
        },
        cloudBalance: {
          totalBalance: 0,
          totalRecharged: 1200,
          totalConsumed: 1200,
        },
      },
      {
        connected: true,
      },
    );

    expect(markup).not.toContain('data-budget-banner-status="depleted"');
  });

  it("does not render the global budget banner at the top of the home page", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/home",
      {
        viewer: {
          cloudConnected: true,
          activeModelId: "link/gemini",
          activeModelProviderId: "link",
          usingManagedModel: true,
        },
        progress: {
          claimedCount: 6,
          totalCount: 11,
          earnedCredits: 1200,
        },
        cloudBalance: {
          totalBalance: 5,
          totalRecharged: 1205,
          totalConsumed: 1200,
        },
      },
      {
        connected: true,
      },
    );

    expect(markup).not.toContain('data-budget-banner-status="warning"');
  });

  it("does not render the global budget banner at the top of the default workspace route", () => {
    const markup = renderWorkspaceLayout(
      "/workspace",
      {
        viewer: {
          cloudConnected: true,
          activeModelId: "link/gemini",
          activeModelProviderId: "link",
          usingManagedModel: true,
        },
        progress: {
          claimedCount: 6,
          totalCount: 11,
          earnedCredits: 1200,
        },
        cloudBalance: {
          totalBalance: 5,
          totalRecharged: 1205,
          totalConsumed: 1200,
        },
      },
      {
        connected: true,
      },
    );

    expect(markup).not.toContain('data-budget-banner-status="warning"');
  });

  it("renders the logged-in rewards card with a separate balance entry", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/sessions/sess-1",
      {
        viewer: {
          cloudConnected: true,
          activeModelId: "link/gemini",
          activeModelProviderId: "link",
          usingManagedModel: true,
        },
        progress: {
          claimedCount: 4,
          totalCount: 10,
          earnedCredits: 700,
        },
        cloudBalance: {
          totalBalance: 200,
          totalRecharged: 900,
          totalConsumed: 700,
        },
      },
      {
        connected: true,
      },
    );

    expect(markup).not.toContain("4/10");
    expect(markup).toContain('data-sidebar-rewards-balance="true"');
    expect(markup).toContain("layout.sidebar.balanceLabel");
    // 200 cents rendered as exact USD.
    expect(markup).toContain("$2.00");
    expect(markup).not.toContain("layout.sidebar.loginTitle");
  });

  it("uses the test cloud profile to keep the rewards shell visible", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/sessions/sess-1",
      {
        viewer: {
          cloudConnected: true,
          activeModelId: "link/gemini",
          activeModelProviderId: "link",
          usingManagedModel: true,
        },
        progress: {
          claimedCount: 4,
          totalCount: 10,
          earnedCredits: 700,
        },
        cloudBalance: {
          totalBalance: 200,
          totalRecharged: 900,
          totalConsumed: 700,
        },
      },
      {
        connected: true,
        cloudUrl: "https://nexu.powerformer.net",
      },
    );

    expect(markup).toContain('data-sidebar-rewards-balance="true"');
    expect(markup).toContain("layout.sidebar.balanceLabel");
  });

  it("renders zero balance when connected but cloud balance is null", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/sessions/sess-1",
      {
        viewer: {
          cloudConnected: true,
          activeModelId: "link/gemini",
          activeModelProviderId: "link",
          usingManagedModel: true,
        },
        progress: {
          claimedCount: 1,
          totalCount: 10,
          earnedCredits: 100,
        },
        cloudBalance: null,
      },
      {
        connected: true,
      },
    );

    expect(markup).toContain("$0.00");
  });

  it("derives the popup breakdown from current gifted and plan balances", () => {
    expect(
      getSidebarCreditBreakdown({
        progress: {
          claimedCount: 0,
          totalCount: 0,
          earnedCredits: 999,
        },
        cloudBalance: {
          totalBalance: 300,
          totalRecharged: 300,
          totalConsumed: 0,
          giftedBalance: 300,
          planBalance: 0,
        },
      }),
    ).toEqual({
      totalBalance: 300,
      giftedBalance: 300,
      planBalance: 0,
    });
  });

  it("falls back to plan-only popup breakdown when gifted balance is missing", () => {
    expect(
      getSidebarCreditBreakdown({
        progress: {
          claimedCount: 0,
          totalCount: 0,
          earnedCredits: 300,
        },
        cloudBalance: {
          totalBalance: 300,
          totalRecharged: 300,
          totalConsumed: 0,
        },
      }),
    ).toEqual({
      totalBalance: 300,
      giftedBalance: 0,
      planBalance: 300,
    });
  });

  it("prefers desktop cloud status over stale rewards state when the user has logged out", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/sessions/sess-1",
      {
        viewer: {
          cloudConnected: true,
          activeModelId: "link/gemini",
          activeModelProviderId: "link",
          usingManagedModel: true,
        },
        progress: {
          claimedCount: 4,
          totalCount: 10,
          earnedCredits: 700,
        },
        cloudBalance: {
          totalBalance: 200,
          totalRecharged: 900,
          totalConsumed: 700,
        },
      },
      {
        connected: false,
      },
    );

    expect(markup).toContain("layout.sidebar.loginTitle");
    expect(markup).not.toContain('data-sidebar-rewards-balance="true"');
  });

  it("prefers desktop cloud status over stale rewards state when the user has logged in", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/sessions/sess-1",
      {
        viewer: {
          cloudConnected: false,
          activeModelId: null,
          activeModelProviderId: null,
          usingManagedModel: false,
        },
        progress: {
          claimedCount: 0,
          totalCount: 11,
          earnedCredits: 0,
        },
        cloudBalance: null,
      },
      {
        connected: true,
      },
    );

    expect(markup).toContain('data-sidebar-rewards-balance="true"');
    expect(markup).not.toContain("layout.sidebar.loginTitle");
  });

  it("does not render the removed rewards task counter in the sidebar card", () => {
    const markup = renderWorkspaceLayout(
      "/workspace/sessions/sess-1",
      {
        viewer: {
          cloudConnected: true,
          activeModelId: "link/gemini",
          activeModelProviderId: "link",
          usingManagedModel: true,
        },
        progress: {
          claimedCount: 0,
          totalCount: 12,
          earnedCredits: 0,
        },
        cloudBalance: {
          totalBalance: 200,
          totalRecharged: 900,
          totalConsumed: 700,
        },
      },
      {
        connected: true,
      },
    );

    expect(markup).toContain('data-sidebar-rewards-balance="true"');
    expect(markup).toContain("layout.sidebar.balanceLabel");
    expect(markup).not.toContain("0/12");
  });

  it("renders WhatsApp sessions with the correct sidebar icon and label", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(
      ["sidebar-sessions"],
      [
        {
          id: "sess-wa",
          title: "Alice",
          channelType: "whatsapp",
          lastTime: "2026-03-20T08:57:00.000Z",
          status: "active",
          sessionKey: "agent:bot-1:whatsapp:dm:12345",
        },
      ],
    );
    queryClient.setQueryData(["me"], {
      email: "alice@example.com",
      name: "Alice",
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/sessions/sess-wa"]}>
          <Routes>
            <Route element={<WorkspaceLayout />}>
              <Route
                path="/workspace/sessions/:id"
                element={<div>Session body</div>}
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-session-channel-type="whatsapp"');
    expect(markup).toContain("<title>WhatsApp</title>");
    expect(markup).toContain("WhatsApp");
  });

  it("opens on ordinary conversations, with no separate scheduled group", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(
      ["sidebar-sessions"],
      [
        {
          id: "sess-chat",
          title: "Design sync thread",
          channelType: "web",
          lastTime: "2026-03-20T08:57:00.000Z",
          status: "active",
          sessionKey: "agent:bot-1:12345678-1234-1234-1234-123456789abc",
        },
        {
          id: "sess-automation",
          title: "Automation: skill-collection-review-bot-1",
          channelType: "web",
          lastTime: "2026-03-20T08:58:00.000Z",
          status: "active",
          sessionKey: "agent:bot-1:cron:job-1",
        },
      ],
    );
    queryClient.setQueryData(["me"], {
      email: "alice@example.com",
      name: "Alice",
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/sessions/sess-chat"]}>
          <Routes>
            <Route element={<WorkspaceLayout />}>
              <Route
                path="/workspace/sessions/:id"
                element={<div>Session body</div>}
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Scheduled sessions are reached through the 定时对话 / 全部 filters, not a
    // collapsible group; the rail opens on ordinary conversations so a burst
    // of automation runs cannot bury the user's own threads (2026-10-09).
    expect(markup).not.toContain("layout.scheduledTasks");
    expect(markup).toMatch(
      /data-sidebar-session-row="sess-chat"[^>]*data-session-scheduled="false"/,
    );
    expect(markup).not.toContain('data-sidebar-session-row="sess-automation"');
  });
});
