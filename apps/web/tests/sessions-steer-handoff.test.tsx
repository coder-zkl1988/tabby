// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPinnedPanelState,
  pinSurface,
  resetPinnedPanelForTests,
  setActivePinnedSession,
} from "../src/lib/a2ui/a2ui-pinned-panel-store";
import { A2UISidebarProvider } from "../src/lib/a2ui/a2ui-sidebar-context";
import {
  getBrowserPanelState,
  openBrowserPanel,
  resetBrowserPanelForTests,
} from "../src/lib/browser/browser-panel-store";
import {
  __resetCanvasForTests,
  setPanelOpen,
} from "../src/lib/canvas/canvas-store";
import { SessionsPage } from "../src/pages/sessions";

// jsdom doesn't implement layout, so Element.scrollIntoView is absent.
Element.prototype.scrollIntoView = vi.fn();

// This reproduces the exact regression reported in review on PR #13
// (coder-zkl1988/tabby): OpenClaw's sessions.steer synchronously aborts the
// old run and broadcasts its `aborted` BEFORE the replacement run's id is
// known. Before the fix, that expected abort was indistinguishable from a
// real failure: it cleared `waitingForReply`, told the desktop pet "error",
// and — because the pending-reply flag was already cleared — the
// replacement run's later `final` was silently dropped instead of reporting
// success. See apps/web/src/lib/chat/steer-run-handoff.ts.

vi.mock("@/lib/tracking", () => ({
  track: vi.fn(),
  normalizeChannel: (channel: unknown) => channel,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        "sessions.chat.runMessagePlaceholder":
          "Continue typing to guide the task or ask about progress",
        "sessions.chat.sendRunMessage": "Send",
        "sessions.chat.stopCurrentTask": "Stop current task",
        "sessions.chat.runToolsUnavailable":
          "Available after the current task finishes",
      };
      if (key in labels) return labels[key];
      if (values?.count != null) return `${String(values.count)} ${key}`;
      return key;
    },
  }),
}));

const invokeDesktopHost = vi.fn();
vi.mock("@/lib/desktop-host", () => ({
  invokeDesktopHost: (...args: unknown[]) => invokeDesktopHost(...args),
}));

type CapturedStreamHandlers = {
  onDelta?: (delta: {
    runId: string;
    seq: number;
    deltaText: string;
    replace: boolean;
  }) => void;
  onFinal?: (final: {
    runId: string;
    seq: number;
    message: unknown;
    stopReason: string;
  }) => void;
  onAborted?: (aborted: { runId: string; seq: number }) => void;
  onError?: (error: {
    runId: string;
    seq: number;
    errorMessage: string;
    errorKind: string;
  }) => void;
  onSideResult?: (result: unknown) => void;
  onConnected?: () => void;
};

let capturedStreamHandlers: CapturedStreamHandlers | null = null;
vi.mock("@/lib/api/event-source", () => ({
  createLocalStreamSSEClient: (opts: CapturedStreamHandlers) => {
    capturedStreamHandlers = opts;
    return { connect: vi.fn(), disconnect: vi.fn() };
  },
}));

const postApiV1ChatLocal = vi.fn();
const postApiV1ChatSteer = vi.fn();
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: toastInfo,
    success: vi.fn(),
  },
}));

vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1SessionsById: vi.fn(async () => ({
    data: {
      id: "sess-steer",
      botId: "bot-1",
      sessionKey: "agent:bot-1:main",
      title: "Steer handoff test",
      channelType: "web",
      messageCount: 1,
      lastMessageAt: "2026-07-28T00:00:00.000Z",
      metadata: {},
    },
  })),
  getApiV1SessionsByIdMessages: vi.fn(async () => ({
    data: {
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "keep working on the quarterly report",
          timestamp: Date.parse("2026-07-28T00:00:00.000Z"),
          createdAt: "2026-07-28T00:00:00.000Z",
        },
      ],
    },
  })),
  getApiV1Channels: vi.fn(async () => ({ data: { channels: [] } })),
  getApiV1Bots: vi.fn(async () => ({ data: { bots: [] } })),
  getApiV1BotsByBotId: vi.fn(async () => ({
    data: {
      id: "bot-1",
      name: "Report bot",
      slug: "report-bot",
      status: "active",
      modelId: "openai/gpt-5.6",
    },
  })),
  getApiV1ChatRunStatus: vi.fn(async () => ({ data: { busy: false } })),
  getApiV1Artifacts: vi.fn(async () => ({ data: { artifacts: [] } })),
  getApiInternalDesktopReady: vi.fn(async () => ({
    data: {
      ready: true,
      degraded: false,
      status: "active",
      controlPlane: { phase: "ready", wsConnected: true },
    },
  })),
  getApiV1Teams: vi.fn(async () => ({ data: { teams: [] } })),
  getApiV1TeamsByIdWorkflowApprovals: vi.fn(async () => ({
    data: { approvals: [] },
  })),
  postApiV1TeamsByIdWorkflowsByWorkflowIdRunsByRunIdStepsByStepIdApprove: vi.fn(
    async () => ({ data: { ok: true } }),
  ),
  postApiV1ChatLocal: (...args: unknown[]) => postApiV1ChatLocal(...args),
  postApiV1ChatSteer: (...args: unknown[]) => postApiV1ChatSteer(...args),
  postApiV1ChatCancel: vi.fn(async () => ({ data: undefined })),
  postApiV1ChatIntent: vi.fn(async () => ({ data: undefined })),
  postApiV1ChatSideQuestion: vi.fn(async () => ({ data: undefined })),
  postApiV1SessionsByIdReset: vi.fn(async () => ({ data: undefined })),
  postApiV1TtsSpeak: vi.fn(async () => ({ data: undefined })),
}));

function renderSession() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });

  queryClient.setQueryData(["session-meta", "sess-steer"], {
    id: "sess-steer",
    botId: "bot-1",
    sessionKey: "agent:bot-1:main",
    title: "Steer handoff test",
    channelType: "web",
    messageCount: 1,
    lastMessageAt: "2026-07-28T00:00:00.000Z",
    metadata: {},
  });
  queryClient.setQueryData(["chat-history", "sess-steer"], {
    messages: [
      {
        id: "msg-1",
        role: "user",
        content: "keep working on the quarterly report",
        timestamp: Date.parse("2026-07-28T00:00:00.000Z"),
        createdAt: "2026-07-28T00:00:00.000Z",
      },
    ],
  });
  queryClient.setQueryData(["bot", "bot-1"], {
    id: "bot-1",
    name: "Report bot",
    slug: "report-bot",
    status: "active",
    modelId: "openai/gpt-5.6",
  });
  queryClient.setQueryData(["bots"], { bots: [] });

  return render(
    <QueryClientProvider client={queryClient}>
      <A2UISidebarProvider>
        <MemoryRouter initialEntries={["/workspace/sessions/sess-steer"]}>
          <Routes>
            <Route path="/workspace/sessions/:id" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </A2UISidebarProvider>
    </QueryClientProvider>,
  );
}

function moodsInvoked(): string[] {
  return invokeDesktopHost.mock.calls
    .map(([, payload]) => (payload as { mood?: string })?.mood)
    .filter((mood): mood is string => Boolean(mood));
}

describe("SessionsPage steer handoff (integration)", () => {
  beforeEach(() => {
    capturedStreamHandlers = null;
    invokeDesktopHost.mockReset();
    postApiV1ChatLocal.mockReset();
    postApiV1ChatSteer.mockReset();
    toastInfo.mockReset();
    resetBrowserPanelForTests();
    resetPinnedPanelForTests();
    __resetCanvasForTests();
  });

  afterEach(() => {
    cleanup();
  });

  it("survives old-run-aborted -> replacement-accepted -> replacement-final without dropping waitingForReply or signaling desktop-pet error, and still reports success", async () => {
    postApiV1ChatLocal.mockResolvedValue({
      data: { message: { id: "msg-2", runId: "old-run" } },
    });
    let resolveSteer!: (value: {
      data: { accepted: boolean; runId: string };
    }) => void;
    postApiV1ChatSteer.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSteer = resolve;
        }),
    );

    renderSession();

    const textarea = await screen.findByRole("textbox");

    // 1) Start the original long-running task from this session, exactly
    //    like a normal chat send — this is what puts waitingForReply and
    //    deskpetReplyPendingRef into the "a reply is pending" state that the
    //    reported bug corrupted.
    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: "please write the quarterly report" },
      });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(postApiV1ChatLocal).toHaveBeenCalledTimes(1);
    expect(capturedStreamHandlers?.onAborted).toBeTypeOf("function");
    expect(
      screen.getByPlaceholderText(
        "Continue typing to guide the task or ask about progress",
      ),
    ).toBeTruthy();

    // 2) Steer the active run. The HTTP request is left pending on purpose —
    //    OpenClaw's sessions.steer aborts the old run synchronously and
    //    broadcasts it before the replacement run id is returned to us.
    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: "/steer focus on Q3 numbers only" },
      });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(postApiV1ChatSteer).toHaveBeenCalledTimes(1);

    // 3) The old run's expected `aborted` races ahead of the steer response.
    await act(async () => {
      capturedStreamHandlers?.onAborted?.({ runId: "old-run", seq: 1 });
    });

    // The false-alarm abort must never be reported as a desktop-pet error,
    // and the composer must still show it's waiting on a reply.
    expect(moodsInvoked()).not.toContain("error");
    expect(
      screen.getByPlaceholderText(
        "Continue typing to guide the task or ask about progress",
      ),
    ).toBeTruthy();

    // 4) The steer HTTP response now resolves, handing activeRunIdRef over
    //    to the replacement run.
    await act(async () => {
      resolveSteer({ data: { accepted: true, runId: "replacement-run" } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(moodsInvoked()).not.toContain("error");

    // 5) The replacement run finishes for real.
    await act(async () => {
      capturedStreamHandlers?.onFinal?.({
        runId: "replacement-run",
        seq: 2,
        message: { role: "assistant", content: "Q3 numbers only, done." },
        stopReason: "stop",
      });
    });

    // The user must see success, not the silently-dropped final the bug
    // caused: no error mood was ever reported, and the desktop pet did
    // receive the "success" signal for the replacement run.
    expect(moodsInvoked()).not.toContain("error");
    expect(moodsInvoked()).toContain("success");

    // waitingForReply must be cleared now that the *replacement* run's real
    // final arrived — the composer returns to its normal (non-run-message)
    // state instead of staying stuck "waiting" forever.
    expect(
      screen.queryByPlaceholderText(
        "Continue typing to guide the task or ask about progress",
      ),
    ).toBeNull();
  });

  it("does not let Run center replace a browser owned by the active agent", async () => {
    openBrowserPanel("agent:bot-1:main", true);
    const { container } = renderSession();

    const toggle = await screen.findByRole("button", {
      name: "sessions.operations.title",
    });
    fireEvent.click(toggle);

    expect(getBrowserPanelState()).toMatchObject({
      isOpen: true,
      openedByAgent: true,
      sessionKey: "agent:bot-1:main",
    });
    expect(
      container.querySelector('[data-session-operations="true"]'),
    ).toBeNull();
    expect(toastInfo).toHaveBeenCalledWith("sessions.operations.browserBusy");
  });

  it("hands the workbench between Run center and Browser without overlap", async () => {
    openBrowserPanel("agent:bot-1:main");
    const { container } = renderSession();

    const toggle = await screen.findByRole("button", {
      name: "sessions.operations.title",
    });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(
        container.querySelector('[data-session-operations="true"]'),
      ).not.toBeNull(),
    );
    expect(getBrowserPanelState().isOpen).toBe(false);

    act(() => openBrowserPanel("agent:bot-1:main", true));

    await waitFor(() =>
      expect(
        container.querySelector('[data-session-operations="true"]'),
      ).toBeNull(),
    );
    expect(getBrowserPanelState()).toMatchObject({
      isOpen: true,
      openedByAgent: true,
    });
  });

  it("keeps every workbench toggle visible while Run center is open", async () => {
    const { container } = renderSession();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "sessions.operations.title",
      }),
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-session-operations="true"]'),
      ).not.toBeNull(),
    );

    const toolbar = container.querySelector(
      '[data-session-workbench-toggles="true"]',
    );
    expect(toolbar).not.toBeNull();
    expect(
      Array.from(
        toolbar?.querySelectorAll(
          "[data-session-browser-toggle], [data-session-canvas-toggle], [data-session-operations-toggle]",
        ) ?? [],
      ).map((button) =>
        button.hasAttribute("data-session-browser-toggle")
          ? "browser"
          : button.hasAttribute("data-session-canvas-toggle")
            ? "canvas"
            : "operations",
      ),
    ).toEqual(["browser", "canvas", "operations"]);
  });

  it("closes Run center when Canvas claims the shared workbench", async () => {
    const { container } = renderSession();

    const toggle = await screen.findByRole("button", {
      name: "sessions.operations.title",
    });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        container.querySelector('[data-session-operations="true"]'),
      ).not.toBeNull(),
    );

    act(() => setPanelOpen(true));

    await waitFor(() =>
      expect(
        container.querySelector('[data-session-operations="true"]'),
      ).toBeNull(),
    );
  });

  it("reopens a collapsed pinned panel from the header after Canvas closes", async () => {
    pinSurface("sess-steer", {
      surfaceId: "planner",
      title: "Planner",
      messages: [],
      onAction: vi.fn(),
      pinKey: null,
    });
    setActivePinnedSession("sess-steer");

    const { container } = renderSession();
    const canvasToggle = await screen.findByRole("button", {
      name: "sessions.chat.canvas",
    });
    const pinnedToggle = await screen.findByRole("button", {
      name: "sessions.chat.pinnedPanelTitle",
    });

    expect(pinnedToggle.getAttribute("aria-pressed")).toBe("true");

    // Canvas takes ownership of the shared workbench and collapses the pin.
    fireEvent.click(canvasToggle);
    await waitFor(() => expect(getPinnedPanelState().isOpen).toBe(false));
    expect(canvasToggle.getAttribute("aria-pressed")).toBe("true");

    // This models the canvas panel's header X. The pin remains in the session
    // store and its header icon stays available for a later reopen.
    act(() => setPanelOpen(false));
    await waitFor(() =>
      expect(canvasToggle.getAttribute("aria-pressed")).toBe("false"),
    );
    expect(pinnedToggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(pinnedToggle);
    await waitFor(() => expect(getPinnedPanelState().isOpen).toBe(true));
    expect(pinnedToggle.getAttribute("aria-pressed")).toBe("true");

    // A browser opened by another surface must not make the pin look selected;
    // clicking the icon still hands the shared workbench back to pins.
    act(() => openBrowserPanel("agent:bot-1:main"));
    await waitFor(() =>
      expect(pinnedToggle.getAttribute("aria-pressed")).toBe("false"),
    );
    fireEvent.click(pinnedToggle);
    await waitFor(() => {
      expect(getBrowserPanelState().isOpen).toBe(false);
      expect(getPinnedPanelState().isOpen).toBe(true);
    });
    expect(pinnedToggle.getAttribute("aria-pressed")).toBe("true");
    expect(
      container.querySelector('[data-session-pinned-toggle="true"]'),
    ).not.toBeNull();
  });
});
