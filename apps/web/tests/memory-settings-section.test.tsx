// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySettingsSection } from "../src/pages/memory-settings-section";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getStatus: vi.fn(),
  patchSettings: vi.fn(),
  rebuild: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1MemorySettings: (...args: unknown[]) => apiMocks.getSettings(...args),
  getApiV1MemoryStatus: (...args: unknown[]) => apiMocks.getStatus(...args),
  patchApiV1MemorySettings: (...args: unknown[]) =>
    apiMocks.patchSettings(...args),
  postApiV1MemoryRebuild: (...args: unknown[]) => apiMocks.rebuild(...args),
}));

vi.mock("sonner", () => ({ toast: toastMocks }));

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemorySettingsSection />
    </QueryClientProvider>,
  );
}

describe("MemorySettingsSection", () => {
  beforeEach(() => {
    apiMocks.getSettings.mockReset();
    apiMocks.getStatus.mockReset();
    apiMocks.patchSettings.mockReset();
    apiMocks.rebuild.mockReset();
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    apiMocks.getSettings.mockResolvedValue({
      data: {
        memory: {
          enabled: true,
          sources: ["memory"],
          extraPaths: ["docs"],
          syncIntervalMinutes: 5,
        },
      },
    });
    apiMocks.getStatus.mockResolvedValue({
      data: {
        connected: true,
        available: true,
        enabled: true,
        indexedItems: 42,
        lastSyncAtMs: 1_754_275_600_000,
        status: "ready",
      },
    });
    apiMocks.patchSettings.mockImplementation(
      async (options: { body: Record<string, unknown> }) => ({
        data: {
          memory: {
            enabled: true,
            sources: ["memory"],
            extraPaths: ["docs"],
            syncIntervalMinutes: 5,
            ...options.body,
          },
        },
      }),
    );
    apiMocks.rebuild.mockResolvedValue({
      data: { ok: true, rebuiltAt: "2026-08-04T00:00:00.000Z" },
    });
  });

  afterEach(() => cleanup());

  it("shows live index status and enables cross-session recall", async () => {
    renderSection();

    expect(await screen.findByText("42")).toBeTruthy();
    const switches = screen.getAllByRole("switch");
    const crossSessionSwitch = switches[1];
    if (!crossSessionSwitch) throw new Error("cross-session switch missing");
    fireEvent.click(crossSessionSwitch);

    await waitFor(() =>
      expect(apiMocks.patchSettings).toHaveBeenCalledWith({
        body: { sources: ["memory", "sessions"] },
      }),
    );
  });

  it("rebuilds the index from the settings surface", async () => {
    renderSection();
    fireEvent.click(
      await screen.findByRole("button", { name: "memory.rebuild" }),
    );

    await waitFor(() =>
      expect(apiMocks.rebuild).toHaveBeenCalledWith({ body: {} }),
    );
    expect(toastMocks.success).toHaveBeenCalledWith("memory.rebuilt");
  });

  it("saves index paths and score while synchronization is automatic", async () => {
    renderSection();

    expect(await screen.findByText("memory.autoSyncHint")).toBeTruthy();
    expect(screen.queryByLabelText("memory.syncInterval")).toBeNull();
    fireEvent.change(screen.getByLabelText("memory.scope"), {
      target: { value: "docs\nnotes" },
    });
    fireEvent.change(screen.getByLabelText("memory.minScore"), {
      target: { value: "0.3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "memory.saveScope" }));

    await waitFor(() =>
      expect(apiMocks.patchSettings).toHaveBeenCalledWith({
        body: { extraPaths: ["docs", "notes"], minScore: 0.3 },
      }),
    );
  });

  it("shows when the memory index needs synchronization", async () => {
    apiMocks.getStatus.mockResolvedValue({
      data: {
        connected: true,
        available: true,
        enabled: true,
        indexedItems: 42,
        status: "sync-needed",
      },
    });

    renderSection();

    expect(await screen.findByText("memory.statusSyncNeeded")).toBeTruthy();
    expect(screen.queryByText("memory.statusReady")).toBeNull();
  });

  it("shows FTS-only memory as a ready local index", async () => {
    apiMocks.getStatus.mockResolvedValue({
      data: {
        connected: true,
        available: true,
        enabled: true,
        indexedItems: 6,
        mode: "fts-only",
        status: "ready",
      },
    });

    renderSection();

    expect(await screen.findByText("memory.statusFtsReady")).toBeTruthy();
    expect(screen.queryByText("memory.statusUnavailable")).toBeNull();
  });

  it("shows an actionable embedding authentication failure", async () => {
    apiMocks.getStatus.mockResolvedValue({
      data: {
        connected: true,
        available: false,
        enabled: true,
        reasonCode: "embedding-auth-missing",
        status: "unavailable",
      },
    });

    renderSection();

    expect(
      await screen.findByText("memory.reasonEmbeddingAuthMissing"),
    ).toBeTruthy();
  });
});
