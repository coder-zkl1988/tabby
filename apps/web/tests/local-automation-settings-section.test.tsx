import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocalAutomationSettingsSection } from "../src/pages/local-automation-settings-section";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1RuntimeConfig: vi.fn(),
  patchApiV1RuntimeConfigDeviceControl: vi.fn(),
  patchApiV1RuntimeConfigLocalAutomation: vi.fn(),
  postApiV1RuntimeConfigLocalAutomationBrowserPairing: vi.fn(),
  postApiV1RuntimeConfigLocalAutomationComputerUseAccessibilityPermission:
    vi.fn(),
  postApiV1RuntimeConfigLocalAutomationComputerUseEventSynthesizingPermission:
    vi.fn(),
  postApiV1RuntimeConfigLocalAutomationComputerUseScreenRecordingPermission:
    vi.fn(),
}));

describe("LocalAutomationSettingsSection", () => {
  it("renders a retryable error instead of a permanent loading state", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          retryOnMount: false,
        },
      },
    });

    await expect(
      queryClient.fetchQuery({
        queryKey: ["runtime-config"],
        queryFn: async () => {
          throw new Error("request failed");
        },
      }),
    ).rejects.toThrow("request failed");

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <LocalAutomationSettingsSection />
      </QueryClientProvider>,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("automation.loadFailed");
    expect(markup).toContain("automation.retry");
    expect(markup).not.toContain("automation.loading");
  });

  it("keeps stale enabled settings visible and switchable off outside Preview", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["runtime-config"], {
      deviceControl: { enabled: true },
      localAutomation: {
        browser: { enabled: true },
        computerUse: { enabled: true },
      },
      localAutomationStatus: {
        previewEnabled: false,
        computerUseAvailable: true,
        computerUseUnavailableReason: null,
        computerUseBinaryPath: "/tmp/peekaboo",
        computerUseBackend: "peekaboo",
        computerUsePermissionState: "disabled",
        computerUsePermissions: [],
      },
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <LocalAutomationSettingsSection />
      </QueryClientProvider>,
    );

    const switchTags = markup.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];
    expect(markup).toContain("automation.title");
    expect(markup).toContain("devices.settings.title");
    expect(markup).toContain("automation.browser.title");
    expect(markup).toContain("automation.computer.title");
    // The browser row now explains what turning it on lets the assistant do;
    // a bare switch labelled "Browser control" told the user nothing about
    // what they were authorising. The rest of this block is the reason the
    // description was withheld in the first place: whatever it says, the
    // settings page must not name the machinery behind it.
    expect(markup).toContain("automation.browser.description");
    expect(markup).not.toContain("automation.computer.description");
    expect(markup).not.toContain("WebSocket");
    expect(markup).not.toContain("Peekaboo");
    expect(markup).not.toContain("CUA");
    expect(markup).not.toContain("sidecar");
    expect(markup).not.toContain("socket");
    expect(switchTags).toHaveLength(3);
    for (const tag of switchTags) {
      expect(tag).toContain('aria-checked="true"');
      expect(tag).not.toContain(' disabled=""');
    }
  });

  it("does not allow disabled settings to be enabled outside Preview", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["runtime-config"], {
      deviceControl: { enabled: false },
      localAutomation: {
        browser: { enabled: false },
        computerUse: { enabled: false },
      },
      localAutomationStatus: {
        previewEnabled: false,
        computerUseAvailable: true,
        computerUseUnavailableReason: null,
        computerUseBinaryPath: "/tmp/peekaboo",
        computerUseBackend: "peekaboo",
        computerUsePermissionState: "disabled",
        computerUsePermissions: [],
      },
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <LocalAutomationSettingsSection />
      </QueryClientProvider>,
    );

    const switchTags = markup.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];
    expect(switchTags).toHaveLength(3);
    expect(switchTags[0]).toContain('aria-label="devices.settings.title"');
    expect(switchTags[0]).toContain('aria-checked="false"');
    expect(switchTags[0]).not.toContain(' disabled=""');
    expect(switchTags[1]).toContain('aria-label="automation.browser.title"');
    expect(switchTags[1]).toContain(' disabled=""');
    expect(switchTags[2]).toContain('aria-label="automation.computer.title"');
    expect(switchTags[2]).toContain(' disabled=""');
  });
});
