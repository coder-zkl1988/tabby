/**
 * @vitest-environment jsdom
 *
 * The pinned panel is scoped to one conversation, and the store already
 * enforces that: pointing it at another session — or at none — hides it while
 * keeping the pins for a return trip (a2ui-pinned-panel-store.test.ts).
 *
 * What drifted was the wiring. Only the sessions page pointed the store at a
 * session, from an effect keyed on the route param, so session-to-session
 * moves worked and leaving for 设备 or 首页 did not: the page unmounts without
 * the param ever changing, and the layout — which outlives the route — kept
 * rendering the panel (reported 2026-09-20).
 *
 * This renders the real layout and really navigates, because a store-level
 * test cannot see a caller that never calls.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceLayout } from "../src/layouts/workspace-layout";
import {
  getPinnedPanelState,
  pinSurface,
  resetPinnedPanelForTests,
  sessionHasPins,
  setActivePinnedSession,
} from "../src/lib/a2ui/a2ui-pinned-panel-store";

vi.mock("@/lib/api", () => ({}));
vi.mock("@/lib/tracking", () => ({ track: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
  useCommunitySkillStatus: () => ({ data: { installedSkills: [] } }),
}));
vi.mock("@/hooks/use-locale", () => ({
  useLocale: () => ({ locale: "en", setLocale: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { email: "alice@example.com", name: "Alice" } },
    }),
    signOut: vi.fn(),
  },
}));
vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1Sessions: vi.fn(async () => ({ data: { sessions: [] } })),
  deleteApiV1SessionsById: vi.fn(async () => ({ data: {} })),
  patchApiInternalSessionsById: vi.fn(async () => ({ data: {} })),
  getApiV1Me: vi.fn(async () => ({
    data: { email: "alice@example.com", name: "Alice" },
  })),
}));

function surface(surfaceId: string) {
  return {
    surfaceId,
    title: surfaceId,
    messages: [],
    onAction: vi.fn(),
    pinKey: null,
  };
}

function SessionBody() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/workspace/devices")}>
      leave for devices
    </button>
  );
}

function renderAtSession() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/workspace/sessions/sess-1"]}>
        <Routes>
          <Route element={<WorkspaceLayout />}>
            <Route path="/workspace/sessions/:id" element={<SessionBody />} />
            <Route path="/workspace/devices" element={<div>Devices</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("pinned panel route scope", () => {
  beforeEach(() => {
    resetPinnedPanelForTests();
    localStorage.clear();
    localStorage.setItem("nexu_setup_complete", "1");
  });

  afterEach(() => {
    resetPinnedPanelForTests();
  });

  it("hides the panel when leaving sessions for a top-level tab", () => {
    pinSurface("sess-1", surface("planner"));
    setActivePinnedSession("sess-1");
    expect(getPinnedPanelState().isOpen).toBe(true);

    renderAtSession();
    fireEvent.click(screen.getByText("leave for devices"));

    expect(getPinnedPanelState().isOpen).toBe(false);
    expect(getPinnedPanelState().surfaces).toHaveLength(0);
    // Hidden, not discarded: returning to the conversation restores the pins.
    expect(sessionHasPins("sess-1")).toBe(true);
  });
});
